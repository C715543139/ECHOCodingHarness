import { Command } from 'commander';

import { PROJECT_NAME, PROJECT_TAGLINE, PROJECT_VERSION } from '../core/project.js';

export interface CreateCliOptions {
  readonly version?: string;
}

export function createCli(options: CreateCliOptions = {}): Command {
  return new Command()
    .name('echo-harness')
    .description(`${PROJECT_NAME}: ${PROJECT_TAGLINE}`)
    .version(options.version ?? PROJECT_VERSION);
}
