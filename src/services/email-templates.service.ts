import { HttpError } from '../http-error.js';
import { EmailTemplateSetModel } from '../models/email-template.model.js';

export type EmailTemplateCategory = 'introduction' | 'follow-up' | 'quotation';

export type EmailTemplateRecord = {
  id: string;
  name: string;
  description: string;
  category: EmailTemplateCategory;
  subject: string;
  body: string;
};

const DEFAULT_EMAIL_TEMPLATES: EmailTemplateRecord[] = [
  {
    id: 'first-intro',
    name: 'First Introduction',
    description: 'Initial outreach when a lead is verified or newly assigned.',
    category: 'introduction',
    subject: 'Partnership opportunity - {{salt_name}} for {{company_name}}',
    body: `Dear {{contact_name}},

We are reaching out regarding {{medicine_name}} ({{dosage_form}}) and your work with {{salt_name}}.

We would welcome a short call to explore supply and co-development options.

Best regards,
{{sender_name}}`,
  },
  {
    id: 'salt-outreach',
    name: 'Salt-specific Outreach',
    description: 'Highlights matched API salt and dosage form for the company.',
    category: 'introduction',
    subject: '{{salt_name}} formulations - introduction from {{sender_name}}',
    body: `Hi {{contact_name}},

Our team supports manufacturers and marketers active in {{salt_name}}, including {{medicine_name}}.

If {{company_name}} is evaluating partners for {{dosage_form}} products, we can share our portfolio and certifications.

Regards,
{{sender_name}}`,
  },
  {
    id: 'follow-up-1',
    name: 'Follow-up 1',
    description: 'Second touch after intro email with no reply.',
    category: 'follow-up',
    subject: 'Re: {{medicine_name}} - following up',
    body: `Dear {{contact_name}},

I wanted to follow up on my earlier note about {{salt_name}} / {{medicine_name}}.

Please let us know if you would like product details or samples.

Thanks,
{{sender_name}}`,
  },
  {
    id: 'quotation-follow-up',
    name: 'Quotation Follow-up',
    description: 'Reminder after quotation or sample request stage.',
    category: 'quotation',
    subject: 'Quotation follow-up - {{company_name}}',
    body: `Hi {{contact_name}},

Sharing a gentle reminder on the quotation we sent for {{medicine_name}}.

Happy to clarify MOQ, lead times, or documentation.

Best,
{{sender_name}}`,
  },
];

function cloneTemplates(input: EmailTemplateRecord[]): EmailTemplateRecord[] {
  return input.map((tpl) => ({ ...tpl }));
}

function isCategory(value: string): value is EmailTemplateCategory {
  return value === 'introduction' || value === 'follow-up' || value === 'quotation';
}

function parseTemplate(input: unknown, index: number): EmailTemplateRecord {
  if (!input || typeof input !== 'object') {
    throw new HttpError(400, `templates[${index}] must be an object`);
  }
  const raw = input as Record<string, unknown>;
  const id = String(raw.id ?? '').trim();
  const name = String(raw.name ?? '').trim();
  const description = String(raw.description ?? '').trim();
  const subject = String(raw.subject ?? '');
  const body = String(raw.body ?? '');
  const category = String(raw.category ?? '').trim();

  if (!id) throw new HttpError(400, `templates[${index}].id is required`);
  if (!name) throw new HttpError(400, `templates[${index}].name is required`);
  if (!isCategory(category)) {
    throw new HttpError(
      400,
      `templates[${index}].category must be introduction, follow-up, or quotation`
    );
  }

  return {
    id,
    name,
    description,
    subject,
    body,
    category,
  };
}

export async function listEmailTemplates(userId: string): Promise<EmailTemplateRecord[]> {
  const seededTemplates = cloneTemplates(DEFAULT_EMAIL_TEMPLATES);

  // createdAt/updatedAt are mongoose-managed (timestamps: true).
  const doc = await EmailTemplateSetModel.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId, templates: seededTemplates } },
    { upsert: true, returnDocument: 'after', lean: true }
  );

  return cloneTemplates(doc?.templates ?? seededTemplates);
}

export async function replaceEmailTemplates(
  userId: string,
  templatesInput: unknown
): Promise<EmailTemplateRecord[]> {
  if (!Array.isArray(templatesInput)) {
    throw new HttpError(400, 'templates must be an array');
  }
  if (templatesInput.length === 0) {
    throw new HttpError(400, 'templates must include at least one template');
  }

  const parsed = templatesInput.map((item, index) => parseTemplate(item, index));
  const dedup = new Set<string>();
  for (const tpl of parsed) {
    if (dedup.has(tpl.id)) {
      throw new HttpError(400, `duplicate template id: ${tpl.id}`);
    }
    dedup.add(tpl.id);
  }

  const saved = await EmailTemplateSetModel.findOneAndUpdate(
    { userId },
    {
      $set: { templates: cloneTemplates(parsed) },
      $setOnInsert: { userId },
    },
    { upsert: true, returnDocument: 'after', lean: true, timestamps: true }
  );

  return cloneTemplates(saved?.templates ?? parsed);
}
