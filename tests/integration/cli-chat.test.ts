import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { ScriptedChatInput } from '../../src/cli/chat-input-reader.js';
import { runChat } from '../../src/cli/chat.js';
import type { ChatModelCatalog, ChatModelCatalogSnapshot } from '../../src/cli/model-candidates.js';
import { sessionShortId } from '../../src/cli/session-id.js';
import type { EchoEvent, ModelProvider, ModelStreamEvent } from '../../src/contracts/index.js';
import { FakeProvider } from '../../src/provider/index.js';
import { cancellationError } from '../../src/provider/errors.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-cli-chat-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeArtifactConfig(
  artifactRoot: string,
  catalog: 'discover' | 'manual' = 'manual',
): Promise<void> {
  await fs.mkdir(path.join(artifactRoot, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(artifactRoot, 'config', 'echo.config.json'),
    JSON.stringify({
      baseUrl: 'https://provider.example/v1',
      model: 'fake-model',
      modelCatalog:
        catalog === 'discover'
          ? { source: 'discover' }
          : { source: 'manual', models: ['fake-model', 'other-model'] },
      safetyMode: 'balanced',
    }),
    'utf8',
  );
}

function output() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      writeStdout: (text: string) => {
        stdout += text;
      },
      writeStderr: (text: string) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function sessionFiles(root: string): Promise<string[]> {
  return fs.readdir(path.join(root, '.echo', 'sessions'));
}

async function readEvents(root: string): Promise<EchoEvent[]> {
  const files = await sessionFiles(root);
  const log = await fs.readFile(path.join(root, '.echo', 'sessions', files[0] as string), 'utf8');
  return log
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EchoEvent);
}

describe('CLI chat integration', () => {
  it('shows approval choices on stderr before reading input and does not submit the choice as chat', async () => {
    const root = await workspace();
    await writeArtifactConfig(root);
    const provider = new FakeProvider([
      {
        events: [
          {
            type: 'tool_call',
            call: {
              id: 'call-version',
              name: 'run_command',
              arguments: { command: 'node --version' },
            },
          },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'version checked' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const approvalInput = new PassThrough();
    let stdout = '';
    let stderr = '';
    let answered = false;
    const approvalOutput = new Writable({
      write(chunk, _encoding, callback) {
        stderr += String(chunk);
        if (!answered && stderr.includes('Approve [y] once / [s] session / [n] deny')) {
          answered = true;
          queueMicrotask(() => approvalInput.write('y\n'));
        }
        callback();
      },
    });

    const outcome = await runChat(
      {
        workspace: root,
        verbose: false,
        color: false,
        interactive: true,
        artifactRoot: root,
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: {
          writeStdout: (text) => {
            stdout += text;
          },
          writeStderr: (text) => {
            stderr += text;
          },
        },
        providerFactory: () => provider,
        input: new ScriptedChatInput([
          { kind: 'batch', text: 'check the version', source: 'typed' },
          { kind: 'batch', text: '/quit', source: 'typed' },
        ]),
        stdin: approvalInput,
        stderr: approvalOutput,
      },
    );

    expect(outcome.exitCode).toBe(0);
    expect(answered).toBe(true);
    expect(stderr).toContain('Approve [y] once / [s] session / [n] deny');
    expect(stdout).not.toContain('Approve [y] once / [s] session / [n] deny');
    expect(provider.requests).toHaveLength(2);
    expect(
      provider.requests.some((request) =>
        request.messages.some((message) => message.role === 'user' && message.content === 'y'),
      ),
    ).toBe(false);
  });

  it('runs Fake Provider turns, slash commands, empty input, and paste without slash injection', async () => {
    const root = await workspace();
    await writeArtifactConfig(root);
    const provider = new FakeProvider([
      {
        events: [
          { type: 'text_delta', delta: 'first reply' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'paste reply' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'after model switch' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const captured = output();
    const outcome = await runChat(
      {
        workspace: root,
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot: root,
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: captured.io,
        providerFactory: () => provider,
        input: new ScriptedChatInput([
          { kind: 'batch', text: '   ', source: 'typed' },
          { kind: 'batch', text: '/help', source: 'typed' },
          { kind: 'batch', text: 'first goal', source: 'typed' },
          { kind: 'batch', text: '/help', source: 'paste' },
          { kind: 'batch', text: '/model other-model', source: 'typed' },
          { kind: 'batch', text: '/safety safe', source: 'typed' },
          { kind: 'batch', text: 'second goal', source: 'typed' },
          { kind: 'batch', text: '/quit', source: 'typed' },
        ]),
      },
    );

    expect(outcome.exitCode).toBe(0);
    expect(captured.stderr()).toContain('ECHO Harness · chat');
    expect(captured.stderr()).toContain('YOU > ');
    expect(captured.stderr()).toContain('HELP');
    expect(captured.stderr()).toContain('/model refresh');
    expect(captured.stderr()).toContain('ECHO       | first reply');
    expect(captured.stderr()).toContain('paste reply');
    expect(captured.stderr()).toContain('Turn completed');
    expect(captured.stderr()).toContain('Applies to the next turn.');
    expect(captured.stderr()).not.toContain('test-key');
    expect(provider.requests).toHaveLength(3);
    expect(
      provider.requests.some((request) =>
        request.messages.some((message) => message.role === 'user' && message.content === '/help'),
      ),
    ).toBe(true);
    expect(provider.requests[2]?.model).toBe('other-model');
    const events = await readEvents(root);
    expect(events.some((event) => event.type === 'model.changed')).toBe(true);
    expect(events.some((event) => event.type === 'safety.changed')).toBe(true);
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(3);
  });

  it('resumes the same session with CLI model override and reconstructs from events', async () => {
    const root = await workspace();
    await writeArtifactConfig(root);
    const provider = new FakeProvider([
      {
        events: [
          { type: 'text_delta', delta: 'one' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'two' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    await runChat(
      {
        workspace: root,
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot: root,
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: output().io,
        providerFactory: () => provider,
        input: new ScriptedChatInput([
          { kind: 'batch', text: 'first', source: 'typed' },
          { kind: 'batch', text: '/quit', source: 'typed' },
        ]),
      },
    );
    const files = await sessionFiles(root);
    const sessionId = files[0]?.replace(/\.jsonl$/u, '') ?? '';
    const captured = output();
    const resumed = await runChat(
      {
        workspace: root,
        resume: sessionShortId(sessionId),
        model: 'resume-model',
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot: root,
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: captured.io,
        providerFactory: () => provider,
        input: new ScriptedChatInput([
          { kind: 'batch', text: '/status', source: 'typed' },
          { kind: 'batch', text: 'continue', source: 'typed' },
          { kind: 'batch', text: '/quit', source: 'typed' },
        ]),
      },
    );
    expect(resumed.exitCode).toBe(0);
    expect(captured.stderr()).toContain('ECHO Harness · resumed session');
    expect(captured.stderr()).toContain('Session status');
    expect(captured.stderr()).toMatch(/\n-- Session status /u);
    expect(captured.stderr()).toMatch(/API KEY\s+\|\s+configured\n\n/u);
    expect(captured.stderr()).toContain('cli');
    expect(provider.requests[1]?.model).toBe('resume-model');
    expect(provider.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'first' }),
        expect.objectContaining({ role: 'user', content: 'continue' }),
        expect.objectContaining({ role: 'assistant', content: 'one' }),
      ]),
    );
    const events = await readEvents(root);
    expect(events.some((event) => event.type === 'session.resumed')).toBe(true);
  });

  it('cancels an in-flight turn on interrupt and returns to the idle prompt', async () => {
    const root = await workspace();
    await writeArtifactConfig(root);
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const hanging: ModelProvider = {
      name: 'hang',
      stream(_request, options) {
        notifyStarted();
        async function* generate(): AsyncGenerator<ModelStreamEvent> {
          await new Promise<void>((_resolve, reject) => {
            if (options.signal.aborted) {
              reject(cancellationError('cancelled'));
              return;
            }
            options.signal.addEventListener(
              'abort',
              () => {
                reject(cancellationError('cancelled'));
              },
              { once: true },
            );
          });
          yield { type: 'completed', finishReason: 'stop' };
        }
        return generate();
      },
    };
    let fire: (() => void) | undefined;
    const captured = output();
    const running = runChat(
      {
        workspace: root,
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot: root,
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: captured.io,
        providerFactory: () => hanging,
        input: new ScriptedChatInput([
          { kind: 'batch', text: 'hang please', source: 'typed' },
          { kind: 'batch', text: '/quit', source: 'typed' },
        ]),
        attachInterrupt: (handler) => {
          fire = handler;
          return () => {
            fire = undefined;
          };
        },
      },
    );
    await started;
    fire?.();
    const outcome = await running;
    expect(outcome.exitCode).toBe(0);
    expect(captured.stderr()).toContain('Turn cancelled');
    const events = await readEvents(root);
    expect(events.some((event) => event.type === 'turn.cancelled')).toBe(true);
  });

  it('exits 130 on idle interrupt and 2 when config or resume is missing', async () => {
    const root = await workspace();
    await writeArtifactConfig(root);
    const idle = await runChat(
      {
        workspace: root,
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot: root,
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: output().io,
        providerFactory: () => new FakeProvider([]),
        input: new ScriptedChatInput([{ kind: 'interrupt' }]),
      },
    );
    expect(idle.exitCode).toBe(130);

    const missingConfig = output();
    const noConfig = await runChat(
      {
        workspace: root,
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot: path.join(root, 'missing-artifact'),
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: missingConfig.io,
        cwd: root,
      },
    );
    expect(noConfig.exitCode).toBe(2);
    expect(missingConfig.stderr()).toContain('echo-harness config');

    await fs.mkdir(path.join(root, 'missing-artifact', 'config'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'missing-artifact', 'config', 'echo.config.json'),
      JSON.stringify({
        baseUrl: 'https://provider.example/v1',
        model: 'fake-model',
        modelCatalog: { source: 'discover' },
        safetyMode: 'balanced',
      }),
      'utf8',
    );
    const resumeMissing = output();
    const missingSession = await runChat(
      {
        workspace: root,
        resume: 'session-missing',
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot: path.join(root, 'missing-artifact'),
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: resumeMissing.io,
        cwd: root,
        providerFactory: () => new FakeProvider([]),
      },
    );
    expect(missingSession.exitCode).toBe(2);
    expect(resumeMissing.stderr()).toContain('does not exist');

    const invalidResume = output();
    const invalidSession = await runChat(
      {
        workspace: root,
        resume: '../bad',
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot: path.join(root, 'missing-artifact'),
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: invalidResume.io,
        cwd: root,
        providerFactory: () => new FakeProvider([]),
      },
    );
    expect(invalidSession.exitCode).toBe(2);
    expect(invalidResume.stderr()).toContain('not valid');

    const backslashResume = output();
    const backslashSession = await runChat(
      {
        workspace: root,
        resume: '..\\bad',
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot: path.join(root, 'missing-artifact'),
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: backslashResume.io,
        cwd: root,
        providerFactory: () => new FakeProvider([]),
      },
    );
    expect(backslashSession.exitCode).toBe(2);
    expect(backslashResume.stderr()).toContain('not valid');

    const blankResume = output();
    const blankSession = await runChat(
      {
        workspace: root,
        resume: '   ',
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot: path.join(root, 'missing-artifact'),
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: blankResume.io,
        cwd: root,
        providerFactory: () => new FakeProvider([]),
      },
    );
    expect(blankSession.exitCode).toBe(2);
    expect(blankResume.stderr()).toContain('not valid');
  });

  it('does not render a blank ECHO when the model only returns reasoning', async () => {
    const root = await workspace();
    await writeArtifactConfig(root);
    const provider = new FakeProvider([
      {
        events: [
          { type: 'reasoning_delta', delta: { reasoning: 'hidden thought' } },
          { type: 'completed', finishReason: 'length' },
        ],
      },
    ]);
    const captured = output();
    const outcome = await runChat(
      {
        workspace: root,
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot: root,
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: captured.io,
        providerFactory: () => provider,
        input: new ScriptedChatInput([
          { kind: 'batch', text: 'analyze this', source: 'typed' },
          { kind: 'batch', text: '/quit', source: 'typed' },
        ]),
      },
    );
    expect(outcome.exitCode).toBe(0);
    expect(captured.stderr()).toContain('Turn failed');
    expect(captured.stderr()).toContain('provider_error');
    expect(captured.stderr()).not.toMatch(/ECHO\s+\|\s*$/m);
    expect(captured.stderr()).not.toContain('hidden thought');
  });

  it('repairs a dangling turn on resume and accepts non-TTY line input', async () => {
    const root = await workspace();
    await writeArtifactConfig(root, 'discover');
    const provider = new FakeProvider([
      {
        events: [
          { type: 'text_delta', delta: 'recovered' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    await runChat(
      {
        workspace: root,
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot: root,
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: output().io,
        providerFactory: () => provider,
        input: new ScriptedChatInput([{ kind: 'batch', text: '/quit', source: 'typed' }]),
      },
    );
    const files = await sessionFiles(root);
    const sessionId = files[0]?.replace(/\.jsonl$/u, '') ?? '';
    await fs.appendFile(
      path.join(root, '.echo', 'sessions', `${sessionId}.jsonl`),
      `${JSON.stringify({
        id: 'event-hung',
        sequence: 2,
        timestamp: '2026-08-29T00:00:00.000Z',
        sessionId,
        turnId: 'turn-hung',
        type: 'turn.started',
        payload: { goal: 'left hanging' },
      })}\n`,
      'utf8',
    );

    const captured = output();
    const outcome = await runChat(
      {
        workspace: root,
        resume: sessionId,
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot: root,
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: captured.io,
        providerFactory: () => provider,
        modelCatalog: scriptedCatalog({
          status: 'ok',
          source: 'discover',
          models: ['fake-model', 'discovered-model'],
          cached: false,
          refreshed: false,
          configuredModel: 'fake-model',
        }),
        input: new ScriptedChatInput([
          { kind: 'batch', text: '/model', source: 'typed' },
          { kind: 'batch', text: 'continue after repair', source: 'typed' },
          { kind: 'batch', text: '/quit', source: 'typed' },
        ]),
      },
    );
    expect(outcome.exitCode).toBe(0);
    expect(captured.stderr()).toContain('recovered');
    const events = await readEvents(root);
    expect(events.some((event) => event.type === 'turn.failed')).toBe(true);
    expect(events.filter((event) => event.type === 'turn.started').length).toBeGreaterThan(1);
  });

  it('lists discover candidates through ProcessModelCatalog when no catalog port is injected', async () => {
    const root = await workspace();
    await writeArtifactConfig(root, 'discover');
    const provider = new FakeProvider(
      [
        {
          events: [
            { type: 'text_delta', delta: 'turn without listing' },
            { type: 'completed', finishReason: 'stop' },
          ],
        },
      ],
      'fake',
      [{ ids: ['fake-model', 'discovered-model'] }],
    );
    const captured = output();
    const outcome = await runChat(
      {
        workspace: root,
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot: root,
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: captured.io,
        providerFactory: () => provider,
        input: new ScriptedChatInput([
          { kind: 'batch', text: 'do work', source: 'typed' },
          { kind: 'batch', text: '/model', source: 'typed' },
          { kind: 'batch', text: '/quit', source: 'typed' },
        ]),
      },
    );

    expect(outcome.exitCode).toBe(0);
    expect(provider.listModelCallCount).toBe(1);
    expect(captured.stderr()).toContain('discovered-model');
    expect(captured.stderr()).not.toContain('Model catalog port is not attached');
    expect(captured.stderr()).not.toContain('test-key');
    expect(provider.requests).toHaveLength(1);
  });

  it('rejects unknown model ids and switches only to injected catalog candidates', async () => {
    const root = await workspace();
    await writeArtifactConfig(root, 'discover');
    const provider = new FakeProvider([
      {
        events: [
          { type: 'text_delta', delta: 'switched' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const captured = output();
    const outcome = await runChat(
      {
        workspace: root,
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot: root,
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: captured.io,
        providerFactory: () => provider,
        modelCatalog: scriptedCatalog({
          status: 'ok',
          source: 'discover',
          models: ['fake-model', 'discovered-model'],
          cached: false,
          refreshed: true,
          configuredModel: 'fake-model',
        }),
        input: new ScriptedChatInput([
          { kind: 'batch', text: '/model refresh', source: 'typed' },
          { kind: 'batch', text: '/model not-a-model', source: 'typed' },
          { kind: 'batch', text: '/model discovered-model', source: 'typed' },
          { kind: 'batch', text: 'after switch', source: 'typed' },
          { kind: 'batch', text: '/quit', source: 'typed' },
        ]),
      },
    );
    expect(outcome.exitCode).toBe(0);
    expect(captured.stderr()).toContain('Candidates: fake-model, discovered-model');
    expect(captured.stderr()).toContain('Unknown or unavailable model: not-a-model');
    expect(provider.requests[0]?.model).toBe('discovered-model');
    const events = await readEvents(root);
    expect(events.filter((event) => event.type === 'model.changed')).toHaveLength(1);
  });

  it('aborts an in-flight catalog list on idle interrupt and exits 130', async () => {
    const root = await workspace();
    await writeArtifactConfig(root, 'discover');
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const hanging: ChatModelCatalog = {
      async listCandidates(options) {
        await new Promise<void>((resolve) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => resolve(), { once: true });
          notifyStarted();
        });
        return {
          status: 'failed',
          source: 'discover',
          models: ['fake-model'],
          cached: false,
          refreshed: true,
          configuredModel: 'fake-model',
          error: { message: 'The model catalog request was cancelled.' },
        };
      },
    };
    let fire: (() => void) | undefined;
    const captured = output();
    const running = runChat(
      {
        workspace: root,
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot: root,
      },
      {
        env: { ECHO_API_KEY: 'test-key' },
        io: captured.io,
        providerFactory: () => new FakeProvider([]),
        modelCatalog: hanging,
        input: new ScriptedChatInput([{ kind: 'batch', text: '/model refresh', source: 'typed' }]),
        attachInterrupt: (handler) => {
          fire = handler;
          return () => {
            fire = undefined;
          };
        },
      },
    );
    await started;
    fire?.();
    const outcome = await running;
    expect(outcome.exitCode).toBe(130);
  });
});

function scriptedCatalog(snapshot: ChatModelCatalogSnapshot): ChatModelCatalog {
  return {
    async listCandidates() {
      return snapshot;
    },
  };
}
