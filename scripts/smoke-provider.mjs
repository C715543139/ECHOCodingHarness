const enabled = process.env.ECHO_RUN_PROVIDER_SMOKE === '1';

if (!enabled) {
  process.stdout.write(
    'Provider smoke check skipped. Set ECHO_RUN_PROVIDER_SMOKE=1 to enable a real request.\n',
  );
  process.exit(0);
}

const required = ['ECHO_BASE_URL', 'ECHO_API_KEY', 'ECHO_MODEL'];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(`Provider smoke check is enabled but missing: ${missing.join(', ')}`);
}

const { OpenAICompatibleProvider, createOpenAIClient } = await import('../dist/index.js');
const timeoutMs = 60_000;
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), timeoutMs);

try {
  const provider = new OpenAICompatibleProvider({
    client: createOpenAIClient({
      baseUrl: process.env.ECHO_BASE_URL,
      apiKey: process.env.ECHO_API_KEY,
      timeoutMs,
    }),
    model: process.env.ECHO_MODEL,
    requestTimeoutMs: timeoutMs,
    retryPolicy: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
  });
  let textLength = 0;
  let completed = false;
  for await (const event of provider.stream(
    {
      model: process.env.ECHO_MODEL,
      messages: [
        {
          role: 'user',
          content: 'Reply with exactly ECHO_PROVIDER_SMOKE_OK and do not call tools.',
        },
      ],
      tools: [],
      maxOutputTokens: 32,
    },
    { signal: controller.signal },
  )) {
    if (event.type === 'text_delta') {
      textLength += event.delta.length;
    }
    if (event.type === 'completed') {
      completed = true;
    }
  }
  if (!completed || textLength === 0) {
    throw new Error('Provider smoke check returned no completed text response.');
  }
  process.stdout.write('Provider smoke check passed.\n');
} finally {
  clearTimeout(timeout);
}
