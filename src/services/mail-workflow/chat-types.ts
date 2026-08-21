import type { MailWorkflow, PreviewSummary } from './workflow.service.js';
import type { WorkflowAction } from './contract.js';

/** `schedule` confirms the pending create draft; the rest confirm a workflow action. */
export type ChatConfirm = {
  action: WorkflowAction | 'schedule';
  workflowId?: string;
};

export type ChatMessageInput = {
  text: string;
  requestId: string;
  confirm?: ChatConfirm;
  choiceId?: string;
};

export type AssistantChoice = {
  id: string;
  label: string;
  sublabel?: string;
};

export type AssistantConfirmAction = {
  type: 'schedule' | 'update' | 'pause' | 'resume' | 'cancel';
  workflowId?: string;
  label: string;
};

export type AssistantMessage = {
  kind: 'assistant_message';
  message: string;
  suggestions?: string[];
  choices?: AssistantChoice[];
  preview?: PreviewSummary;
  connectInbox?: boolean;
  confirmAction?: AssistantConfirmAction;
  workflows?: MailWorkflow[];
};

export type ClarificationPrompt = {
  kind: 'clarification_prompt';
  prompt: string;
  code?: string;
  workflowId?: string;
};

export type CommandResult = {
  kind: 'command_result';
  workflow?: MailWorkflow;
  workflows?: MailWorkflow[];
};

export type ChatMessageResult =
  | AssistantMessage
  | PreviewSummary
  | ClarificationPrompt
  | CommandResult;

export type ChatMessageResponse = {
  result: ChatMessageResult;
  exchange: {
    user: { id: string; text: string; createdAt: string } | null;
    assistant: { id: string; response: ChatMessageResult; createdAt: string };
  };
};
