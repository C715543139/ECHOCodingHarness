/** Static CommonJS bootstrap used by an isolated Node worker thread. */
export const EXTENSION_WORKER_SOURCE = String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
if (parentPort === null) throw new Error('Extension worker requires a parent port.');

let handlers;
const controllers = new Map();

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageText(error) {
  return error instanceof Error ? error.message : 'Extension operation failed.';
}

function send(message) {
  parentPort.postMessage(message);
}

function protocol(id, message) {
  send({ type: 'protocol_error', id, message });
}

async function initialize(message) {
  if (handlers !== undefined) return protocol(message.id, 'Worker is already initialized.');
  try {
    const module = await import(workerData.entryUrl);
    const candidate = module.handlers;
    if (!isRecord(candidate)) throw new Error('Entry must export a plain handlers object.');
    const actual = Object.keys(candidate).sort();
    const expected = [...workerData.toolNames].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('Entry handlers must correspond exactly to the manifest tools.');
    }
    for (const name of expected) {
      if (typeof candidate[name] !== 'function') throw new Error('Every handler must be a function.');
    }
    handlers = candidate;
    send({ type: 'ready', id: message.id, tools: expected });
  } catch (error) {
    send({
      type: 'failure',
      id: message.id,
      phase: 'initialize',
      message: messageText(error)
    });
  }
}

async function execute(message) {
  if (handlers === undefined) return protocol(message.id, 'Worker is not initialized.');
  if (controllers.has(message.id)) return protocol(message.id, 'Call id is already active.');
  const handler = handlers[message.toolName];
  if (typeof handler !== 'function') return protocol(message.id, 'Tool is not registered by this worker.');
  const controller = new AbortController();
  controllers.set(message.id, controller);
  try {
    let execution;
    try {
      execution = await handler(message.input, {
        workspaceRoot: workerData.workspaceRoot,
        callId: message.callId,
        limits: message.limits,
        signal: controller.signal
      });
    } catch (error) {
      send({
        type: 'failure',
        id: message.id,
        phase: 'execute',
        message: messageText(error)
      });
      return;
    }
    try {
      send({ type: 'result', id: message.id, execution });
    } catch (_error) {
      protocol(message.id, 'Extension handler returned a value that cannot be cloned.');
    }
  } catch (error) {
    protocol(message.id, messageText(error));
  } finally {
    controllers.delete(message.id);
  }
}

async function handle(message) {
  if (!isRecord(message) || typeof message.id !== 'string' || typeof message.type !== 'string') {
    return protocol('invalid', 'Worker request is malformed.');
  }
  if (message.type === 'initialize') return initialize(message);
  if (message.type === 'execute') return execute(message);
  if (message.type === 'cancel') {
    controllers.get(message.targetId)?.abort();
    return;
  }
  if (message.type === 'shutdown') {
    for (const controller of controllers.values()) controller.abort();
    send({ type: 'ready', id: message.id, tools: [] });
    setImmediate(() => process.exit(0));
    return;
  }
  protocol(message.id, 'Worker request type is not supported.');
}

parentPort.on('message', (message) => {
  void handle(message).catch((error) => protocol(
    isRecord(message) && typeof message.id === 'string' ? message.id : 'invalid',
    messageText(error)
  ));
});
`;
