import assert from 'node:assert/strict';
import type { WorkflowAction } from './contract.js';
import type { AssistantMessage } from './chat-types.js';

export type SlashCommandDef = {
  command: string;
  description: string;
};

/** Slash commands backed by handleChatMessage / handleManagementAction. */
export const SLASH_COMMANDS: SlashCommandDef[] = [
  { command: '/create', description: 'Schedule a new recurring or one-time email' },
  { command: '/send', description: 'Send an email once, now or at a set time' },
  { command: '/list', description: 'Show your scheduled emails' },
  { command: '/pause', description: 'Pause a recurring email (optional name hint)' },
  { command: '/resume', description: 'Resume a paused email (optional name hint)' },
  { command: '/cancel', description: 'Cancel a scheduled email (optional name hint)' },
  { command: '/help', description: 'Show available commands' },
];

export type SlashParseResult =
  | { kind: 'unknown'; command: string }
  | { kind: 'help' }
  | { kind: 'create'; arguments?: string }
  | { kind: 'send'; arguments?: string }
  | { kind: 'action'; action: Extract<WorkflowAction, 'list' | 'pause' | 'resume' | 'cancel'>; hint?: string };

export function slashCommandToken(text: string): string {
  const trimmed = text.trim();
  const spaceIdx = trimmed.indexOf(' ');
  const token = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  return token.toLowerCase();
}

/** Unique prefix → full command (e.g. /cre → /create). Null if ambiguous or no match. */
export function resolveSlashCommandPrefix(text: string): string | null {
  const token = slashCommandToken(text);
  if (!token.startsWith('/')) return null;
  if (SLASH_COMMANDS.some((c) => c.command === token)) return token;

  const matches = SLASH_COMMANDS.filter((c) => c.command.startsWith(token));
  return matches.length === 1 ? matches[0].command : null;
}

export function isPartialSlashCommand(text: string): boolean {
  const token = slashCommandToken(text);
  if (!token.startsWith('/')) return false;
  if (SLASH_COMMANDS.some((c) => c.command === token)) return false;
  return SLASH_COMMANDS.some((c) => c.command.startsWith(token));
}

function resolveSlashCommand(command: string, rest?: string): SlashParseResult {
  const hint = rest?.trim() || undefined;
  switch (command) {
    case '/help':
      return { kind: 'help' };
    case '/create':
      return { kind: 'create', arguments: hint };
    case '/send':
      return { kind: 'send', arguments: hint };
    case '/list':
      return { kind: 'action', action: 'list' };
    case '/pause':
      return { kind: 'action', action: 'pause', hint };
    case '/resume':
      return { kind: 'action', action: 'resume', hint };
    case '/cancel':
      return { kind: 'action', action: 'cancel', hint };
    default:
      return { kind: 'unknown', command };
  }
}

export function parseSlashCommand(text: string): SlashParseResult | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const match = trimmed.match(/^\/(\S+)(?:\s+(.*))?$/s);
  if (!match) return null;

  const [, rawCmd, rest] = match;
  const token = `/${rawCmd.toLowerCase()}`;

  if (SLASH_COMMANDS.some((c) => c.command === token)) {
    return resolveSlashCommand(token, rest);
  }

  const prefixMatches = SLASH_COMMANDS.filter((c) => c.command.startsWith(token));
  if (prefixMatches.length === 1) {
    return resolveSlashCommand(prefixMatches[0].command, rest);
  }
  if (prefixMatches.length > 1) {
    return null;
  }

  return { kind: 'unknown', command: token };
}

export function slashHelpMessage(): AssistantMessage {
  const lines = SLASH_COMMANDS.map((c) => `**${c.command}** — ${c.description}`);
  return {
    kind: 'assistant_message',
    message: [
      'Available commands:',
      '',
      ...lines,
      '',
      'You can also describe what you want in plain language.',
    ].join('\n'),
  };
}

export function slashUnknownMessage(command: string): AssistantMessage {
  return {
    kind: 'assistant_message',
    message: `Unknown command ${command}. Type \`/help\` for available commands.`,
  };
}

export function slashCreateMessage(): AssistantMessage {
  return {
    kind: 'assistant_message',
    message:
      'Sure — what would you like to schedule? For example: Send the Follow-up 1 template to Prakhar every day at 2 PM.',
    suggestions: ['Send the Follow-up 1 template to Prakhar every day at 2 PM.'],
  };
}

export function slashSendMessage(): AssistantMessage {
  return {
    kind: 'assistant_message',
    message:
      "Sure — a one-time send. Which template should I use, and who is it going to? I'll send it as soon as you confirm, or tell me a time.",
    suggestions: ['Send the Follow-up 1 template to Prakhar now.'],
  };
}

if (process.argv[1]?.endsWith('slash-commands.ts')) {
  assert.equal(parseSlashCommand('/help')?.kind, 'help');
  assert.equal(parseSlashCommand('/list')?.kind, 'action');
  assert.deepEqual(parseSlashCommand('/pause weekly update'), {
    kind: 'action',
    action: 'pause',
    hint: 'weekly update',
  });
  assert.equal(parseSlashCommand('hello'), null);
  assert.equal(parseSlashCommand('/edit')?.kind, 'unknown');

  // /send is a first-class command
  assert.equal(parseSlashCommand('/send')?.kind, 'send');
  assert.deepEqual(parseSlashCommand('/send follow up to Prakhar'), {
    kind: 'send',
    arguments: 'follow up to Prakhar',
  });

  // adding /send makes /s ambiguous with nothing, but /se unique
  assert.equal(parseSlashCommand('/se')?.kind, 'send');
  assert.equal(parseSlashCommand('/cre')?.kind, 'create');
  assert.equal(parseSlashCommand('/crea')?.kind, 'create');
  const pausePrefix = parseSlashCommand('/pa');
  assert.equal(pausePrefix?.kind, 'action');
  if (pausePrefix?.kind === 'action') assert.equal(pausePrefix.action, 'pause');

  assert.deepEqual(parseSlashCommand('/create a follow up to prakhar sharma'), {
    kind: 'create',
    arguments: 'a follow up to prakhar sharma',
  });
  assert.equal(parseSlashCommand('/create')?.kind, 'create');
  assert.equal(parseSlashCommand('/c'), null, '/c is ambiguous (create/cancel)');
  assert.equal(resolveSlashCommandPrefix('/cre'), '/create');
  assert.equal(resolveSlashCommandPrefix('/s'), '/send', '/s uniquely resolves to /send');
  assert.equal(isPartialSlashCommand('/cre'), true);
  assert.equal(isPartialSlashCommand('/create'), false);
  console.log('slash-commands self-check passed');
}
