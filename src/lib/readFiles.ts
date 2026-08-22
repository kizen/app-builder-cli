import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FileContent } from '@kizenapps/packager';

const IMAGE_EXTENSIONS = new Set(['.png', '.svg']);
const BINARY_EXTENSIONS = new Set(['.kzn']);
const SKIP_FILES = new Set(['.DS_Store']);

export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.kizenapp',
  '.github',
  '.claude',
  '__pycache__',
]);

// a NUL in the first 8 KB means binary
const BINARY_SNIFF_BYTES = 8000;

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export interface ReadLocalFilesOptions {
  detectBinaryByContent?: boolean;
}

async function walk(dir: string, rootDir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }

      paths.push(...(await walk(join(dir, entry.name), rootDir)));
    } else if (entry.isFile()) {
      if (!SKIP_FILES.has(entry.name)) {
        paths.push(join(dir, entry.name));
      }
    }
  }

  return paths;
}

export async function readLocalFiles(
  rootDir: string,
  { detectBinaryByContent = false }: ReadLocalFilesOptions = {},
): Promise<FileContent[]> {
  const absolutePaths = await walk(rootDir, rootDir);

  return Promise.all(
    absolutePaths.map(async (absPath): Promise<FileContent> => {
      const relPath = relative(rootDir, absPath).split('\\').join('/');
      const dotIndex = relPath.lastIndexOf('.');
      const ext = dotIndex >= 0 ? relPath.slice(dotIndex).toLowerCase() : '';

      if (IMAGE_EXTENSIONS.has(ext)) {
        const buf = await readFile(absPath);

        return { path: relPath, content: '', base64Image: buf.toString('base64') };
      }

      const buf = await readFile(absPath);

      if (BINARY_EXTENSIONS.has(ext) || (detectBinaryByContent && looksBinary(buf))) {
        return { path: relPath, content: '', binaryData: buf };
      }

      return { path: relPath, content: buf.toString('utf-8') };
    }),
  );
}
