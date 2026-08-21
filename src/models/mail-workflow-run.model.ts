import mongoose from 'mongoose';
import type {
  RecipientSendStatus,
  RunStatus,
  SendState,
} from '../services/mail-workflow/contract.js';

export type MailWorkflowRunAttempt = {
  at: Date;
  recipientId?: string;
  errorCode?: string;
  errorMessage?: string;
  retriable: boolean;
};

/**
 * Per-recipient outcome. `unknown` means the send was dispatched to Graph but we never
 * observed the response (crash / socket death), so a resend could duplicate the email.
 */
export type MailWorkflowRunRecipient = {
  recipientId: string;
  email: string;
  /**
   * Denormalised at send time on purpose. The contact timeline has to stay readable
   * years later, after the lead has been renamed or deleted and the template rewritten —
   * a join would show today's data against a historical send, or nothing at all.
   */
  contactName?: string;
  companyName?: string;
  /** The subject actually rendered for THIS send, not whatever the template says now. */
  subject?: string;
  status: RecipientSendStatus;
  attemptCount: number;
  /** Set immediately before the Graph call so a crash leaves evidence of the dispatch. */
  dispatchedAt?: Date | null;
  /** Set once Graph returned 2xx. */
  acceptedAt?: Date | null;
  /** Graph id of the draft created before sending — the crash-recovery handle. */
  draftMessageId?: string | null;
  /** RFC2822 id Exchange assigned to the draft. Survives into Sent Items. */
  internetMessageId?: string | null;
  clientRequestId?: string;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type MailWorkflowRunDocument = {
  id: string;
  workflowId: string;
  userId: string;
  scheduledAt: Date;
  status: RunStatus;
  sendState: SendState;
  attemptCount: number;
  attempts: MailWorkflowRunAttempt[];
  recipients: MailWorkflowRunRecipient[];
  /** Correlation key echoed to Graph as client-request-id. NOT a provider idempotency key. */
  providerIdempotencyKey: string;
  providerMessageId?: string;
  failureReason?: string;
  skipReason?: string;
  /** Execution lease — separate from the workflow lease so retries never block the tick. */
  executorOwner?: string | null;
  executorLeaseUntil?: Date | null;
  /** When the next retry attempt becomes eligible. Null when no retry is pending. */
  nextAttemptAt?: Date | null;
  /** True when a human needs to check the mailbox before this run can be resolved. */
  needsOperatorReview?: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const attemptSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    recipientId: { type: String },
    errorCode: { type: String },
    errorMessage: { type: String },
    retriable: { type: Boolean, required: true },
  },
  { _id: false }
);

const recipientSchema = new mongoose.Schema(
  {
    recipientId: { type: String, required: true },
    email: { type: String, required: true, default: '' },
    contactName: { type: String, default: '' },
    companyName: { type: String, default: '' },
    subject: { type: String, default: '' },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'sending', 'sent', 'failed', 'unknown'],
      default: 'pending',
    },
    attemptCount: { type: Number, required: true, default: 0 },
    dispatchedAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    draftMessageId: { type: String, default: null },
    internetMessageId: { type: String, default: null },
    clientRequestId: { type: String },
    providerMessageId: { type: String },
    errorCode: { type: String },
    errorMessage: { type: String },
  },
  { _id: false }
);

const mailWorkflowRunSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    workflowId: { type: String, required: true },
    userId: { type: String, required: true },
    scheduledAt: { type: Date, required: true },
    status: {
      type: String,
      required: true,
      enum: ['running', 'success', 'partial_success', 'failed', 'skipped', 'unknown'],
    },
    sendState: {
      type: String,
      required: true,
      enum: ['scheduled', 'sending', 'provider_accepted', 'succeeded', 'failed', 'unknown_provider_outcome'],
      default: 'scheduled',
    },
    attemptCount: { type: Number, required: true, default: 0 },
    attempts: { type: [attemptSchema], default: [] },
    recipients: { type: [recipientSchema], default: [] },
    providerIdempotencyKey: { type: String, required: true },
    providerMessageId: { type: String },
    failureReason: { type: String },
    skipReason: { type: String },
    executorOwner: { type: String, default: null },
    executorLeaseUntil: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null },
    needsOperatorReview: { type: Boolean, default: false },
  },
  {
    collection: 'mail_workflow_runs',
    versionKey: false,
    timestamps: true,
  }
);

mailWorkflowRunSchema.index({ workflowId: 1, scheduledAt: 1 }, { unique: true });
mailWorkflowRunSchema.index({ userId: 1, status: 1, scheduledAt: 1 });
// Executor pickup scan: pending work ordered by eligibility.
mailWorkflowRunSchema.index({ sendState: 1, nextAttemptAt: 1 });
mailWorkflowRunSchema.index({ userId: 1, needsOperatorReview: 1 });
// Contact mail timeline: newest sends first for one workspace.
mailWorkflowRunSchema.index({ userId: 1, scheduledAt: -1 });

export const MailWorkflowRunModel =
  (mongoose.models.MailWorkflowRun as mongoose.Model<MailWorkflowRunDocument>) ??
  mongoose.model<MailWorkflowRunDocument>('MailWorkflowRun', mailWorkflowRunSchema);
