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
import type { EmailAccountPublic, EmailLabel, EmailMessage, EmailThreadListItem, OutlookAccount } from '../types/email.js';

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
};

const REVERSE_FOLDER_MAP: Record<string, string> = {
  inbox: 'INBOX',
  sentitems: 'SENT',
  deleteditems: 'TRASH',
  drafts: 'DRAFT',
  junkemail: 'JUNK',
  archive: 'ARCHIVE',
  outbox: 'OUTBOX',
};

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

function synthesizeLabelIds(message: { isRead?: boolean; flag?: { flagStatus?: string } }): string[] {
  const ids: string[] = [];
  if (message.isRead === false) ids.push('UNREAD');
  if (message.flag?.flagStatus === 'flagged') ids.push('STARRED');
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
  if (!account || account.status !== 'active') {
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
    await updateOutlookAccount(account.userId, account.id, { status: 'error' });
    throw new HttpError(
      401,
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
  const res = (await client
    .api('/me/messages')
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
    const one = (await client
      .api(resolveMessagePath(threadId))
      .select('id')
      .get()) as { id?: string };
    if (one.id) return [one.id];
  } catch {
    return [];
  }
  return [];
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

export async function listLabels(userId: string, accountId: string): Promise<EmailLabel[]> {
  const account = await requireAccountForUser(userId, accountId);
  return withGraphRetry(account, async (client) => {
    const res = (await client
      .api('/me/mailFolders')
      .top(200)
      .get()) as {
      value?: Array<{
        id: string;
        displayName?: string;
        wellKnownName?: string;
        totalItemCount?: number;
        unreadItemCount?: number;
      }>;
    };

    return (res.value || []).map((folder) => {
      const wellKnown = String(folder.wellKnownName || '').toLowerCase();
      return {
        id: REVERSE_FOLDER_MAP[wellKnown] || folder.id,
        name: folder.displayName || folder.wellKnownName || folder.id,
        type: wellKnown ? 'system' : 'user',
        messagesTotal: folder.totalItemCount ?? 0,
        messagesUnread: folder.unreadItemCount ?? 0,
      };
    });
  });
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
      res = (await client.api(opts.pageToken).get()) as typeof res;
    } else {
      const folderId = normalizeFolderId(opts.labelId);
      const endpoint = folderId
        ? `/me/mailFolders/${encodeURIComponent(folderId)}/messages`
        : '/me/messages';
      let request = client
        .api(endpoint)
        .top(Math.min(pageSize * 2, 100))
        .select(
          'id,conversationId,subject,bodyPreview,from,toRecipients,receivedDateTime,sentDateTime,isRead,flag'
        );
      if (opts.query && opts.query.trim()) {
        request = request.search(`"${opts.query.trim().replace(/"/g, '\\"')}"`);
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
      threads: threads.slice(0, pageSize),
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
            const full = (await client
              .api(resolveMessagePath(id))
              .select(
                'id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,flag'
              )
              .expand('attachments')
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
    const full = (await client
      .api(resolveMessagePath(messageId))
      .select(
        'id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,flag'
      )
      .expand('attachments')
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
    const att = (await client
      .api(`${resolveMessagePath(messageId)}/attachments/${encodeURIComponent(attachmentId)}`)
      .get()) as { contentBytes?: string };
    return att.contentBytes || '';
  });
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
  }
): Promise<{ id: null; threadId: null }> {
  const account = await requireAccountForUser(userId, accountId);
  await withGraphRetry(account, async (client) => {
    const message = {
      subject: payload.subject || '',
      body: {
        contentType: 'HTML',
        content: payload.html || '<p></p>',
      },
      toRecipients: asRecipientList(payload.to),
      ccRecipients: asRecipientList(payload.cc),
      bccRecipients: asRecipientList(payload.bcc),
    };
    await client.api('/me/sendMail').post({ message, saveToSentItems: true });
    return true;
  });
  return { id: null, threadId: null };
}

export async function replyMessage(
  userId: string,
  accountId: string,
  messageId: string,
  payload: { html?: string }
): Promise<{ id: null; threadId: null }> {
  const account = await requireAccountForUser(userId, accountId);
  await withGraphRetry(account, async (client) => {
    await client.api(`${resolveMessagePath(messageId)}/reply`).post({
      message: {
        body: {
          contentType: 'HTML',
          content: payload.html || '<p></p>',
        },
      },
      comment: '',
    });
    return true;
  });
  return { id: null, threadId: null };
}

export async function replyAllMessage(
  userId: string,
  accountId: string,
  messageId: string,
  payload: { html?: string }
): Promise<{ id: null; threadId: null }> {
  const account = await requireAccountForUser(userId, accountId);
  await withGraphRetry(account, async (client) => {
    const created = (await client.api(`${resolveMessagePath(messageId)}/createReplyAll`).post({})) as {
      id?: string;
    };
    if (!created.id) throw new HttpError(502, 'Outlook createReplyAll did not return a draft id');

    await client.api(resolveMessagePath(created.id)).patch({
      body: {
        contentType: 'HTML',
        content: payload.html || '<p></p>',
      },
    });
    await client.api(`${resolveMessagePath(created.id)}/send`).post({});
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
  const body = [
    '---------- Forwarded message ---------',
    `From: ${original.from}`,
    `Date: ${original.date || ''}`,
    `Subject: ${original.subject}`,
    `To: ${original.to}`,
    ...(original.cc ? [`Cc: ${original.cc}`] : []),
    '',
    original.htmlBody || original.textBody || '',
    '',
    payload.html || '',
  ].join('\n');
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
      await client.api(resolveMessagePath(messageId)).patch(patch);
    }

    if (addLabelIds.includes('SPAM')) {
      await client.api(`${resolveMessagePath(messageId)}/move`).post({ destinationId: 'junkemail' });
    } else if (removeLabelIds.includes('INBOX')) {
      await client.api(`${resolveMessagePath(messageId)}/move`).post({ destinationId: 'archive' });
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
  const uniqueMessageIds = await withGraphRetry(account, async (client) => {
    const all: string[] = [];
    for (const tid of threadIds) {
      const ids = await resolveMessageIdsForThread(client, tid);
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
        await client.api(`${resolveMessagePath(id)}/move`).post({ destinationId: 'deleteditems' });
      }
    }
    return true;
  });
  return { success: true };
}
