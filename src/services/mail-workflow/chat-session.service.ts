import { randomUUID } from 'node:crypto';
import {
  MAIL_ASSISTANT_TYPE,
  MailChatSessionModel,
  type MailChatSessionDocument,
  type PersistedAssistantMessage,
  type PersistedChatMessage,
  type PersistedSystemMessage,
  type PersistedUserMessage,
} from '../../models/mail-chat-session.model.js';
import type { ChatMessageInput, ChatMessageResult } from './chat-types.js';
import { emptyDraft, type ConversationDraft } from './chat-draft.js';

const LEDGER_CAP = 200;
const MESSAGE_CAP = 400;

// ponytail: no multi-workspace tenancy yet; userId scopes the session
function workspaceIdFor(userId: string): string {
  return userId;
}

function sessionFilter(userId: string) {
  return {
    userId,
    workspaceId: workspaceIdFor(userId),
    assistantType: MAIL_ASSISTANT_TYPE,
  };
}

// ponytail: cap in the write with $slice — the old in-memory trim mutated a lean() copy
// and was never persisted, so both arrays grew until the 16MB document limit killed the session.

export type MailChatSessionView = {
  sessionId: string;
  messages: Array<
    | { id: string; role: 'user'; text: string; createdAt: string }
    | { id: string; role: 'assistant'; response: ChatMessageResult; createdAt: string }
    | { id: string; role: 'system'; text: string; createdAt: string }
  >;
  draft: ConversationDraft;
  updatedAt: string;
};

export type ChatExchange = {
  user: { id: string; text: string; createdAt: string } | null;
  assistant: { id: string; response: ChatMessageResult; createdAt: string };
};

function toView(doc: MailChatSessionDocument): MailChatSessionView {
  return {
    sessionId: doc.id,
    messages: doc.messages.map((m) => {
      if (m.role === 'user') {
        return { id: m.id, role: 'user' as const, text: m.text, createdAt: m.createdAt.toISOString() };
      }
      if (m.role === 'system') {
        return { id: m.id, role: 'system' as const, text: m.text, createdAt: m.createdAt.toISOString() };
      }
      return {
        id: m.id,
        role: 'assistant' as const,
        response: m.response,
        createdAt: m.createdAt.toISOString(),
      };
    }),
    draft: (doc.draft as ConversationDraft) ?? emptyDraft(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function getOrCreateMailSession(userId: string): Promise<MailChatSessionDocument> {
  const filter = sessionFilter(userId);
  let doc = await MailChatSessionModel.findOne(filter).lean();
  if (doc) return doc as MailChatSessionDocument;

  try {
    const created = await MailChatSessionModel.create({
      id: randomUUID(),
      ...filter,
      messages: [],
      draft: emptyDraft(),
      requestLedger: [],
    });
    return created.toObject() as MailChatSessionDocument;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      doc = await MailChatSessionModel.findOne(filter).lean();
      if (doc) return doc as MailChatSessionDocument;
    }
    throw err;
  }
}

export async function getMailChatSession(userId: string): Promise<MailChatSessionView> {
  const doc = await getOrCreateMailSession(userId);
  return toView(doc);
}

export async function loadConversationDraft(userId: string): Promise<ConversationDraft> {
  const doc = await getOrCreateMailSession(userId);
  return (doc.draft as ConversationDraft) ?? emptyDraft();
}

export async function saveConversationDraft(userId: string, draft: ConversationDraft): Promise<void> {
  await MailChatSessionModel.updateOne(sessionFilter(userId), { $set: { draft } });
}

export async function clearMailChatSession(userId: string): Promise<void> {
  await MailChatSessionModel.updateOne(sessionFilter(userId), {
    $set: {
      messages: [],
      draft: emptyDraft(),
      requestLedger: [],
    },
  });
}

export function findCachedResponse(
  doc: MailChatSessionDocument,
  requestId: string,
): ChatMessageResult | null {
  const hit = doc.requestLedger.find((e) => e.requestId === requestId);
  return hit?.response ?? null;
}

function shouldRecordUserMessage(input: ChatMessageInput): boolean {
  if (input.confirm?.workflowId) return false;
  if (input.choiceId) return false;
  const text = input.text.trim();
  return Boolean(text) && text !== '(choice)';
}

export async function persistChatExchange(
  userId: string,
  input: ChatMessageInput,
  result: ChatMessageResult,
): Promise<ChatExchange> {
  const session = await getOrCreateMailSession(userId);
  const cached = findCachedResponse(session, input.requestId);
  if (cached) {
    const entry = session.requestLedger.find((e) => e.requestId === input.requestId)!;
    const userMsg = entry.userMessageId
      ? (session.messages.find((m) => m.id === entry.userMessageId) as PersistedUserMessage | undefined)
      : undefined;
    const assistantMsg = session.messages.find(
      (m) => m.id === entry.assistantMessageId,
    ) as PersistedAssistantMessage | undefined;
    return {
      user: userMsg
        ? { id: userMsg.id, text: userMsg.text, createdAt: userMsg.createdAt.toISOString() }
        : null,
      assistant: {
        id: assistantMsg?.id ?? entry.assistantMessageId,
        response: cached,
        createdAt: (assistantMsg?.createdAt ?? entry.createdAt).toISOString(),
      },
    };
  }

  const now = new Date();
  const assistantMessageId = randomUUID();
  const assistantMessage: PersistedAssistantMessage = {
    id: assistantMessageId,
    role: 'assistant',
    response: result,
    createdAt: now,
  };

  const newMessages: PersistedChatMessage[] = [assistantMessage];
  let userMessageId: string | undefined;
  let userExchange: ChatExchange['user'] = null;

  if (shouldRecordUserMessage(input)) {
    userMessageId = randomUUID();
    const userMessage: PersistedUserMessage = {
      id: userMessageId,
      role: 'user',
      text: input.text.trim(),
      createdAt: now,
    };
    newMessages.unshift(userMessage);
    userExchange = {
      id: userMessage.id,
      text: userMessage.text,
      createdAt: userMessage.createdAt.toISOString(),
    };
  }

  const ledgerEntry = {
    requestId: input.requestId,
    ...(userMessageId ? { userMessageId } : {}),
    assistantMessageId,
    response: result,
    createdAt: now,
  };

  await MailChatSessionModel.updateOne(sessionFilter(userId), {
    $push: {
      messages: { $each: newMessages, $slice: -MESSAGE_CAP },
      requestLedger: { $each: [ledgerEntry], $slice: -LEDGER_CAP },
    },
  });

  return {
    user: userExchange,
    assistant: {
      id: assistantMessageId,
      response: result,
      createdAt: now.toISOString(),
    },
  };
}

export type SessionRecordInput = {
  requestId: string;
  removeMessageIds?: string[];
  assistantResponse?: ChatMessageResult;
  systemText?: string;
  clearDraft?: boolean;
};

export async function recordSessionUpdate(
  userId: string,
  input: SessionRecordInput,
): Promise<MailChatSessionView> {
  const session = await getOrCreateMailSession(userId);
  if (findCachedResponse(session, input.requestId)) {
    return getMailChatSession(userId);
  }

  const filter = sessionFilter(userId);
  const now = new Date();
  const pullIds = input.removeMessageIds ?? [];

  if (pullIds.length) {
    await MailChatSessionModel.updateOne(filter, {
      $pull: { messages: { id: { $in: pullIds } } },
    });
  }

  const toPush: PersistedChatMessage[] = [];
  let assistantMessageId = randomUUID();

  if (input.assistantResponse) {
    assistantMessageId = randomUUID();
    toPush.push({
      id: assistantMessageId,
      role: 'assistant',
      response: input.assistantResponse,
      createdAt: now,
    });
  }
  if (input.systemText) {
    toPush.push({
      id: randomUUID(),
      role: 'system',
      text: input.systemText,
      createdAt: now,
    });
  }

  const updates: Record<string, unknown>[] = [];
  if (toPush.length) {
    updates.push({ $push: { messages: { $each: toPush, $slice: -MESSAGE_CAP } } });
  }
  if (input.assistantResponse) {
    updates.push({
      $push: {
        requestLedger: {
          $each: [{
            requestId: input.requestId,
            assistantMessageId,
            response: input.assistantResponse,
            createdAt: now,
          }],
          $slice: -LEDGER_CAP,
        },
      },
    });
  } else if (input.systemText) {
    updates.push({
      $push: {
        requestLedger: {
          $each: [{
            requestId: input.requestId,
            assistantMessageId,
            response: { kind: 'assistant_message', message: input.systemText },
            createdAt: now,
          }],
          $slice: -LEDGER_CAP,
        },
      },
    });
  }

  for (const update of updates) {
    await MailChatSessionModel.updateOne(filter, update);
  }

  if (input.clearDraft) {
    await saveConversationDraft(userId, emptyDraft());
  }

  return getMailChatSession(userId);
}
