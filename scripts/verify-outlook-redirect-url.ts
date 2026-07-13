import { buildFrontendUrl, normalizeBaseUrl } from '../src/lib/normalize-url.js';

const cases = [
  {
    label: 'comma-separated host + https URL (reported prod bug)',
    raw: 'crm.religence.in,https://crm.religence.in',
  },
  {
    label: 'host only without scheme',
    raw: 'crm.religence.in',
  },
  {
    label: 'httpss typo',
    raw: 'httpss://crm.religence.in',
  },
  {
    label: 'valid localhost default',
    raw: 'http://localhost:3000',
  },
];

let failed = 0;

for (const testCase of cases) {
  const base = normalizeBaseUrl(testCase.raw, 'http://localhost:3000');
  const redirect = buildFrontendUrl(base, '/inbox', {
    outlook_connected: 'developers@dharwinbusinesssolutions.com',
  });

  const ok =
    redirect.startsWith('https://') || redirect.startsWith('http://localhost');
  const hasComma = redirect.includes(',');
  const hasTypo = redirect.includes('httpss://');

  console.log(`\n[${testCase.label}]`);
  console.log(`  input:    ${testCase.raw}`);
  console.log(`  base:     ${base}`);
  console.log(`  redirect: ${redirect}`);

  if (!ok || hasComma || hasTypo) {
    console.log('  status:   FAIL');
    failed += 1;
  } else {
    console.log('  status:   OK');
  }
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}

console.log('\nAll redirect URL cases passed.');
