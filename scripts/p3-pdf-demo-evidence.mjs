import { p3FixtureRoot, runIndependentTest, verifyProtectedInputs } from './p3-pdf-demo-lib.mjs';

const mode = process.argv[2];
if (mode !== 'baseline' && mode !== 'verify') {
  throw new Error('Usage: node scripts/p3-pdf-demo-evidence.mjs <baseline|verify>');
}
const hashes = await verifyProtectedInputs(p3FixtureRoot);
const result = await runIndependentTest(p3FixtureRoot);
const expectedExit = mode === 'baseline' ? 1 : 0;
if (
  (mode === 'baseline' && result.exitCode === 0) ||
  (mode === 'verify' && result.exitCode !== 0)
) {
  process.stderr.write(result.output);
  throw new Error(
    `${mode} evidence expected exit ${String(expectedExit)}, got ${String(result.exitCode)}.`,
  );
}
console.log(
  JSON.stringify(
    {
      fixture: 'fixtures/p3-pdf-demo',
      mode,
      protectedHashes: hashes,
      independentTestExitCode: result.exitCode,
      accepted: true,
    },
    null,
    2,
  ),
);
