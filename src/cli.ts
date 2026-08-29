#!/usr/bin/env node

import { CommanderError } from 'commander';

import { createCli } from './cli/create-cli.js';

try {
  await createCli().exitOverride().parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode =
      error.code === 'commander.helpDisplayed' || error.code === 'commander.version' ? 0 : 2;
  } else {
    throw error;
  }
}
