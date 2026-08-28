#!/usr/bin/env node

import { runScanCli } from './scan-lib.mjs';

await runScanCli('identity', process.argv.slice(2));
