#!/usr/bin/env node

import { createCli } from './cli/create-cli.js';

await createCli().parseAsync(process.argv);
