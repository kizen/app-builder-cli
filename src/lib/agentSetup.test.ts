import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_HARNESSES, AGENT_HARNESS_INFO, type AgentHarness } from './agentHarness.js';
import { isAgentFilesStale, staleAgentFileWarnings } from './agentSetup.js';
import { agentFiles } from './createCopilotFiles.js';
import { nodeManagedFs, type ManagedFs } from './managedFiles.js';

const CLAUDE_WARNING =
  'Claude files managed by appbuilder are out of date; run appbuilder setup-claude';
const CODEX_WARNING =
  'Codex files managed by appbuilder are out of date; run appbuilder setup-codex';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-setup-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const put = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content, 'utf-8');
};

const installAll = async (harness: AgentHarness): Promise<void> => {
  for (const file of agentFiles(harness, ['src'])) {
    await put(file.path, file.content);
  }
};

const skillFiles = (harness: AgentHarness): string[] =>
  agentFiles(harness).map((file) => file.path);

describe('stale detection covers every managed skill', () => {
  it('names each harness its own setup command', () => {
    expect(AGENT_HARNESS_INFO.claude.staleWarning).toBe(CLAUDE_WARNING);
    expect(AGENT_HARNESS_INFO.codex.staleWarning).toBe(CODEX_WARNING);
  });

  describe.each(AGENT_HARNESSES.map((harness) => ({ harness })))('$harness', ({ harness }) => {
    it('is not stale when nothing is installed', async () => {
      expect(await isAgentFilesStale(dir, harness)).toBe(false);
    });

    it('is not stale when every managed file matches', async () => {
      await installAll(harness);

      expect(await isAgentFilesStale(dir, harness)).toBe(false);
    });

    it.each(skillFiles(harness))('is stale when %s differs', async (path) => {
      await installAll(harness);
      await put(path, 'edited locally\n');

      expect(await isAgentFilesStale(dir, harness)).toBe(true);
    });

    it.each(skillFiles(harness))('is stale when %s is missing', async (path) => {
      await installAll(harness);
      await rm(join(dir, path));

      expect(await isAgentFilesStale(dir, harness)).toBe(true);
    });

    it('is stale when an existing data lib differs', async () => {
      await installAll(harness);
      await put('src/lib/kizenData.js', 'export const mine = 1;\n');

      expect(await isAgentFilesStale(dir, harness)).toBe(true);
    });

    it("ignores the other harness's files", async () => {
      await installAll(harness === 'claude' ? 'codex' : 'claude');

      expect(await isAgentFilesStale(dir, harness)).toBe(false);
    });

    it('is not stale when reading fails', async () => {
      const fs: ManagedFs = {
        ...nodeManagedFs,
        readFile: () => Promise.reject(new Error('EACCES')),
      };

      expect(await isAgentFilesStale(dir, harness, fs)).toBe(false);
    });
  });
});

describe('staleAgentFileWarnings', () => {
  it('is empty with no managed files', async () => {
    expect(await staleAgentFileWarnings(dir)).toStrictEqual([]);
  });

  it('names only the harness whose files are out of date', async () => {
    await installAll('claude');
    await installAll('codex');
    await put('.agents/skills/kizen-business-apps/SKILL.md', 'edited locally\n');

    expect(await staleAgentFileWarnings(dir)).toStrictEqual([CODEX_WARNING]);
  });

  it('names both, Claude first, when both are out of date', async () => {
    await put('.claude/skills/kizen-business-apps/SKILL.md', 'old\n');
    await put('.agents/skills/kizen-custom-block/SKILL.md', 'old\n');

    expect(await staleAgentFileWarnings(dir)).toStrictEqual([CLAUDE_WARNING, CODEX_WARNING]);
  });

  it('flags a data lib that differs under both harnesses that have opted in', async () => {
    await installAll('claude');
    await installAll('codex');
    await put('src/lib/kizenData.js', 'export const mine = 1;\n');

    expect(await staleAgentFileWarnings(dir)).toStrictEqual([CLAUDE_WARNING, CODEX_WARNING]);
  });
});
