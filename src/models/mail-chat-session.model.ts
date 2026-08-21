import mongoose from 'mongoose';
import type { ConversationDraft } from '../services/mail-workflow/chat-draft.js';
import type { ChatMessageResult } from '../services/mail-workflow/chat-types.js';

export const MAIL_ASSISTANT_TYPE = 'mail' as const;

export type PersistedUserMessage = {
  id: string;
  role: 'user';
  text: string;
  createdAt: Date;
};

export type PersistedAssistantMessage = {
  id: string;
  role: 'assistant';
  response: ChatMessageResult;
  createdAt: Date;
};

export type PersistedSystemMessage = {
  id: string;
  role: 'system';
  text: string;
  createdAt: Date;
};

export type PersistedChatMessage =
  | PersistedUserMessage
  | PersistedAssistantMessage
  | PersistedSystemMessage;

export type ChatRequestLedgerEntry = {
  requestId: string;
  userMessageId?: string;
  assistantMessageId: string;
  response: ChatMessageResult;
  createdAt: Date;
};

export type MailChatSessionDocument = {
  id: string;
  userId: string;
  workspaceId: string;
  assistantType: typeof MAIL_ASSISTANT_TYPE;
  messages: PersistedChatMessage[];
  draft: ConversationDraft;
  requestLedger: ChatRequestLedgerEntry[];
  createdAt: Date;
  updatedAt: Date;
};

const messageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    role: { type: String, required: true, enum: ['user', 'assistant', 'system'] },
    text: { type: String },
    response: { type: mongoose.Schema.Types.Mixed },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

const ledgerSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true },
    userMessageId: { type: String },
    assistantMessageId: { type: String, required: true },
    response: { type: mongoose.Schema.Types.Mixed, required: true },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

const mailChatSessionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    userId: { type: String, required: true },
    workspaceId: { type: String, required: true },
    assistantType: { type: String, required: true, enum: [MAIL_ASSISTANT_TYPE], default: MAIL_ASSISTANT_TYPE },
    messages: { type: [messageSchema], default: [] },
    draft: { type: mongoose.Schema.Types.Mixed, default: {} },
    requestLedger: { type: [ledgerSchema], default: [] },
  },
  {
    collection: 'mail_chat_sessions',
    versionKey: false,
    timestamps: true,
  },
);

mailChatSessionSchema.index({ userId: 1, workspaceId: 1, assistantType: 1 }, { unique: true });
mailChatSessionSchema.index({ 'requestLedger.requestId': 1 });

export const MailChatSessionModel =
  (mongoose.models.MailChatSession as mongoose.Model<MailChatSessionDocument>) ??
  mongoose.model<MailChatSessionDocument>('MailChatSession', mailChatSessionSchema);
