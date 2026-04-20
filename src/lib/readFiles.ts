import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FileContent } from '@kizenapps/packager';

const IMAGE_EXTENSIONS = new Set(['.png', '.svg']);
const BINARY_EXTENSIONS = new Set(['.kzn']);

export const SKIP_DIRS = new Set(['node_modules', '.git', '.kizenapp', '.github']);

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
      paths.push(join(dir, entry.name));
    }
  }

  return paths;
}

export async function readLocalFiles(rootDir: string): Promise<FileContent[]> {
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

      if (BINARY_EXTENSIONS.has(ext)) {
        const buf = await readFile(absPath);

        return { path: relPath, content: '', binaryData: buf };
      }

      const content = await readFile(absPath, 'utf-8');

      return { path: relPath, content };
    }),
  );
}
