export const BRACKETED_PASTE_START = '\u001b[200~';
export const BRACKETED_PASTE_END = '\u001b[201~';

export type ChatInputSource = 'typed' | 'paste';

export const P1_SLASH_COMMANDS = ['help', 'status', 'model', 'safety', 'quit'] as const;

export type P1SlashName = (typeof P1_SLASH_COMMANDS)[number];

export type ChatIdleInput =
  | Readonly<{ kind: 'empty' }>
  | Readonly<{ kind: 'message'; text: string; source: ChatInputSource }>
  | Readonly<{ kind: 'slash'; name: 'help' | 'status' | 'quit' }>
  | Readonly<{ kind: 'slash'; name: 'model'; argument?: string }>
  | Readonly<{ kind: 'slash'; name: 'safety'; argument?: 'safe' | 'balanced' | 'auto' }>
  | Readonly<{ kind: 'error'; code: 'UNKNOWN_SLASH' | 'INVALID_SLASH_ARGUMENT'; message: string }>;
