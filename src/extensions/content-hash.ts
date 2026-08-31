import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ExtensionManifest } from '../contracts/index.js';

import { ExtensionStorageError } from './errors.js';
import { EXTENSION_LIMITS } from './limits.js';
import { parseExtensionManifest } from './manifest.js';
import { assertOwnedExtensionDirectory } from './workspace-paths.js';

export interface ExtensionContentSnapshot {
  readonly manifest: ExtensionManifest;
  readonly contentHash: string;
  readonly files: readonly string[];
  readonly totalBytes: number;
}

interface CollectedFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly size: number;
}

interface StableFile extends CollectedFile {
  readonly contents: Buffer;
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function collectFiles(root: string): Promise<readonly CollectedFile[]> {
  const files: CollectedFile[] = [];
  let totalBytes = 0;
  await visit(root, '', 0);
  return files.sort((left, right) => comparePath(left.relativePath, right.relativePath));

  async function visit(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    if (depth > EXTENSION_LIMITS.extensionDepth) {
      throw new ExtensionStorageError(
        'EXTENSION_CONTENT_INVALID',
        'Extension directory exceeds the nesting limit.',
      );
    }
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => comparePath(left.name, right.name));
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      const relativePath = path.posix.join(relativeDirectory, child.name);
      const stats = await fs.lstat(absolutePath);
      if (stats.isSymbolicLink() || child.isSymbolicLink()) {
        throw new ExtensionStorageError(
          'LINK_DENIED',
          `Extension content "${relativePath}" cannot be a link.`,
        );
      }
      if (stats.isDirectory()) {
        await visit(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!stats.isFile()) {
        throw new ExtensionStorageError(
          'EXTENSION_CONTENT_INVALID',
          `Extension content "${relativePath}" must be a regular file.`,
        );
      }
      files.push({ relativePath, absolutePath, size: stats.size });
      totalBytes += stats.size;
      if (
        files.length > EXTENSION_LIMITS.extensionFiles ||
        totalBytes > EXTENSION_LIMITS.extensionBytes
      ) {
        throw new ExtensionStorageError(
          'EXTENSION_CONTENT_INVALID',
          'Extension content exceeds the file or byte limit.',
        );
      }
    }
  }
}

async function readStableFiles(
  root: string,
  files: readonly CollectedFile[],
): Promise<readonly StableFile[]> {
  const stableFiles: StableFile[] = [];
  let totalBytes = 0;
  for (const file of files) {
    const before = await fs.lstat(file.absolutePath);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new ExtensionStorageError(
        'LINK_DENIED',
        `Extension content "${file.relativePath}" changed into a link or non-file.`,
      );
    }
    const contents = await fs.readFile(file.absolutePath);
    const after = await fs.lstat(file.absolutePath);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      contents.byteLength !== after.size
    ) {
      throw new ExtensionStorageError(
        'EXTENSION_CONTENT_INVALID',
        `Extension content "${file.relativePath}" changed while it was being hashed.`,
      );
    }
    totalBytes += contents.byteLength;
    if (totalBytes > EXTENSION_LIMITS.extensionBytes) {
      throw new ExtensionStorageError(
        'EXTENSION_CONTENT_INVALID',
        'Extension content exceeds the byte limit.',
      );
    }
    stableFiles.push({ ...file, contents });
  }

  const afterFiles = await collectFiles(root);
  if (
    afterFiles.length !== stableFiles.length ||
    afterFiles.some(
      (file, index) =>
        file.relativePath !== stableFiles[index]?.relativePath ||
        file.size !== stableFiles[index]?.size,
    )
  ) {
    throw new ExtensionStorageError(
      'EXTENSION_CONTENT_INVALID',
      'Extension directory changed while it was being hashed.',
    );
  }
  return stableFiles;
}

export async function snapshotExtensionContent(
  extensionRoot: string,
  ownedRoot: string,
  expectedId?: string,
): Promise<ExtensionContentSnapshot> {
  const root = await assertOwnedExtensionDirectory(extensionRoot, ownedRoot);
  const files = await readStableFiles(root, await collectFiles(root));
  const byPath = new Map(files.map((file) => [file.relativePath, file]));
  const manifestFile = byPath.get('extension.json');
  if (manifestFile === undefined) {
    throw new ExtensionStorageError(
      'EXTENSION_CONTENT_INVALID',
      'Extension content must contain extension.json.',
    );
  }
  const manifest = parseExtensionManifest(manifestFile.contents.toString('utf8'), expectedId);
  for (const requiredPath of [manifest.entry, manifest.selfTest]) {
    if (!byPath.has(requiredPath)) {
      throw new ExtensionStorageError(
        'EXTENSION_CONTENT_INVALID',
        `Manifest path "${requiredPath}" is missing or not a regular file.`,
      );
    }
  }

  const digest = createHash('sha256');
  digest.update('ECHO_EXTENSION_CONTENT_V1\0', 'utf8');
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.contents.byteLength;
    const relativeBytes = Buffer.byteLength(file.relativePath, 'utf8');
    digest.update(`${String(relativeBytes)}:`, 'utf8');
    digest.update(file.relativePath, 'utf8');
    digest.update(`${String(file.contents.byteLength)}:`, 'utf8');
    digest.update(file.contents);
  }
  return {
    manifest,
    contentHash: `sha256:${digest.digest('hex')}`,
    files: files.map((file) => file.relativePath),
    totalBytes,
  };
}
