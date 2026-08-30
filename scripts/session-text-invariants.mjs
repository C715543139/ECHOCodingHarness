function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stepKey(event) {
  return `${event.turnId ?? ''}::${event.stepId ?? event.id ?? ''}`;
}

function parseSessionJsonl(jsonlText) {
  if (typeof jsonlText !== 'string') {
    throw new Error('Session text smoke requires a JSONL string.');
  }

  const events = [];
  let textLineCount = 0;
  let textLineBytes = 0;

  for (const line of jsonlText.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error('Session text smoke found invalid JSONL.');
    }
    events.push(parsed);
    if (isRecord(parsed) && (parsed.type === 'model.text' || parsed.type === 'model.text_delta')) {
      textLineCount += 1;
      textLineBytes += line.length;
    }
  }

  return { events, textLineCount, textLineBytes, lineCount: events.length };
}

/**
 * Asserts the P1.5 Session writer contract for a persisted event list:
 * at most one model.text per model response, no model.text_delta, and
 * text event envelopes do not grow with body length.
 */
export function assertAggregatedSessionText(events, extras = {}) {
  if (!Array.isArray(events)) {
    throw new Error('Session text smoke requires an event array.');
  }

  const byStep = new Map();
  let modelResponses = 0;
  let textChars = 0;

  for (const event of events) {
    if (!isRecord(event) || typeof event.type !== 'string') {
      throw new Error('Session text smoke found a non-event value.');
    }
    if (event.type === 'model.started') modelResponses += 1;
    if (event.type !== 'model.text' && event.type !== 'model.text_delta') continue;

    const key = stepKey(event);
    const current = byStep.get(key) ?? { text: 0, delta: 0 };
    if (event.type === 'model.text_delta') {
      current.delta += 1;
    } else {
      const payload = isRecord(event.payload) ? event.payload : {};
      if (typeof payload.text !== 'string' || payload.text.length === 0) {
        throw new Error('Session text smoke found an empty or damaged model.text payload.');
      }
      current.text += 1;
      textChars += payload.text.length;
    }
    byStep.set(key, current);
  }

  for (const [key, current] of byStep) {
    if (current.delta > 0) {
      throw new Error(`Session text smoke found model.text_delta in ${key}.`);
    }
    if (current.text > 1) {
      throw new Error(
        `Session text smoke found ${String(current.text)} model.text events in ${key}.`,
      );
    }
  }

  const textEvents = [...byStep.values()].reduce((sum, current) => sum + current.text, 0);
  const textLineCount = extras.textLineCount ?? textEvents;
  const textLineBytes = extras.textLineBytes;
  const lineCount = extras.lineCount ?? events.length;

  if (modelResponses > 0 && textLineCount > modelResponses) {
    throw new Error(
      'Session text smoke event envelopes grew with body length: more text JSONL lines than model responses.',
    );
  }
  if (
    textChars >= 32 &&
    textLineBytes !== undefined &&
    textLineCount > 1 &&
    textLineBytes >= textChars * 4
  ) {
    throw new Error('Session text smoke event envelopes grew with body length.');
  }
  if (textChars >= 256 && lineCount >= Math.ceil(textChars / 2)) {
    throw new Error('Session text smoke event envelopes grew with body length.');
  }

  return { modelResponses, textEvents, textChars, textLineCount, textLineBytes, lineCount };
}

export function assertAggregatedSessionJsonl(jsonlText) {
  const parsed = parseSessionJsonl(jsonlText);
  return assertAggregatedSessionText(parsed.events, parsed);
}
