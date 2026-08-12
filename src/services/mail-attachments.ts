import { HttpError } from '../http-error.js';

export type MailAttachmentInput = {
  name?: string;
  contentType?: string;
  contentBytes?: string;
};

export type NormalizedMailAttachment = {
  name: string;
  contentType: string;
  contentBytes: string;
};

// Graph sendMail / draft attach caps the whole request around 4MB — larger
// files need an upload session. ponytail: hard-reject; upload sessions if >3MB.
const MAX_ATTACHMENT_BASE64 = 4 * 1024 * 1024;

export function normalizeMailAttachments(
  attachments?: MailAttachmentInput[]
): NormalizedMailAttachment[] {
  const list = (Array.isArray(attachments) ? attachments : [])
    .filter((att) => typeof att?.contentBytes === 'string' && att.contentBytes.length > 0)
    .map((att) => ({
      name: att.name || 'attachment',
      contentType: att.contentType || 'application/octet-stream',
      contentBytes: att.contentBytes as string,
    }));
  const totalBase64 = list.reduce((sum, att) => sum + att.contentBytes.length, 0);
  if (totalBase64 > MAX_ATTACHMENT_BASE64) {
    throw new HttpError(413, 'Attachments too large — keep the combined size under 3MB.');
  }
  return list;
}
