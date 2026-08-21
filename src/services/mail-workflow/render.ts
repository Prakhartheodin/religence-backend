import assert from 'node:assert/strict';
import { CRM_MERGE_KEYS } from './contract.js';

/**
 * Template rendering.
 *
 * Templates are authored in a plain <textarea> (see the CRM Templates page) — they are
 * plain text with {{placeholders}}, not HTML. Both the template body and the substituted
 * values are therefore escaped before being wrapped in HTML. Only the line-break markup
 * this module adds itself is real HTML.
 *
 * If a rich-text template editor is ever introduced, replace escapeHtml() in toHtml()
 * with a real allowlist sanitizer (sanitize-html or DOMPurify) rather than dropping the
 * escaping — the same rendered output feeds both the outgoing email and the browser
 * preview, which uses dangerouslySetInnerHTML.
 */

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

/**
 * Substitute placeholders into the plain-text template.
 * Output is still plain text — escaping happens in toHtml() so the subject line (which is
 * never HTML) is not double-escaped.
 */
export function applyTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key]?.trim();
    return value ? value : `[${key}]`;
  });
}

/** Plain text → safe HTML. Everything from the template is escaped; only <br> is ours. */
export function toHtml(plain: string): string {
  return `<p>${escapeHtml(plain).replace(/\r?\n/g, '<br>')}</p>`;
}

if (process.argv[1]?.endsWith('render.ts')) {
  // substitution leaves plain text alone
  assert.equal(applyTemplate('Hi {{contact_name}}', { contact_name: 'A & B' }), 'Hi A & B');
  assert.equal(applyTemplate('Hi {{contact_name}}', {}), 'Hi [contact_name]');

  // --- XSS: a template body containing markup must never reach the browser as HTML ---
  const evil = '<script>alert(1)</script>';
  assert.equal(
    toHtml(applyTemplate(evil, {})),
    '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    'template markup must be escaped',
  );
  assert.ok(!toHtml(applyTemplate(evil, {})).includes('<script'), 'no live script tag');

  // ...and neither may a value injected through a CRM field
  const injected = toHtml(applyTemplate('Hi {{contact_name}}', {
    contact_name: '<img src=x onerror=alert(1)>',
  }));
  assert.ok(!injected.includes('<img'), 'injected markup must be escaped');
  assert.ok(injected.includes('&lt;img'), 'injected markup is visible as text');

  // javascript: URLs cannot become links because no anchor markup survives
  const jsUrl = toHtml(applyTemplate('<a href="javascript:alert(1)">x</a>', {}));
  assert.ok(!jsUrl.includes('<a '), 'no anchor element is produced');

  // line breaks are still rendered
  assert.equal(toHtml('a\nb'), '<p>a<br>b</p>');
  assert.equal(toHtml('a\r\nb'), '<p>a<br>b</p>');

  assert.deepEqual(extraRequiredVars(['contact_name', 'status']), ['status']);
  assert.deepEqual(extractPlaceholders('Hi {{a}}', 'and {{b}} and {{a}}').sort(), ['a', 'b']);
  console.log('render self-check passed');
}
