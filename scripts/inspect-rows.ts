import { readFileSync } from 'node:fs';
import path from 'node:path';
import { read, utils } from 'xlsx';

const targets: Array<[string, number]> = [
  ['Clobetasole Propionate-buyer.xlsx', 15],
  ['Dutasteride- buyer list.xlsx', 5],
  ['Dutasteride- buyer list.xlsx', 11],
  ['MPA - buyer.xlsx', 34],
  ['MPA - buyer.xlsx', 64],
  ['MPA - buyer.xlsx', 72],
  ['Triamcinolone Acetonide - buyer.xlsx', 53],
  ['Triamcinolone Acetonide - buyer.xlsx', 59],
];

const dir = path.resolve(process.cwd(), '..', 'Excel');
for (const [file, rowNum] of targets) {
  const wb = read(readFileSync(path.join(dir, file)), { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0] ?? ''];
  const rows = utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  console.log(`--- ${file} row ${rowNum} ---`);
  console.log(JSON.stringify(rows[rowNum - 1]));
}
