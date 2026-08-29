#!/usr/bin/env node

import { CommanderError } from 'commander';

import { resolveArtifactRootFromEntry } from './config/artifact-root.js';
import { createCli } from './cli/create-cli.js';

try {
  await createCli({
    artifactRoot: resolveArtifactRootFromEntry(import.meta.url),
  })
    .exitOverride()
    .parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode =
      error.code === 'commander.helpDisplayed' || error.code === 'commander.version' ? 0 : 2;
  } else {
    throw error;
  }
}
