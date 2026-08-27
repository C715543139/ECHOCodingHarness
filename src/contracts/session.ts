import type { EchoEvent } from './events.js';
import type { SessionId } from './identifiers.js';

export interface SessionStore {
  append(event: EchoEvent): Promise<void>;
  read(sessionId: SessionId): AsyncIterable<EchoEvent>;
}
