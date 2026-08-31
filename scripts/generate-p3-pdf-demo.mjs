import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const fixtureRoot = path.join(repositoryRoot, 'fixtures', 'p3-pdf-demo');
const lines = [
  'SYNTHETIC DEMO TASK - no assessment content',
  'Only edit src/score-summary.mjs.',
  'Implement summarizeScores(scores).',
  'total is the sum of all scores.',
  'average is total divided by the number of scores.',
  'highest is the maximum score.',
  'For an empty array return total 0, average 0, and highest null.',
  'Do not modify requirements.pdf, tests, or package.json.',
  'Verify the result with npm test.',
];

function escapePdfText(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function buildPdf() {
  const commands = ['BT', '/F1 11 Tf', '72 740 Td'];
  for (const [index, line] of lines.entries()) {
    if (index > 0) commands.push('0 -22 Td');
    commands.push(`(${escapePdfText(line)}) Tj`);
  }
  commands.push('ET');
  const stream = deflateSync(Buffer.from(`${commands.join('\n')}\n`, 'ascii'), { level: 9 });
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      'ascii',
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${String(stream.length)} /Filter /FlateDecode >>\nstream\n`, 'ascii'),
      stream,
      Buffer.from('\nendstream', 'ascii'),
    ]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii'),
  ];
  const chunks = [Buffer.from('%PDF-1.4\n% ECHO synthetic fixture\n', 'ascii')];
  const offsets = [0];
  let length = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${String(index + 1)} 0 obj\n`, 'ascii'),
      object,
      Buffer.from('\nendobj\n', 'ascii'),
    ]);
    chunks.push(chunk);
    length += chunk.length;
  }
  const xrefOffset = length;
  const xref = [
    'xref',
    `0 ${String(objects.length + 1)}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${String(objects.length + 1)} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    '',
  ].join('\n');
  chunks.push(Buffer.from(xref, 'ascii'));
  return Buffer.concat(chunks);
}

const pdf = buildPdf();
await writeFile(path.join(fixtureRoot, 'requirements.pdf'), pdf);

const protectedFiles = ['requirements.pdf', 'test/score-summary.test.mjs', 'package.json'];
const hashes = {};
for (const relativePath of protectedFiles) {
  const content =
    relativePath === 'requirements.pdf'
      ? pdf
      : await import('node:fs/promises').then(({ readFile }) =>
          readFile(path.join(fixtureRoot, ...relativePath.split('/'))),
        );
  hashes[relativePath] = createHash('sha256').update(content).digest('hex');
}
await writeFile(
  path.join(fixtureRoot, 'evidence-lock.json'),
  `${JSON.stringify({ schemaVersion: 1, algorithm: 'sha256', files: hashes }, null, 2)}\n`,
  'utf8',
);
