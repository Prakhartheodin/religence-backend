export type EmailProvider = 'outlook';

export type AccountStatus = 'active' | 'revoked' | 'error';

export interface OutlookAccount {
  id: string;
  userId: string;
  provider: EmailProvider;
  email: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiry: string | null;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EmailAccountPublic {
  id: string;
  provider: EmailProvider;
  email: string;
  status: AccountStatus;
  createdAt: string;
}

export interface EmailLabel {
  id: string;
  name: string;
  type?: string;
  messagesTotal?: number;
  messagesUnread?: number;
}

export interface EmailThreadListItem {
  id: string;
  threadId: string;
  lastMessageId?: string;
  firstMessageId?: string;
  snippet: string;
  from: string;
  to: string;
  subject: string;
  date: string | null;
  messageCount: number;
  labelIds?: string[];
  isUnread: boolean;
}

export interface EmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  date: string | null;
  isUnread: boolean;
  htmlBody: string | null;
  textBody: string | null;
  attachments: {
    filename: string;
    mimeType: string;
    size: number;
    attachmentId?: string;
    messageId?: string;
  }[];
}
