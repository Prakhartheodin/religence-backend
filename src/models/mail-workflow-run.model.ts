import mongoose from 'mongoose';
import type { RunStatus } from '../services/mail-workflow/contract.js';

export type MailWorkflowRunAttempt = {
  at: Date;
  errorCode?: string;
  errorMessage?: string;
  retriable: boolean;
};

export type MailWorkflowRunDocument = {
  id: string;
  workflowId: string;
  userId: string;
  scheduledAt: Date;
  status: RunStatus;
  attemptCount: number;
  attempts: MailWorkflowRunAttempt[];
  providerIdempotencyKey: string;
  providerMessageId?: string;
  failureReason?: string;
  skipReason?: string;
  createdAt: Date;
  updatedAt: Date;
};

const attemptSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    errorCode: { type: String },
    errorMessage: { type: String },
    retriable: { type: Boolean, required: true },
  },
  { _id: false }
);

const mailWorkflowRunSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    workflowId: { type: String, required: true },
    userId: { type: String, required: true },
    scheduledAt: { type: Date, required: true },
    status: { type: String, required: true, enum: ['running', 'success', 'failed', 'skipped'] },
    attemptCount: { type: Number, required: true, default: 0 },
    attempts: { type: [attemptSchema], default: [] },
    providerIdempotencyKey: { type: String, required: true },
    providerMessageId: { type: String },
    failureReason: { type: String },
    skipReason: { type: String },
  },
  {
    collection: 'mail_workflow_runs',
    versionKey: false,
    timestamps: true,
  }
);

mailWorkflowRunSchema.index({ workflowId: 1, scheduledAt: 1 }, { unique: true });
mailWorkflowRunSchema.index({ userId: 1, status: 1, scheduledAt: 1 });

export const MailWorkflowRunModel =
  (mongoose.models.MailWorkflowRun as mongoose.Model<MailWorkflowRunDocument>) ??
  mongoose.model<MailWorkflowRunDocument>('MailWorkflowRun', mailWorkflowRunSchema);
