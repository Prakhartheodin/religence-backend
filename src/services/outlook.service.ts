import * as msal from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';
import config from '../config.js';
import { HttpError } from '../http-error.js';
import {
  issueOutlookConnectToken,
  verifyOutlookConnectToken,
} from './auth.service.js';
import {
  findOutlookAccountById,
  findActiveOutlookAccountsByUser,
  setOutlookAccountStatus,
  updateOutlookAccount,
  upsertOutlookAccount,
} from './outlook-store.js';
import { OutlookSyncStateModel } from '../models/outlook-sync-state.model.js';
import {
  normalizeMailAttachments,
  type MailAttachmentInput,
} from './mail-attachments.js';
import type { EmailAccountPublic, EmailMessage, EmailThreadListItem, OutlookAccount } from '../types/email.js';
import { promoteDraftsAfterReconnect } from './mail-workflow/workflow.service.js';

const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'Mail.ReadWrite',
  'Mail.Send',
  'User.Read',
];

const REFRESH_TOKEN_SCOPE =
  'openid profile email offline_access Mail.ReadWrite Mail.Send User.Read';
const REFRESH_TOKEN_SCOPE_FALLBACK = 'offline_access Mail.ReadWrite Mail.Send User.Read';

const FOLDER_MAP: Record<string, string> = {
  INBOX: 'inbox',
  SENT: 'sentitems',
  TRASH: 'deleteditems',
  DRAFT: 'drafts',
  JUNK: 'junkemail',
  ARCHIVE: 'archive',
  OUTBOX: 'outbox',
  CONVERSATION_HISTORY: 'conversationhistory',
};

const ALL_SYNC_FOLDER_LABELS = Object.keys(FOLDER_MAP);

const IMMUTABLE_ID_PREFER = 'IdType="ImmutableId"';

const DELTA_MESSAGE_SELECT =
  'id,conversationId,subject,bodyPreview,from,toRecipients,receivedDateTime,sentDateTime,isRead,flag,importance,inferenceClassification,categories,isDraft';

function mailApi(client: Client, path: string, extraHeaders?: Record<string, string>) {
  let req = client.api(path).header('Prefer', IMMUTABLE_ID_PREFER);
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) req = req.header(k, v);
  return req;
}

function ensureOutlookConfigured(): void {
  if (!config.microsoft.clientId || !config.microsoft.clientSecret) {
    throw new HttpError(
      500,
      'Missing MICROSOFT_CLIENT_ID or MICROSOFT_CLIENT_SECRET in backend .env'
    );
  }
}

function createMsalApp(): msal.ConfidentialClientApplication {
  ensureOutlookConfigured();
  return new msal.ConfidentialClientApplication({
    auth: {
      clientId: config.microsoft.clientId,
      clientSecret: config.microsoft.clientSecret,
      authority: `https://login.microsoftonline.com/${config.microsoft.tenantId || 'common'}`,
    },
  });
}

function createGraphClient(accessToken: string): Client {
  const token = String(accessToken || '').trim();
  if (!token) {
    throw new HttpError(401, 'Outlook access token is missing; reconnect Outlook.');
  }
  return Client.init({
    authProvider: (done) => done(null, token),
  });
}

function buildState(userId: string): string {
  return issueOutlookConnectToken(userId);
}

function parseState(stateEncoded: string): { userId?: string } {
  if (!stateEncoded) return {};
  try {
    return { userId: verifyOutlookConnectToken(stateEncoded) };
  } catch {
    return {};
  }
}

function extractRefreshTokenFromMsalCache(msalApp: msal.ConfidentialClientApplication): string | null {
  try {
    const parsed = JSON.parse(msalApp.getTokenCache().serialize()) as {
      RefreshToken?: Record<string, { secret?: string }>;
    };
    const rtMap = parsed.RefreshToken || {};
    for (const key of Object.keys(rtMap)) {
      const secret = rtMap[key]?.secret;
      if (secret && typeof secret === 'string') return secret;
    }
  } catch {
    return null;
  }
  return null;
}

function isGraphUnauthorized(err: unknown): boolean {
  const raw = err as { statusCode?: number; status?: number | string; code?: string };
  return raw.statusCode === 401 || raw.status === 401 || raw.code === 'InvalidAuthenticationToken';
}

function isGraphNotFound(err: unknown): boolean {
  const raw = err as { statusCode?: number; status?: number | string; code?: string };
  return raw.statusCode === 404 || raw.status === 404 || raw.code === 'ErrorItemNotFound';
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripTags(value: string): string {
  if (!value) return '';
  return value
    .replace(/<[^>]*>?/gm, '')
    .replace(/&lt;[^&]*&gt;/gm, '')
    .replace(/&[a-z0-9#]+;/gi, ' ');
}

function htmlToPlainText(value: string): string {
  if (!value) return '';
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatAddress(address: { name?: string; address?: string } | undefined): string {
  if (!address) return '';
  const name = String(address.name || '').trim();
  const email = String(address.address || '').trim();
  if (name && email) return `${name} <${email}>`;
  return email || name;
}

function formatRecipients(
  recipients:
    | Array<{ emailAddress?: { name?: string; address?: string } }>
    | undefined
): string {
  return (recipients || [])
    .map((r) => formatAddress(r.emailAddress))
    .filter(Boolean)
    .join(', ');
}

function synthesizeLabelIds(message: {
  isRead?: boolean;
  flag?: { flagStatus?: string };
  importance?: string;
  inferenceClassification?: string;
}): string[] {
  const ids: string[] = [];
  if (message.isRead === false) ids.push('UNREAD');
  if (message.flag?.flagStatus === 'flagged') ids.push('STARRED');
  if (
    message.importance === 'high' ||
    message.inferenceClassification === 'focused'
  ) {
    ids.push('IMPORTANT');
  }
  return ids;
}

function normalizeFolderId(labelId: string | undefined): string | null {
  if (!labelId || labelId === 'ALL') return null;
  if (FOLDER_MAP[labelId]) return FOLDER_MAP[labelId];
  const lowered = labelId.toLowerCase();
  if (Object.values(FOLDER_MAP).includes(lowered)) return lowered;
  return labelId;
}

function formatThreadListItem(message: {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  flag?: { flagStatus?: string };
  importance?: string;
  inferenceClassification?: string;
  categories?: string[];
  isDraft?: boolean;
}): EmailThreadListItem {
  return {
    id: message.conversationId || message.id,
    threadId: message.conversationId || message.id,
    lastMessageId: message.id,
    firstMessageId: message.id,
    snippet: stripTags(message.bodyPreview || '').slice(0, 200),
    from: formatAddress(message.from?.emailAddress),
    to: formatRecipients(message.toRecipients),
    subject: message.subject || '(No subject)',
    date: message.receivedDateTime || message.sentDateTime || null,
    messageCount: 1,
    labelIds: synthesizeLabelIds(message),
    isUnread: !message.isRead,
    importance: message.importance,
    inferenceClassification: message.inferenceClassification,
    categories: message.categories,
    isDraft: message.isDraft,
  };
}

function formatMessage(message: {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  ccRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  flag?: { flagStatus?: string };
  importance?: string;
  inferenceClassification?: string;
  categories?: string[];
  isDraft?: boolean;
  attachments?: Array<{ id?: string; name?: string; contentType?: string; size?: number }>;
}): EmailMessage {
  const bodyType = String(message.body?.contentType || '').toLowerCase();
  const rawBody = String(message.body?.content || '');
  const htmlBody = bodyType === 'html' ? rawBody : null;
  let textBody = bodyType === 'text' ? rawBody : null;

  if (!htmlBody && !textBody && message.bodyPreview) {
    textBody = stripTags(message.bodyPreview);
  }
  if (!htmlBody && textBody && /<[a-z][\s\S]*>/i.test(textBody)) {
    textBody = htmlToPlainText(textBody);
  }

  return {
    id: message.id,
    threadId: message.conversationId || message.id,
    labelIds: synthesizeLabelIds(message),
    snippet: stripTags(message.bodyPreview || '').slice(0, 200),
    from: formatAddress(message.from?.emailAddress),
    to: formatRecipients(message.toRecipients),
    cc: formatRecipients(message.ccRecipients),
    subject: message.subject || '(No subject)',
    date: message.receivedDateTime || message.sentDateTime || null,
    isUnread: !message.isRead,
    importance: message.importance,
    inferenceClassification: message.inferenceClassification,
    categories: message.categories,
    isDraft: message.isDraft,
    htmlBody,
    textBody,
    attachments: (message.attachments || []).map((att) => ({
      filename: att.name || 'attachment',
      mimeType: att.contentType || 'application/octet-stream',
      size: att.size || 0,
      attachmentId: att.id,
      messageId: message.id,
    })),
  };
}

async function requireAccountForUser(
  userId: string,
  accountId: string
): Promise<OutlookAccount> {
  const account = await findOutlookAccountById(userId, accountId);
  if (!account) {
    throw new HttpError(404, 'Outlook account not found');
  }
  if (account.status === 'error') {
    throw new HttpError(401, 'Outlook credentials are no longer readable. Reconnect Outlook.');
  }
  if (account.status !== 'active') {
    throw new HttpError(404, 'Outlook account not found');
  }
  return account;
}

function accountIsStale(account: OutlookAccount): boolean {
  if (!account.tokenExpiry) return false;
  const expiry = new Date(account.tokenExpiry).getTime();
  if (Number.isNaN(expiry)) return true;
  return Date.now() >= expiry - 120000;
}

async function refreshAccessToken(account: OutlookAccount): Promise<OutlookAccount> {
  ensureOutlookConfigured();
  if (!account.refreshToken) {
    throw new HttpError(401, 'Outlook refresh token missing. Reconnect Outlook.');
  }

  const tokenUrl = `https://login.microsoftonline.com/${config.microsoft.tenantId || 'common'}/oauth2/v2.0/token`;

  const refreshOnce = async (scope: string): Promise<{ ok: boolean; payload: Record<string, unknown> }> => {
    const body = new URLSearchParams({
      client_id: config.microsoft.clientId,
      client_secret: config.microsoft.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken || '',
      scope,
    });
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const raw = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      payload = {};
    }
    return { ok: response.ok, payload };
  };

  let result = await refreshOnce(REFRESH_TOKEN_SCOPE);
  if (!result.ok && result.payload.error === 'invalid_scope') {
    result = await refreshOnce(REFRESH_TOKEN_SCOPE_FALLBACK);
  }

  if (!result.ok || typeof result.payload.access_token !== 'string') {
    // Only a dead grant warrants forcing a reconnect. A Microsoft 5xx or a
    // lost race against a concurrent refresh is retryable — the stored
    // refresh token is still good, so don't brick the account over it.
    const fatal = ['invalid_grant', 'interaction_required', 'unauthorized_client'].includes(
      String(result.payload.error)
    );
    if (fatal) {
      await updateOutlookAccount(account.userId, account.id, { status: 'error' });
    }
    throw new HttpError(
      fatal ? 401 : 503,
      typeof result.payload.error_description === 'string'
        ? result.payload.error_description
        : 'Outlook token refresh failed'
    );
  }

  const expiresIn =
    typeof result.payload.expires_in === 'number' ? result.payload.expires_in : 3600;
  const tokenExpiry = new Date(Date.now() + Math.max(60, expiresIn) * 1000).toISOString();
  const refreshed = await updateOutlookAccount(account.userId, account.id, {
    accessToken: result.payload.access_token as string,
    refreshToken:
      typeof result.payload.refresh_token === 'string'
        ? result.payload.refresh_token
        : account.refreshToken,
    tokenExpiry,
    status: 'active',
  });
  if (!refreshed) {
    throw new HttpError(404, 'Outlook account not found');
  }
  return refreshed;
}

async function ensureValidAccessToken(account: OutlookAccount): Promise<OutlookAccount> {
  if (!accountIsStale(account)) return account;
  return refreshAccessToken(account);
}

async function withGraphRetry<T>(
  account: OutlookAccount,
  work: (client: Client) => Promise<T>
): Promise<T> {
  let active = await ensureValidAccessToken(account);
  try {
    return await work(createGraphClient(active.accessToken));
  } catch (err) {
    if (isGraphUnauthorized(err) && active.refreshToken) {
      active = await refreshAccessToken(active);
      return work(createGraphClient(active.accessToken));
    }
    throw err;
  }
}

function asRecipientList(values: string | string[] | undefined): Array<{ emailAddress: { address: string } }> {
  if (!values) return [];
  const list = Array.isArray(values) ? values : [values];
  return list
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

function resolveMessagePath(messageId: string): string {
  return `/me/messages/${encodeURIComponent(messageId)}`;
}

async function listMessageIdsByConversationId(client: Client, conversationId: string): Promise<string[]> {
  const escaped = conversationId.replace(/'/g, "''");
  const res = (await mailApi(client, '/me/messages')
    .filter(`conversationId eq '${escaped}'`)
    .select('id,receivedDateTime')
    .top(50)
    .get()) as { value?: Array<{ id?: string; receivedDateTime?: string }> };

  const rows = [...(res.value || [])].sort((a, b) => {
    const ta = new Date(a.receivedDateTime || 0).getTime();
    const tb = new Date(b.receivedDateTime || 0).getTime();
    return ta - tb;
  });
  return rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

async function resolveMessageIdsForThread(client: Client, threadId: string): Promise<string[]> {
  try {
    const ids = await listMessageIdsByConversationId(client, threadId);
    if (ids.length > 0) return ids;
  } catch {
    // fallback to one message id path below
  }
  try {
    const one = (await mailApi(client, resolveMessagePath(threadId))
      .select('id')
      .get()) as { id?: string };
    if (one.id) return [one.id];
  } catch {
    return [];
  }
  return [];
}

async function getWellKnownFolderId(
  client: Client,
  wellKnownName: string
): Promise<string | null> {
  try {
    const folder = (await mailApi(client, `/me/mailFolders/${encodeURIComponent(wellKnownName)}`)
      .select('id')
      .get()) as { id?: string };
    return folder.id ?? null;
  } catch {
    return null;
  }
}

/** Only messages physically in the folder — Graph move is per-message, per-folder. */
async function resolveMessageIdsInFolder(
  client: Client,
  threadId: string,
  folderWellKnown: 'inbox' | 'archive' | 'deleteditems' | 'drafts' | 'outbox'
): Promise<string[]> {
  const folderId = await getWellKnownFolderId(client, folderWellKnown);
  const messageIds = await resolveMessageIdsForThread(client, threadId);
  if (!folderId || messageIds.length === 0) return messageIds;

  const inFolder: string[] = [];
  for (const messageId of messageIds) {
    try {
      const message = (await mailApi(client, resolveMessagePath(messageId))
        .select('parentFolderId')
        .get()) as { parentFolderId?: string };
      if (message.parentFolderId === folderId) {
        inFolder.push(messageId);
      }
    } catch (err) {
      if (!isGraphNotFound(err)) throw err;
    }
  }
  return inFolder;
}

export async function getMicrosoftAuthUrl(userId: string): Promise<string> {
  const msalApp = createMsalApp();
  return msalApp.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: config.microsoft.redirectUri,
    state: buildState(userId),
    prompt: 'select_account',
  });
}

export async function handleMicrosoftCallback(
  code: string,
  stateEncoded: string
): Promise<EmailAccountPublic> {
  const parsed = parseState(stateEncoded);
  if (!parsed.userId) {
    throw new HttpError(400, 'Invalid OAuth state: missing userId');
  }

  const msalApp = createMsalApp();
  const tokenResponse = await msalApp.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: config.microsoft.redirectUri,
  });

  if (!tokenResponse?.accessToken) {
    throw new HttpError(401, 'Microsoft OAuth failed: access token missing');
  }

  const client = createGraphClient(tokenResponse.accessToken);
  const me = (await client.api('/me').select('mail,userPrincipalName,displayName,givenName,surname').get()) as {
    mail?: string;
    userPrincipalName?: string;
    displayName?: string;
    givenName?: string;
    surname?: string;
  };
  const email = String(me.mail || me.userPrincipalName || '').trim().toLowerCase();
  if (!email) {
    throw new HttpError(400, 'Could not resolve mailbox email from Microsoft profile');
  }
  const displayName = resolveMicrosoftDisplayName(me);

  const refreshToken =
    (tokenResponse as unknown as { refreshToken?: string }).refreshToken ||
    extractRefreshTokenFromMsalCache(msalApp) ||
    null;
  const tokenExpiry = tokenResponse.expiresOn
    ? new Date(tokenResponse.expiresOn).toISOString()
    : new Date(Date.now() + 50 * 60 * 1000).toISOString();

  const account = await upsertOutlookAccount({
    userId: parsed.userId,
    email,
    displayName,
    accessToken: tokenResponse.accessToken,
    refreshToken,
    tokenExpiry,
  });

  void promoteDraftsAfterReconnect(parsed.userId).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[outlook] promoteDraftsAfterReconnect failed:', err);
  });

  return {
    id: account.id,
    provider: account.provider,
    email: account.email,
    displayName: account.displayName ?? null,
    status: account.status,
    createdAt: account.createdAt,
  };
}

function resolveMicrosoftDisplayName(me: {
  displayName?: string;
  givenName?: string;
  surname?: string;
}): string | null {
  const display = String(me.displayName || '').trim();
  if (display) return display;
  const full = [me.givenName, me.surname]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
  return full || null;
}

async function refreshAccountDisplayNameIfMissing(
  account: OutlookAccount
): Promise<OutlookAccount> {
  if (account.displayName?.trim()) return account;
  try {
    const valid = await ensureValidAccessToken(account);
    const client = createGraphClient(valid.accessToken);
    const me = (await client
      .api('/me')
      .select('displayName,givenName,surname')
      .get()) as {
      displayName?: string;
      givenName?: string;
      surname?: string;
    };
    const displayName = resolveMicrosoftDisplayName(me);
    if (!displayName) return account;
    return (await updateOutlookAccount(account.userId, account.id, { displayName })) ?? account;
  } catch {
    return account;
  }
}

export async function listOutlookAccounts(userId: string): Promise<EmailAccountPublic[]> {
  const accounts = await findActiveOutlookAccountsByUser(userId);
  const refreshed = await Promise.all(
    accounts.map((account) => refreshAccountDisplayNameIfMissing(account))
  );
  return refreshed.map((account) => ({
    id: account.id,
    provider: account.provider,
    email: account.email,
    displayName: account.displayName ?? null,
    status: account.status,
    createdAt: account.createdAt,
  }));
}

export async function disconnectOutlookAccount(userId: string, accountId: string): Promise<void> {
  const account = await requireAccountForUser(userId, accountId);
  await setOutlookAccountStatus(userId, account.id, 'revoked');
}

export async function listThreads(
  userId: string,
  accountId: string,
  opts: {
    labelId?: string;
    pageToken?: string;
    pageSize?: number;
    query?: string;
  }
): Promise<{ threads: EmailThreadListItem[]; nextPageToken: string | null; resultSizeEstimate: number }> {
  const account = await requireAccountForUser(userId, accountId);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 20, 1), 100);

  return withGraphRetry(account, async (client) => {
    let res:
      | {
          value?: Array<{
            id: string;
            conversationId?: string;
            subject?: string;
            bodyPreview?: string;
            from?: { emailAddress?: { name?: string; address?: string } };
            toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
            receivedDateTime?: string;
            sentDateTime?: string;
            isRead?: boolean;
            flag?: { flagStatus?: string };
          }>;
          '@odata.nextLink'?: string;
        }
      | undefined;

    if (opts.pageToken) {
      res = (await mailApi(client, opts.pageToken).get()) as typeof res;
    } else {
      const folderId = normalizeFolderId(opts.labelId);
      const endpoint = folderId
        ? `/me/mailFolders/${encodeURIComponent(folderId)}/messages`
        : '/me/messages';
      let request = mailApi(client, endpoint)
        .top(Math.min(pageSize * 2, 100))
        .select(
          'id,conversationId,subject,bodyPreview,from,toRecipients,receivedDateTime,sentDateTime,isRead,flag,importance,inferenceClassification,categories,isDraft'
        );
      if (opts.query && opts.query.trim()) {
        request = request.search(`"${opts.query.trim().replace(/"/g, '\\"')}"`);
      } else if (
        folderId &&
        (folderId === 'sentitems' || folderId === 'drafts' || folderId === 'outbox')
      ) {
        // Sent/draft/outbox messages often lack receivedDateTime; ordering by it 400s.
        request = request.orderby('sentDateTime desc');
      } else {
        request = request.orderby('receivedDateTime desc');
      }
      res = (await request.get()) as typeof res;
    }

    const allMessages = res?.value || [];
    const grouped = new Map<string, ReturnType<typeof formatThreadListItem>[]>();

    for (const msg of allMessages) {
      const formatted = formatThreadListItem(msg);
      const key = formatted.threadId;
      const bucket = grouped.get(key) || [];
      bucket.push(formatted);
      grouped.set(key, bucket);
    }

    const threads: EmailThreadListItem[] = [];
    for (const [threadId, items] of grouped.entries()) {
      const sorted = [...items].sort((a, b) => {
        const ta = new Date(a.date || 0).getTime();
        const tb = new Date(b.date || 0).getTime();
        return tb - ta;
      });
      const latest = sorted[0];
      const oldest = sorted[sorted.length - 1];
      const labelIds = [...new Set(sorted.flatMap((x) => x.labelIds || []))];
      threads.push({
        ...latest,
        id: threadId,
        threadId,
        firstMessageId: oldest.firstMessageId,
        lastMessageId: latest.lastMessageId,
        messageCount: sorted.length,
        labelIds,
        isUnread: sorted.some((x) => x.isUnread),
      });
    }

    threads.sort((a, b) => {
      const ta = new Date(a.date || 0).getTime();
      const tb = new Date(b.date || 0).getTime();
      return tb - ta;
    });

    return {
      // Return every thread from this fetch. Slicing to pageSize would drop
      // threads that Graph's nextLink cursor has already advanced past, so
      // they'd never appear on any page.
      // ponytail: a thread whose messages straddle a page boundary can repeat
      // on the next page; dedup by thread id client-side if paging ever ships.
      threads,
      nextPageToken: res?.['@odata.nextLink'] || null,
      resultSizeEstimate: threads.length,
    };
  });
}

export async function getThread(
  userId: string,
  accountId: string,
  threadId: string
): Promise<{ id: string; messages: EmailMessage[] }> {
  const account = await requireAccountForUser(userId, accountId);
  return withGraphRetry(account, async (client) => {
    const ids = await resolveMessageIdsForThread(client, threadId);
    const messages = (
      await Promise.all(
        ids.map(async (id) => {
          try {
            const full = (await mailApi(client, resolveMessagePath(id))
              .select(
                'id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,flag,importance,inferenceClassification,categories,isDraft'
              )
              // Metadata only — a bare $expand=attachments inlines contentBytes,
              // so one big PDF turns a thread read into a multi-MB response.
              .expand('attachments($select=id,name,contentType,size)')
              .get()) as Parameters<typeof formatMessage>[0];
            return formatMessage(full);
          } catch {
            return null;
          }
        })
      )
    ).filter((x): x is EmailMessage => Boolean(x));

    return { id: threadId, messages };
  });
}

export async function getMessage(
  userId: string,
  accountId: string,
  messageId: string
): Promise<EmailMessage> {
  const account = await requireAccountForUser(userId, accountId);
  return withGraphRetry(account, async (client) => {
    const full = (await mailApi(client, resolveMessagePath(messageId))
      .select(
        'id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,flag,importance,inferenceClassification,categories,isDraft'
      )
      .expand('attachments($select=id,name,contentType,size)')
      .get()) as Parameters<typeof formatMessage>[0];
    return formatMessage(full);
  });
}

export async function getAttachment(
  userId: string,
  accountId: string,
  messageId: string,
  attachmentId: string
): Promise<string> {
  const account = await requireAccountForUser(userId, accountId);
  return withGraphRetry(account, async (client) => {
    const att = (await mailApi(
      client,
      `${resolveMessagePath(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
    ).get()) as { contentBytes?: string };
    return att.contentBytes || '';
  });
}

type ReplyPayload = {
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  attachments?: MailAttachmentInput[];
};

async function finalizeReplyDraft(
  client: Client,
  draftId: string,
  payload: ReplyPayload
): Promise<void> {
  const attachments = normalizeMailAttachments(payload.attachments);
  const patch: Record<string, unknown> = {
    body: {
      contentType: 'HTML',
      content: payload.html || '<p></p>',
    },
  };
  const cc = asRecipientList(payload.cc);
  const bcc = asRecipientList(payload.bcc);
  if (cc.length) patch.ccRecipients = cc;
  if (bcc.length) patch.bccRecipients = bcc;

  await mailApi(client, resolveMessagePath(draftId)).patch(patch);

  for (const att of attachments) {
    await mailApi(client, `${resolveMessagePath(draftId)}/attachments`).post({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: att.name,
      contentType: att.contentType,
      contentBytes: att.contentBytes,
    });
  }

  await mailApi(client, `${resolveMessagePath(draftId)}/send`).post({});
}

export async function sendMessage(
  userId: string,
  accountId: string,
  payload: {
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject?: string;
    html?: string;
    attachments?: MailAttachmentInput[];
    idempotencyKey?: string;
  }
): Promise<{ id: null; threadId: null }> {
  const account = await requireAccountForUser(userId, accountId);
  const attachments = normalizeMailAttachments(payload.attachments);
  await withGraphRetry(account, async (client) => {
    const message = buildGraphMessage(payload, attachments);
    // `client-request-id` is a diagnostics correlation header only. Microsoft Graph does
    // NOT deduplicate sendMail on it — see sendWorkflowMessage() for the durable path.
    const sendPath = payload.idempotencyKey
      ? mailApi(client, '/me/sendMail', { 'client-request-id': payload.idempotencyKey })
      : mailApi(client, '/me/sendMail');
    await sendPath.post({ message, saveToSentItems: true });
    return true;
  });
  return { id: null, threadId: null };
}

function buildGraphMessage(
  payload: {
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject?: string;
    html?: string;
  },
  attachments: ReturnType<typeof normalizeMailAttachments>
): Record<string, unknown> {
  return {
    subject: payload.subject || '',
    body: {
      contentType: 'HTML',
      content: payload.html || '<p></p>',
    },
    toRecipients: asRecipientList(payload.to),
    ccRecipients: asRecipientList(payload.cc),
    bccRecipients: asRecipientList(payload.bcc),
    ...(attachments.length
      ? {
          attachments: attachments.map((att) => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: att.name,
            contentType: att.contentType,
            contentBytes: att.contentBytes,
          })),
        }
      : {}),
  };
  // NOTE: `internetMessageId` is deliberately NOT set here.
  // Exchange Online treats it as read-only on the sendMail action and rejects the request
  // (ErrorInvalidPropertySet). It is only writable when creating a draft. Scheduled sends
  // therefore use createWorkflowDraft() below, which lets Exchange assign the id and reads
  // it back for durable correlation.
}

export type WorkflowDraftHandle = {
  /** Graph message id of the created draft. Stable until the draft is sent. */
  messageId: string;
  /** RFC2822 id assigned by Exchange. Survives into Sent Items — our recovery key. */
  internetMessageId: string | null;
};

/**
 * Step 1 of the durable send: create a draft and read back the identifiers Exchange
 * assigned. Persist these BEFORE calling sendWorkflowDraft() so that a crash between the
 * two steps leaves enough evidence to determine what actually happened.
 */
export async function createWorkflowDraft(
  userId: string,
  accountId: string,
  payload: {
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject?: string;
    html?: string;
    attachments?: MailAttachmentInput[];
    correlationId?: string;
  }
): Promise<WorkflowDraftHandle> {
  const account = await requireAccountForUser(userId, accountId);
  const attachments = normalizeMailAttachments(payload.attachments);
  return withGraphRetry(account, async (client) => {
    const req = payload.correlationId
      ? mailApi(client, '/me/messages', { 'client-request-id': payload.correlationId })
      : mailApi(client, '/me/messages');
    const created = (await req.post(buildGraphMessage(payload, attachments))) as {
      id?: string;
      internetMessageId?: string;
    };
    if (!created?.id) {
      throw new HttpError(502, 'Outlook did not return a draft message id');
    }
    return {
      messageId: created.id,
      internetMessageId: created.internetMessageId ?? null,
    };
  });
}

/** Step 2 of the durable send. Idempotent from Graph's side only in that a sent draft 404s. */
export async function sendWorkflowDraft(
  userId: string,
  accountId: string,
  messageId: string,
  correlationId?: string
): Promise<void> {
  const account = await requireAccountForUser(userId, accountId);
  await withGraphRetry(account, async (client) => {
    const path = `${resolveMessagePath(messageId)}/send`;
    const req = correlationId
      ? mailApi(client, path, { 'client-request-id': correlationId })
      : mailApi(client, path);
    await req.post({});
    return true;
  });
}

/** Remove an unsent draft (used by the send-path verification script's dry run). */
export async function deleteWorkflowDraft(
  userId: string,
  accountId: string,
  messageId: string
): Promise<void> {
  const account = await requireAccountForUser(userId, accountId);
  await withGraphRetry(account, async (client) => {
    await mailApi(client, resolveMessagePath(messageId)).delete();
    return true;
  });
}

export type SentMessageProbe = {
  id: string;
  sentDateTime: string | null;
  /** Outlook-on-the-web URL for the message. Null when Graph omitted it. */
  webLink: string | null;
  conversationId: string | null;
};

/**
 * Recovery probe for an unknown outcome: did this message actually leave the mailbox?
 * Looks for the internetMessageId anywhere in the mailbox (Sent Items included).
 * Returns null when Graph could not answer, which must be treated as "still unknown".
 *
 * Doubles as the "open this mail in my mailbox" resolver for the contact timeline —
 * webLink/conversationId are only needed there, but they ride along free on this query.
 */
export async function findSentMessageByInternetId(
  userId: string,
  accountId: string,
  internetMessageId: string
): Promise<SentMessageProbe | null> {
  const account = await requireAccountForUser(userId, accountId);
  try {
    return await withGraphRetry(account, async (client) => {
      const escaped = internetMessageId.replace(/'/g, "''");
      const res = (await mailApi(client, '/me/messages')
        .filter(`internetMessageId eq '${escaped}'`)
        .select('id,sentDateTime,isDraft,webLink,conversationId')
        .top(5)
        .get()) as {
        value?: Array<{
          id?: string;
          sentDateTime?: string;
          isDraft?: boolean;
          webLink?: string;
          conversationId?: string;
        }>;
      };
      const sent = (res.value ?? []).find((m) => m.isDraft === false);
      if (!sent?.id) return null;
      return {
        id: sent.id,
        sentDateTime: sent.sentDateTime ?? null,
        webLink: sent.webLink ?? null,
        conversationId: sent.conversationId ?? null,
      };
    });
  } catch {
    return null;
  }
}

/** True when Graph says the draft no longer exists — i.e. it was already sent. */
export async function draftStillExists(
  userId: string,
  accountId: string,
  messageId: string
): Promise<boolean | null> {
  const account = await requireAccountForUser(userId, accountId);
  try {
    return await withGraphRetry(account, async (client) => {
      const msg = (await mailApi(client, resolveMessagePath(messageId))
        .select('id,isDraft')
        .get()) as { isDraft?: boolean };
      return msg?.isDraft === true;
    });
  } catch (err) {
    if (isGraphNotFound(err)) return false;
    return null;
  }
}

export async function replyMessage(
  userId: string,
  accountId: string,
  messageId: string,
  payload: ReplyPayload
): Promise<{ id: null; threadId: null }> {
  const account = await requireAccountForUser(userId, accountId);
  // Fail fast on oversized attachments before createReply.
  normalizeMailAttachments(payload.attachments);
  await withGraphRetry(account, async (client) => {
    // createReply → patch → attach → send (instant /reply can't carry file attachments).
    const created = (await mailApi(client, `${resolveMessagePath(messageId)}/createReply`).post({})) as {
      id?: string;
    };
    if (!created.id) throw new HttpError(502, 'Outlook createReply did not return a draft id');
    await finalizeReplyDraft(client, created.id, payload);
    return true;
  });
  return { id: null, threadId: null };
}

export async function replyAllMessage(
  userId: string,
  accountId: string,
  messageId: string,
  payload: ReplyPayload
): Promise<{ id: null; threadId: null }> {
  const account = await requireAccountForUser(userId, accountId);
  normalizeMailAttachments(payload.attachments);
  await withGraphRetry(account, async (client) => {
    const created = (await mailApi(client, `${resolveMessagePath(messageId)}/createReplyAll`).post({})) as {
      id?: string;
    };
    if (!created.id) throw new HttpError(502, 'Outlook createReplyAll did not return a draft id');
    await finalizeReplyDraft(client, created.id, payload);
    return true;
  });
  return { id: null, threadId: null };
}

export async function forwardMessage(
  userId: string,
  accountId: string,
  messageId: string,
  payload: { to: string | string[]; html?: string }
): Promise<{ id: null; threadId: null }> {
  const original = await getMessage(userId, accountId, messageId);
  const subject = original.subject.startsWith('Fwd:')
    ? original.subject
    : `Fwd: ${original.subject}`;
  // The message is sent as HTML: escape the header fields ("Name <email>"
  // would otherwise be swallowed as a tag) and use <br/>, not \n.
  const headerHtml = [
    '---------- Forwarded message ---------',
    `From: ${escapeHtml(original.from)}`,
    `Date: ${escapeHtml(original.date || '')}`,
    `Subject: ${escapeHtml(original.subject)}`,
    `To: ${escapeHtml(original.to)}`,
    ...(original.cc ? [`Cc: ${escapeHtml(original.cc)}`] : []),
  ].join('<br/>');
  const originalBody =
    original.htmlBody ??
    (original.textBody ? escapeHtml(original.textBody).replace(/\n/g, '<br/>') : '');
  // Sender's comment on top, like every mail client.
  const body = [payload.html || '', headerHtml, originalBody]
    .filter(Boolean)
    .join('<br/><br/>');
  return sendMessage(userId, accountId, {
    to: payload.to,
    subject,
    html: body,
  });
}

export async function modifyMessage(
  userId: string,
  accountId: string,
  messageId: string,
  opts: { addLabelIds?: string[]; removeLabelIds?: string[] }
): Promise<{ success: true }> {
  const account = await requireAccountForUser(userId, accountId);
  await withGraphRetry(account, async (client) => {
    const addLabelIds = opts.addLabelIds || [];
    const removeLabelIds = opts.removeLabelIds || [];

    const patch: Record<string, unknown> = {};
    if (removeLabelIds.includes('UNREAD')) patch.isRead = true;
    if (addLabelIds.includes('UNREAD')) patch.isRead = false;
    if (addLabelIds.includes('STARRED')) patch.flag = { flagStatus: 'flagged' };
    if (removeLabelIds.includes('STARRED')) patch.flag = { flagStatus: 'notFlagged' };
    if (Object.keys(patch).length > 0) {
      await mailApi(client, resolveMessagePath(messageId)).patch(patch);
    }

    if (addLabelIds.includes('INBOX')) {
      // Microsoft Graph: POST /me/messages/{id}/move { destinationId: "inbox" }
      await mailApi(client, `${resolveMessagePath(messageId)}/move`).post({ destinationId: 'inbox' });
    } else if (removeLabelIds.includes('INBOX')) {
      await mailApi(client, `${resolveMessagePath(messageId)}/move`).post({ destinationId: 'archive' });
    }
    return true;
  });
  return { success: true };
}

export async function batchModifyThreads(
  userId: string,
  accountId: string,
  threadIds: string[],
  opts: { addLabelIds?: string[]; removeLabelIds?: string[] }
): Promise<{ success: true; modified: number }> {
  const account = await requireAccountForUser(userId, accountId);
  const addLabelIds = opts.addLabelIds || [];
  const removeLabelIds = opts.removeLabelIds || [];

  const uniqueMessageIds = await withGraphRetry(account, async (client) => {
    const all: string[] = [];
    for (const tid of threadIds) {
      let ids: string[];
      if (removeLabelIds.includes('INBOX')) {
        ids = await resolveMessageIdsInFolder(client, tid, 'inbox');
      } else if (addLabelIds.includes('INBOX')) {
        // Restore from Trash or unarchive — only move messages in those folders.
        ids = await resolveMessageIdsInFolder(client, tid, 'deleteditems');
        if (ids.length === 0) {
          ids = await resolveMessageIdsInFolder(client, tid, 'archive');
        }
        if (ids.length === 0) {
          ids = await resolveMessageIdsForThread(client, tid);
        }
      } else {
        ids = await resolveMessageIdsForThread(client, tid);
      }
      all.push(...ids);
    }
    return [...new Set(all)];
  });

  for (const messageId of uniqueMessageIds) {
    await modifyMessage(userId, accountId, messageId, opts);
  }

  return { success: true, modified: uniqueMessageIds.length };
}

export async function trashThreads(
  userId: string,
  accountId: string,
  threadIds: string[]
): Promise<{ success: true }> {
  const account = await requireAccountForUser(userId, accountId);
  await withGraphRetry(account, async (client) => {
    for (const tid of threadIds) {
      const ids = await resolveMessageIdsForThread(client, tid);
      for (const id of ids) {
        try {
          await mailApi(client, `${resolveMessagePath(id)}/move`).post({ destinationId: 'deleteditems' });
        } catch (err) {
          // Graph message ids change on move. If the token expires mid-loop,
          // withGraphRetry re-runs the whole batch and the already-moved
          // messages 404 under their old ids — that means done, not failed.
        }
      }
    }
    return true;
  });
  return { success: true };
}

export type OutlookSyncRemoval = {
  folder: string;
  conversationId: string;
  messageId?: string;
};

export type OutlookSyncThread = EmailThreadListItem & {
  mailboxLabels: string[];
};

type DeltaPage = {
  value?: Array<
    | (Parameters<typeof formatThreadListItem>[0] & { conversationId?: string })
    | { id: string; '@removed'?: { reason?: string } }
  >;
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
};

function isGraphSyncStateGone(err: unknown): boolean {
  const raw = err as { statusCode?: number; status?: number | string; code?: string };
  return raw.statusCode === 410 || raw.status === 410 || raw.code === 'syncStateNotFound';
}

function groupDeltaMessages(
  rows: Parameters<typeof formatThreadListItem>[0][]
): EmailThreadListItem[] {
  const grouped = new Map<string, ReturnType<typeof formatThreadListItem>[]>();
  for (const msg of rows) {
    const formatted = formatThreadListItem(msg);
    const key = formatted.threadId;
    const bucket = grouped.get(key) || [];
    bucket.push(formatted);
    grouped.set(key, bucket);
  }

  const threads: EmailThreadListItem[] = [];
  for (const [threadId, items] of grouped.entries()) {
    const sorted = [...items].sort((a, b) => {
      const ta = new Date(a.date || 0).getTime();
      const tb = new Date(b.date || 0).getTime();
      return tb - ta;
    });
    const latest = sorted[0];
    const oldest = sorted[sorted.length - 1];
    threads.push({
      ...latest,
      id: threadId,
      threadId,
      firstMessageId: oldest.firstMessageId,
      lastMessageId: latest.lastMessageId,
      messageCount: sorted.length,
      labelIds: [...new Set(sorted.flatMap((x) => x.labelIds || []))],
      isUnread: sorted.some((x) => x.isUnread),
    });
  }

  threads.sort((a, b) => {
    const ta = new Date(a.date || 0).getTime();
    const tb = new Date(b.date || 0).getTime();
    return tb - ta;
  });
  return threads;
}

async function fetchDeltaPage(client: Client, url: string): Promise<DeltaPage> {
  const request = url.startsWith('http') ? client.api(url) : mailApi(client, url);
  return (await request.header('Prefer', IMMUTABLE_ID_PREFER).get()) as DeltaPage;
}

async function syncFolderDelta(
  account: OutlookAccount,
  userId: string,
  folderWellKnown: string,
  mailboxLabel: string
): Promise<{
  threads: OutlookSyncThread[];
  removals: OutlookSyncRemoval[];
  folderSyncAt: string;
}> {
  const existing = await OutlookSyncStateModel.findOne({
    userId,
    accountId: account.id,
    folderWellKnown,
  }).lean();

  let deltaLink = existing?.deltaLink ?? null;
  const deltaMessages: Parameters<typeof formatThreadListItem>[0][] = [];
  const removals: OutlookSyncRemoval[] = [];

  await withGraphRetry(account, async (client) => {
    let nextUrl: string | null =
      deltaLink ??
      `/me/mailFolders/${encodeURIComponent(folderWellKnown)}/messages/delta?$select=${encodeURIComponent(DELTA_MESSAGE_SELECT)}`;
    let retried = false;

    while (nextUrl) {
      let page: DeltaPage;
      try {
        page = await fetchDeltaPage(client, nextUrl);
      } catch (err) {
        if (!retried && isGraphSyncStateGone(err)) {
          await OutlookSyncStateModel.updateOne(
            { userId, accountId: account.id, folderWellKnown },
            {
              $set: {
                deltaLink: null,
                bootstrapComplete: false,
                updatedAt: new Date().toISOString(),
              },
            }
          );
          deltaLink = null;
          nextUrl = `/me/mailFolders/${encodeURIComponent(folderWellKnown)}/messages/delta?$select=${encodeURIComponent(DELTA_MESSAGE_SELECT)}`;
          retried = true;
          continue;
        }
        throw err;
      }

      for (const row of page.value || []) {
        if ('@removed' in row && row['@removed']) {
          removals.push({
            folder: mailboxLabel,
            conversationId: row.id,
            messageId: row.id,
          });
          continue;
        }
        deltaMessages.push(row as Parameters<typeof formatThreadListItem>[0]);
      }

      if (page['@odata.nextLink']) {
        nextUrl = page['@odata.nextLink'];
      } else {
        deltaLink = page['@odata.deltaLink'] ?? deltaLink;
        nextUrl = null;
      }
    }
  });

  const folderSyncAt = new Date().toISOString();
  await OutlookSyncStateModel.findOneAndUpdate(
    { userId, accountId: account.id, folderWellKnown },
    {
      $set: {
        deltaLink,
        lastSyncAt: folderSyncAt,
        bootstrapComplete: true,
        updatedAt: folderSyncAt,
      },
    },
    { upsert: true }
  );

  const threads = groupDeltaMessages(deltaMessages).map((thread) => ({
    ...thread,
    mailboxLabels: [mailboxLabel],
  }));

  return { threads, removals, folderSyncAt };
}

function orderSyncFolders(folders: string[]): string[] {
  const unique = [...new Set(folders.filter(Boolean))];
  return unique.sort((a, b) => {
    if (a === 'INBOX') return -1;
    if (b === 'INBOX') return 1;
    if (a === 'SENT') return -1;
    if (b === 'SENT') return 1;
    return a.localeCompare(b);
  });
}

export async function syncMailbox(
  userId: string,
  accountId: string,
  opts: { folders?: string[]; mode?: 'delta' | 'bootstrap' } = {}
): Promise<{
  threads: OutlookSyncThread[];
  removed: OutlookSyncRemoval[];
  folderSyncAt: Record<string, string>;
}> {
  const account = await requireAccountForUser(userId, accountId);
  const mode = opts.mode ?? 'delta';
  const folderLabels = orderSyncFolders(
    opts.folders?.length
      ? opts.folders
      : mode === 'delta'
        ? ['INBOX']
        : ALL_SYNC_FOLDER_LABELS
  );

  const threadMap = new Map<string, OutlookSyncThread>();
  const removed: OutlookSyncRemoval[] = [];
  const folderSyncAt: Record<string, string> = {};

  for (const labelId of folderLabels) {
    const wellKnown = FOLDER_MAP[labelId];
    if (!wellKnown) continue;
    const result = await syncFolderDelta(account, userId, wellKnown, labelId);
    folderSyncAt[labelId] = result.folderSyncAt;
    removed.push(...result.removals);

    for (const thread of result.threads) {
      const key = thread.threadId;
      const existing = threadMap.get(key);
      if (!existing) {
        threadMap.set(key, thread);
        continue;
      }
      const labels = new Set([...existing.mailboxLabels, ...thread.mailboxLabels]);
      const incomingDate = thread.date ?? '';
      const existingDate = existing.date ?? '';
      if (incomingDate > existingDate) {
        threadMap.set(key, { ...thread, mailboxLabels: [...labels] });
      } else {
        threadMap.set(key, { ...existing, mailboxLabels: [...labels] });
      }
    }
  }

  return {
    threads: [...threadMap.values()],
    removed,
    folderSyncAt,
  };
}

export async function getMailFolderStats(
  userId: string,
  accountId: string
): Promise<
  Record<string, { unreadItemCount: number; totalItemCount: number; loaded: true }>
> {
  const account = await requireAccountForUser(userId, accountId);
  const stats: Record<string, { unreadItemCount: number; totalItemCount: number; loaded: true }> =
    {};

  await withGraphRetry(account, async (client) => {
    for (const [labelId, wellKnown] of Object.entries(FOLDER_MAP)) {
      try {
        const folder = (await mailApi(client, `/me/mailFolders/${encodeURIComponent(wellKnown)}`)
          .select('totalItemCount,unreadItemCount')
          .get()) as { totalItemCount?: number; unreadItemCount?: number };
        stats[labelId] = {
          unreadItemCount: folder.unreadItemCount ?? 0,
          totalItemCount: folder.totalItemCount ?? 0,
          loaded: true,
        };
      } catch {
        // folder may not exist on all tenants
      }
    }
  });

  return stats;
}
