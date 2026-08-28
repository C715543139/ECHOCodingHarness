import { runCommandTool } from './command/index.js';
import {
  applyPatchTool,
  listFilesTool,
  readFileTool,
  searchTextTool,
  writeFileTool,
} from './files/index.js';
import type { RegisteredTool } from './tool-registry.js';

export * from './command/index.js';
export * from './files/index.js';
export {
  type InputNormalization,
  type RegisteredTool,
  ToolRegistry,
  normalizeToolInput,
  toolCallSignature,
} from './tool-registry.js';

export const DEFAULT_TOOLS: readonly RegisteredTool[] = [
  listFilesTool,
  searchTextTool,
  readFileTool,
  writeFileTool,
  applyPatchTool,
  runCommandTool,
];
