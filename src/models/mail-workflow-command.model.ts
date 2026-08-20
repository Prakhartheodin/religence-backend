import mongoose from 'mongoose';
import type { WorkflowAction } from '../services/mail-workflow/contract.js';
import { CONTRACT_VERSION } from '../services/mail-workflow/contract.js';

export type MailWorkflowCommandDocument = {
  id: string;
  userId: string;
  requestId: string;
  contractVersion: typeof CONTRACT_VERSION;
  action: WorkflowAction;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  processedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const mailWorkflowCommandSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    userId: { type: String, required: true },
    requestId: { type: String, required: true },
    contractVersion: { type: String, required: true, enum: ['v1'], default: CONTRACT_VERSION },
    action: {
      type: String,
      required: true,
      enum: ['create', 'update', 'pause', 'resume', 'cancel', 'list'],
    },
    payload: { type: mongoose.Schema.Types.Mixed, required: true, default: {} },
    result: { type: mongoose.Schema.Types.Mixed, required: true, default: {} },
    processedAt: { type: Date, required: true },
  },
  {
    collection: 'mail_workflow_commands',
    versionKey: false,
    timestamps: true,
  }
);

mailWorkflowCommandSchema.index({ userId: 1, requestId: 1 }, { unique: true });

export const MailWorkflowCommandModel =
  (mongoose.models.MailWorkflowCommand as mongoose.Model<MailWorkflowCommandDocument>) ??
  mongoose.model<MailWorkflowCommandDocument>('MailWorkflowCommand', mailWorkflowCommandSchema);
