import assert from 'node:assert/strict';
import { CRM_MERGE_KEYS } from './contract.js';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string
  ));
}

export function extractPlaceholders(subject: string, body: string): string[] {
  const found = new Set<string>();
  for (const m of `${subject}\n${body}`.matchAll(/\{\{(\w+)\}\}/g)) found.add(m[1]);
  return [...found];
}

export function extraRequiredVars(placeholders: string[]): string[] {
  const merge = new Set<string>(CRM_MERGE_KEYS);
  return placeholders.filter((p) => !merge.has(p));
}

export function leadVars(lead: {
  companyName?: string; contactName?: string; matchedSalt?: string;
  matchedMedicine?: string; dosageForm?: string;
}, senderName: string): Record<string, string> {
  return {
    company_name: lead.companyName ?? '',
    contact_name: lead.contactName ?? '',
    salt_name: lead.matchedSalt ?? '',
    medicine_name: lead.matchedMedicine ?? '',
    dosage_form: lead.dosageForm ?? '',
    sender_name: senderName,
  };
}

export function applyTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key]?.trim();
    if (value) return escapeHtml(value);
    return `[${key}]`;
  });
}

export function toHtml(plain: string): string {
  return `<p>${plain.replace(/\n/g, '<br>')}</p>`;
}

if (process.argv[1]?.endsWith('render.ts')) {
  assert.equal(
    applyTemplate('Hi {{contact_name}} <x>', { contact_name: 'A & B' }),
    'Hi A &amp; B <x>',
  );
  assert.deepEqual(extraRequiredVars(['contact_name', 'status']), ['status']);
  console.log('render self-check passed');
}
