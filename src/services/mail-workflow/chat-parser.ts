import {
  WorkflowError,
  parseContract,
  type WorkflowAction,
  type WorkflowCommandContractV1,
} from './contract.js';
import {
  cancelWorkflow,
  createWorkflow,
  getWorkflow,
  listWorkflows,
  pauseWorkflow,
  resumeWorkflow,
  type MailWorkflow,
  type PreviewSummary,
} from './workflow.service.js';

export type ChatConfirm = {
  action: WorkflowAction;
  workflowId: string;
};

export type ChatMessageInput = {
  text: string;
  requestId: string;
  confirm?: ChatConfirm;
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

export type ChatMessageResult = PreviewSummary | ClarificationPrompt | CommandResult;

export async function parseUserText(
  userId: string,
  text: string,
  requestId: string,
): Promise<WorkflowCommandContractV1> {
  try {
    const raw = JSON.parse(text);
    return parseContract({ ...raw, requestId });
  } catch (err) {
    if (err instanceof WorkflowError) throw err;
    throw new WorkflowError('CONTRACT_INVALID', 'needs_clarification');
  }
}

async function resolveWorkflowId(
  userId: string,
  contract: WorkflowCommandContractV1,
): Promise<string> {
  if (contract.workflowId) return contract.workflowId;

  const all = await listWorkflows(userId);
  const matches = all.filter((wf) => {
    if (contract.action === 'pause') return wf.status === 'active';
    if (contract.action === 'resume') return wf.status === 'paused';
    if (contract.action === 'cancel') {
      return wf.status !== 'completed' && wf.status !== 'cancelled';
    }
    return false;
  });

  if (matches.length !== 1) {
    throw new WorkflowError('AMBIGUOUS_WORKFLOW', 'multiple workflows match');
  }
  return matches[0].id;
}

export async function handleChatMessage(
  userId: string,
  input: ChatMessageInput,
): Promise<ChatMessageResult> {
  const { text, requestId, confirm } = input;

  if (confirm?.workflowId) {
    const workflowId = confirm.workflowId;
    const action = confirm.action;
    if (action === 'pause') {
      return { kind: 'command_result', workflow: await pauseWorkflow(userId, workflowId, requestId) };
    }
    if (action === 'resume') {
      return { kind: 'command_result', workflow: await resumeWorkflow(userId, workflowId, requestId) };
    }
    if (action === 'cancel') {
      return { kind: 'command_result', workflow: await cancelWorkflow(userId, workflowId, requestId) };
    }
    throw new WorkflowError('CONTRACT_INVALID', 'invalid confirm action');
  }

  let contract: WorkflowCommandContractV1;
  try {
    contract = await parseUserText(userId, text, requestId);
  } catch (err) {
    if (err instanceof WorkflowError && err.message === 'needs_clarification') {
      return { kind: 'clarification_prompt', prompt: err.message };
    }
    throw err;
  }

  if (contract.action === 'create') {
    const result = await createWorkflow(userId, contract, { confirmed: false });
    if ('kind' in result && result.kind === 'preview_summary') return result;
    return { kind: 'command_result', workflow: result as MailWorkflow };
  }

  if (contract.action === 'list') {
    return { kind: 'command_result', workflows: await listWorkflows(userId) };
  }

  if (contract.action === 'pause' || contract.action === 'resume' || contract.action === 'cancel') {
    let workflowId: string;
    try {
      workflowId = await resolveWorkflowId(userId, contract);
    } catch (err) {
      if (err instanceof WorkflowError && err.code === 'AMBIGUOUS_WORKFLOW') {
        return { kind: 'clarification_prompt', prompt: err.message, code: err.code };
      }
      throw err;
    }

    if (contract.action === 'cancel') {
      await getWorkflow(userId, workflowId);
      return {
        kind: 'clarification_prompt',
        prompt: 'Confirm to cancel this workflow.',
        code: 'CONFIRMATION_REQUIRED',
        workflowId,
      };
    }

    const workflow =
      contract.action === 'pause'
        ? await pauseWorkflow(userId, workflowId, contract.requestId)
        : await resumeWorkflow(userId, workflowId, contract.requestId);
    return { kind: 'command_result', workflow };
  }

  throw new WorkflowError('CONTRACT_INVALID', 'unsupported action');
}
