import assert from 'node:assert/strict';
import { HttpError } from '../http-error.js';
import { normalizeMailAttachments } from './mail-attachments.js';

assert.equal(normalizeMailAttachments().length, 0);
assert.equal(normalizeMailAttachments([{ contentBytes: '' }]).length, 0);
assert.deepEqual(normalizeMailAttachments([{ contentBytes: 'abc', name: 'a.txt' }]), [
  { name: 'a.txt', contentType: 'application/octet-stream', contentBytes: 'abc' },
]);
assert.throws(
  () => normalizeMailAttachments([{ contentBytes: 'x'.repeat(4 * 1024 * 1024 + 1) }]),
  (err: unknown) => err instanceof HttpError && err.status === 413
);
console.log('test_mail_attachments: ok');
