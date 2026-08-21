import mongoose from 'mongoose';
import type { ExecutionMode, Frequency, WorkflowStatus } from '../services/mail-workflow/contract.js';

export type MailWorkflowSchedule = {
  frequency: Frequency;
  /** HH:mm in `timezone`. Absent for `once`. */
  timeOfDay?: string;
  /** Absolute instant for `once` schedules. */
  runAt?: Date | null;
  dayOfWeek?: number;
  dayOfMonth?: number;
  endDate?: string;
  maxRuns?: number;
};

export type MailWorkflowDocument = {
  id: string;
  userId: string;
  createdByUserId: string;
  status: WorkflowStatus;
  executionMode: ExecutionMode;
  oneTimeSendAt: Date | null;
  templateId: string;
  recipientIds: string[];
  recipientScope: 'crm_only';
  variables: Record<string, string>;
  schedule: MailWorkflowSchedule;
  timezone: string;
  accountId: string;
  nextRunAt: Date | null;
  lastRunAt?: Date;
  runCount: number;
  failureCount: number;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  lockId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const scheduleSchema = new mongoose.Schema(
  {
    frequency: { type: String, required: true, enum: ['once', 'daily', 'weekly', 'monthly'] },
    timeOfDay: { type: String },
    runAt: { type: Date, default: null },
    dayOfWeek: { type: Number },
    dayOfMonth: { type: Number },
    endDate: { type: String },
    maxRuns: { type: Number },
  },
  { _id: false }
);

const mailWorkflowSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    userId: { type: String, required: true },
    createdByUserId: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: [
        'draft_requires_auth',
        'pending_confirm',
        'active',
        'paused',
        'paused_auth_required',
        'completed',
        'cancelled',
      ],
    },
    executionMode: { type: String, required: true, enum: ['recurring', 'once'], default: 'recurring' },
    oneTimeSendAt: { type: Date, default: null },
    templateId: { type: String, required: true },
    recipientIds: { type: [String], required: true, default: [] },
    recipientScope: { type: String, required: true, enum: ['crm_only'], default: 'crm_only' },
    variables: { type: Map, of: String, default: {} },
    schedule: { type: scheduleSchema, required: true },
    timezone: { type: String, required: true },
    accountId: { type: String, required: true },
    nextRunAt: { type: Date, default: null },
    lastRunAt: { type: Date },
    runCount: { type: Number, required: true, default: 0 },
    failureCount: { type: Number, required: true, default: 0 },
    leaseOwner: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
    lockId: { type: String, default: null },
  },
  {
    collection: 'mail_workflows',
    versionKey: false,
    timestamps: true,
  }
);

mailWorkflowSchema.index({ status: 1, nextRunAt: 1 });
mailWorkflowSchema.index({ userId: 1, status: 1, nextRunAt: 1 });
mailWorkflowSchema.index({ userId: 1, status: 1, leaseUntil: 1 });
mailWorkflowSchema.index({ userId: 1, id: 1 }, { unique: true });

export const MailWorkflowModel =
  (mongoose.models.MailWorkflow as mongoose.Model<MailWorkflowDocument>) ??
  mongoose.model<MailWorkflowDocument>('MailWorkflow', mailWorkflowSchema);
