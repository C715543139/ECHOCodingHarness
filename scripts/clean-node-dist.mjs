import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDist = fileURLToPath(new URL('../dist', import.meta.url));
const distRoot = process.argv[2] === undefined ? defaultDist : path.resolve(process.argv[2]);
const preserved = new Set(['config', 'web']);

if (!fs.existsSync(distRoot)) {
  process.exit(0);
}

for (const name of fs.readdirSync(distRoot)) {
  if (preserved.has(name)) {
    continue;
  }
  fs.rmSync(path.join(distRoot, name), { recursive: true, force: true });
}
