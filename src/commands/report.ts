import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { readLocalFiles } from '../lib/readFiles.js';
import { GLOBAL_CREDENTIALS_DIR } from '../lib/credentials.js';
import { generateHtml, generateMarkdown } from '../lib/reportHelpers.js';

const EXAMPLES_DIR = join(GLOBAL_CREDENTIALS_DIR, 'examples');

export function reportCommand(program: Command): void {
  program
    .command('report')
    .description('Generate a self-contained HTML report of the plugin')
    .option('-o, --output <path>', `output file path (default: ${EXAMPLES_DIR}/<api_name>.html)`)
    .action(async (options: { output?: string }) => {
      const pluginDir = process.cwd();

      let manifest: Record<string, unknown>;

      try {
        const raw = await readFile(join(pluginDir, 'kizen.json'), 'utf-8');
        const parsed = JSON.parse(raw) as unknown;

        manifest = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown>;
      } catch {
        console.error('Error: kizen.json not found. Run this command from a plugin directory.');
        process.exit(1);
      }

      const apiName = typeof manifest.api_name === 'string' ? manifest.api_name : 'plugin';
      const htmlPath = options.output ?? join(EXAMPLES_DIR, `${apiName}.html`);
      const mdPath = htmlPath.replace(/\.html$/, '.md');

      const files = await readLocalFiles(pluginDir, { detectBinaryByContent: true });

      await mkdir(join(htmlPath, '..'), { recursive: true });

      await Promise.all([
        writeFile(htmlPath, generateHtml(manifest, files), 'utf-8'),
        writeFile(mdPath, generateMarkdown(manifest, files), 'utf-8'),
      ]);

      console.log(`Plugin report written to:\n  ${htmlPath}\n  ${mdPath}`);
    });
}
