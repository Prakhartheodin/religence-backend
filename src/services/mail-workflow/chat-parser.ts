import assert from 'node:assert/strict';
import config from '../../config.js';
import { CrmEntities } from '../../models/crm-entities.js';
import { listEmailTemplates } from '../email-templates.service.js';
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

type ParseUserTextDeps = {
  complete?: (prompt: string) => Promise<unknown>;
};

async function buildLlmContext(userId: string): Promise<{
  templates: Array<{ id: string; name: string; description: string }>;
  leads: Array<{ id: string; contactName: string; companyName: string }>;
}> {
  const [templates, leads] = await Promise.all([
    listEmailTemplates(userId),
    CrmEntities.leads
      .find({ userId })
      .sort({ _order: -1 })
      .limit(200)
      .select('id contactName companyName')
      .lean(),
  ]);

  return {
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      description: String(t.description ?? ''),
    })),
    leads: leads.map((lead) => ({
      id: String(lead.id ?? ''),
      contactName: String(lead.contactName ?? ''),
      companyName: String(lead.companyName ?? ''),
    })),
  };
}

function buildSystemPrompt(ctx: {
  templates: Array<{ id: string; name: string; description: string }>;
  leads: Array<{ id: string; contactName: string; companyName: string }>;
}): string {
  return [
    'You are a mail workflow assistant. Return JSON only matching WorkflowCommandContractV1.',
    'Fields: version ("v1"), action (create|update|pause|resume|cancel|list), workflowId?, templateId?, recipientIds?, schedule?, variables?, confidence (0-1), requestId.',
    'recipientIds must be lead ids from the leads list. templateId must be from the templates list.',
    'Do not include timezone. schedule.time is HH:mm. weekly uses dayOfWeek ISO 1-7.',
    `Templates: ${JSON.stringify(ctx.templates)}`,
    `Leads: ${JSON.stringify(ctx.leads)}`,
  ].join('\n');
}

async function completeLlm(userId: string, text: string): Promise<unknown> {
  const { apiKey, baseUrl, model } = config.chatLlm;
  if (!apiKey) {
    throw new WorkflowError('CONTRACT_INVALID', 'Mail assistant is not configured (CHAT_LLM_API_KEY).');
  }

  const ctx = await buildLlmContext(userId);
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildSystemPrompt(ctx) },
        { role: 'user', content: text },
      ],
    }),
  });

  if (!res.ok) {
    throw new WorkflowError('CONTRACT_INVALID', 'needs_clarification');
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new WorkflowError('CONTRACT_INVALID', 'needs_clarification');
  }
  return JSON.parse(content);
}

export async function parseUserText(
  userId: string,
  text: string,
  requestId: string,
  deps: ParseUserTextDeps = {},
): Promise<WorkflowCommandContractV1> {
  try {
    let raw: unknown;
    if (deps.complete) {
      raw = await deps.complete(text);
    } else if (!config.chatLlm.apiKey) {
      throw new WorkflowError('CONTRACT_INVALID', 'Mail assistant is not configured (CHAT_LLM_API_KEY).');
    } else {
      raw = await completeLlm(userId, text);
    }
    return parseContract({ ...(raw as object), requestId });
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

if (process.argv[1]?.endsWith('chat-parser.ts')) {
  const json = {
    version: 'v1' as const,
    action: 'create' as const,
    templateId: 'follow-up-1',
    recipientIds: ['abc'],
    schedule: { frequency: 'weekly' as const, time: '17:00', dayOfWeek: 5 },
    variables: {},
    confidence: 0.95,
    requestId: 'ignored',
  };

  void (async () => {
    const c = await parseUserText('u', 'hello', 'client-req', { complete: async () => json });
    assert.equal(c.requestId, 'client-req');
    assert.equal(c.schedule?.dayOfWeek, 5);
    console.log('chat-parser self-check passed');
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
