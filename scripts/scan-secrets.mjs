#!/usr/bin/env node

import { runScanCli } from './scan-lib.mjs';

await runScanCli('secrets', process.argv.slice(2));
