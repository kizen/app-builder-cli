import { describe, expect, it } from 'vitest';
import type { FileContent } from '@kizenapps/packager';
import {
  buildFilteredConfig,
  buildTree,
  esc,
  fileExt,
  fileId,
  filterSourceFiles,
  generateHtml,
  generateMarkdown,
  mdFence,
  mdLang,
  redactServices,
  renderTextTree,
} from './reportHelpers.js';

function textFile(path: string, content = ''): FileContent {
  return { path, content };
}

/** A manifest carrying both redaction targets: the sensitive top-level field and
 * per-service auth_credentials. */
function secretManifest(): Record<string, unknown> {
  return {
    name: 'Acme Plugin',
    api_name: 'acme_plugin',
    version: '2.1.0',
    developer_business_id: '11111111-2222-3333-4444-555555555555',
    services: [
      {
        api_name: 'acme_api',
        auth_credentials: {
          api_key: 'sk-live-super-secret',
          client_secret: 'cs-live-also-secret',
        },
      },
    ],
  };
}

describe('esc', () => {
  it('escapes the four HTML-significant characters', () => {
    expect(esc('&<>"')).toBe('&amp;&lt;&gt;&quot;');
  });

  it('escapes ampersands first so entities are not double-escaped', () => {
    expect(esc('<a href="x">A & B</a>')).toBe('&lt;a href=&quot;x&quot;&gt;A &amp; B&lt;/a&gt;');
    expect(esc('&amp;')).toBe('&amp;amp;');
  });

  it('leaves text with no special characters untouched', () => {
    expect(esc('plain text 123')).toBe('plain text 123');
    expect(esc('')).toBe('');
  });
});

describe('fileId', () => {
  it('prefixes and slug-ifies every non-alphanumeric character', () => {
    expect(fileId('src/lib/util.ts')).toBe('file-src-lib-util-ts');
    expect(fileId('a b_c.d')).toBe('file-a-b-c-d');
  });

  it('preserves letter casing so anchors match their sections', () => {
    expect(fileId('src/MyFile.TS')).toBe('file-src-MyFile-TS');
  });

  it('produces a usable id for a bare filename', () => {
    expect(fileId('README.md')).toBe('file-README-md');
  });
});

describe('fileExt', () => {
  it('returns the lowercased extension including the dot', () => {
    expect(fileExt('a/b/Thing.TSX')).toBe('.tsx');
  });

  it('returns an empty string when there is no dot', () => {
    expect(fileExt('Makefile')).toBe('');
  });

  it('uses only the final dot', () => {
    expect(fileExt('archive.tar.gz')).toBe('.gz');
  });
});

describe('mdLang', () => {
  it('maps known extensions to their highlight language', () => {
    expect(mdLang('a.ts')).toBe('typescript');
    expect(mdLang('a.tsx')).toBe('typescript');
    expect(mdLang('a.mjs')).toBe('javascript');
    expect(mdLang('a.py')).toBe('python');
    expect(mdLang('a.yml')).toBe('yaml');
    expect(mdLang('a.yaml')).toBe('yaml');
  });

  it('is case-insensitive on the extension', () => {
    expect(mdLang('kizen.JSON')).toBe('json');
  });

  it('returns an empty language for unknown or extension-less paths', () => {
    expect(mdLang('a.rs')).toBe('');
    expect(mdLang('Makefile')).toBe('');
  });
});

describe('mdFence', () => {
  it('uses three backticks when the content has none', () => {
    expect(mdFence('const a = 1;')).toBe('```');
  });

  it('stays at three backticks for runs shorter than the fence', () => {
    expect(mdFence('an `inline` span')).toBe('```');
    expect(mdFence('a ``double`` span')).toBe('```');
  });

  it('grows past a nested fence so the wrapper is not closed early', () => {
    expect(mdFence('```js\ncode\n```')).toBe('````');
  });

  it('grows past the longest run anywhere in the content, not the first', () => {
    expect(mdFence('```\nthen\n`````\n')).toBe('``````');
  });

  it('always emits one more backtick than the longest run', () => {
    for (let run = 3; run <= 8; run++) {
      const content = `x ${'`'.repeat(run)} y`;

      expect(mdFence(content)).toBe('`'.repeat(run + 1));
    }
  });

  it('produces a fence that is strictly longer than every run it wraps', () => {
    const content = '``\n````\n`\n```';
    const fence = mdFence(content);
    const longest = [...content.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0);

    expect(fence.length).toBeGreaterThan(longest);
    expect(fence.length).toBeGreaterThanOrEqual(3);
  });
});

describe('buildTree + renderTextTree', () => {
  it('nests directories and marks only leaf segments as files', () => {
    const root = buildTree([textFile('src/index.ts'), textFile('src/lib/util.ts')]);
    const src = root.children.get('src');

    expect(src?.isFile).toBe(false);
    expect(src?.filePath).toBe('src');
    expect(src?.children.get('index.ts')?.isFile).toBe(true);
    expect(src?.children.get('lib')?.children.get('util.ts')?.filePath).toBe('src/lib/util.ts');
  });

  it('merges shared path prefixes into one node', () => {
    const root = buildTree([textFile('src/a.ts'), textFile('src/b.ts')]);

    expect(root.children.size).toBe(1);
    expect(root.children.get('src')?.children.size).toBe(2);
  });

  it('renders directories before files, each group alphabetically', () => {
    const tree = buildTree([
      textFile('README.md'),
      textFile('src/index.ts'),
      textFile('src/lib/util.ts'),
    ]);

    expect(renderTextTree(tree)).toBe(
      ['├── src/', '│   ├── lib/', '│   │   └── util.ts', '│   └── index.ts', '└── README.md'].join(
        '\n',
      ),
    );
  });

  it('uses the elbow connector for the final entry at each level', () => {
    const tree = buildTree([textFile('a.ts'), textFile('b.ts'), textFile('c.ts')]);

    expect(renderTextTree(tree)).toBe(['├── a.ts', '├── b.ts', '└── c.ts'].join('\n'));
  });

  it('renders an empty string for an empty file list', () => {
    expect(renderTextTree(buildTree([]))).toBe('');
  });
});

describe('filterSourceFiles', () => {
  it('drops the manifest and a previously generated report', () => {
    const kept = filterSourceFiles([
      textFile('kizen.json'),
      textFile('plugin-report.html'),
      textFile('src/index.ts'),
    ]);

    expect(kept.map((f) => f.path)).toEqual(['src/index.ts']);
  });

  it('drops licence files in either spelling, casing, or extension', () => {
    const paths = [
      'LICENSE',
      'LICENSE.md',
      'license.txt',
      'LICENCE',
      'Licence.md',
      'vendor/LICENSE',
    ];
    const kept = filterSourceFiles(paths.map((p) => textFile(p)));

    expect(kept).toEqual([]);
  });

  it('keeps files that merely start with or contain "license"', () => {
    const kept = filterSourceFiles([
      textFile('src/licenseManager.ts'),
      textFile('LICENSE.json'),
      textFile('kizen.json.bak'),
    ]);

    expect(kept.map((f) => f.path)).toEqual([
      'src/licenseManager.ts',
      'LICENSE.json',
      'kizen.json.bak',
    ]);
  });

  it('preserves the incoming order of the files it keeps', () => {
    const kept = filterSourceFiles([textFile('b.ts'), textFile('LICENSE'), textFile('a.ts')]);

    expect(kept.map((f) => f.path)).toEqual(['b.ts', 'a.ts']);
  });
});

describe('redactServices', () => {
  it('replaces every auth_credentials value with *****', () => {
    const redacted = redactServices([
      { api_name: 'svc', auth_credentials: { api_key: 'secret', token: 'also-secret' } },
    ]);

    expect(redacted).toEqual([
      { api_name: 'svc', auth_credentials: { api_key: '*****', token: '*****' } },
    ]);
  });

  it('keeps the credential key names so the report still documents the shape', () => {
    const redacted = redactServices([
      { auth_credentials: { client_id: 'a', client_secret: 'b', refresh_token: 'c' } },
    ]) as { auth_credentials: Record<string, string> }[];

    expect(Object.keys(redacted[0]?.auth_credentials ?? {})).toEqual([
      'client_id',
      'client_secret',
      'refresh_token',
    ]);
    expect(Object.values(redacted[0]?.auth_credentials ?? {})).toEqual(['*****', '*****', '*****']);
  });

  it('leaves every other service field intact', () => {
    const redacted = redactServices([
      { api_name: 'svc', base_url: 'https://api.example.com', auth_credentials: { key: 'v' } },
    ]) as Record<string, unknown>[];

    expect(redacted[0]?.api_name).toBe('svc');
    expect(redacted[0]?.base_url).toBe('https://api.example.com');
  });

  it('does not mutate the input services', () => {
    const services = [{ auth_credentials: { api_key: 'secret' } }];

    redactServices(services);

    expect(services[0]?.auth_credentials.api_key).toBe('secret');
  });

  it('passes through non-array values unchanged', () => {
    expect(redactServices(undefined)).toBeUndefined();
    expect(redactServices(null)).toBeNull();
    expect(redactServices('nope')).toBe('nope');
  });

  it('passes through entries that are not credential-bearing objects', () => {
    expect(redactServices([null, 'svc', 42])).toEqual([null, 'svc', 42]);
    expect(redactServices([{ api_name: 'svc' }])).toEqual([{ api_name: 'svc' }]);
    expect(redactServices([{ auth_credentials: null }])).toEqual([{ auth_credentials: null }]);
  });
});

describe('buildFilteredConfig', () => {
  it('removes developer_business_id entirely', () => {
    const filtered = buildFilteredConfig(secretManifest());

    expect(filtered).not.toHaveProperty('developer_business_id');
    expect(JSON.stringify(filtered)).not.toContain('11111111-2222-3333-4444-555555555555');
  });

  it('redacts service auth_credentials while keeping the rest of the manifest', () => {
    const filtered = buildFilteredConfig(secretManifest());

    expect(filtered.name).toBe('Acme Plugin');
    expect(filtered.api_name).toBe('acme_plugin');
    expect(filtered.services).toEqual([
      {
        api_name: 'acme_api',
        auth_credentials: { api_key: '*****', client_secret: '*****' },
      },
    ]);
  });

  it('only redacts credentials under the top-level services key', () => {
    const filtered = buildFilteredConfig({
      other_services: [{ auth_credentials: { api_key: 'left-alone' } }],
    });

    expect(filtered.other_services).toEqual([{ auth_credentials: { api_key: 'left-alone' } }]);
  });

  it('does not mutate the manifest it was given', () => {
    const manifest = secretManifest();

    buildFilteredConfig(manifest);

    expect(manifest.developer_business_id).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('handles a manifest with neither sensitive field', () => {
    expect(buildFilteredConfig({ name: 'Plain', version: '1.0.0' })).toEqual({
      name: 'Plain',
      version: '1.0.0',
    });
  });
});

describe('generateMarkdown', () => {
  const files = [textFile('kizen.json', '{}'), textFile('src/index.ts', 'export const a = 1;\n')];

  it('never leaks developer_business_id or auth_credentials values', () => {
    const md = generateMarkdown(secretManifest(), files);

    expect(md).not.toContain('developer_business_id');
    expect(md).not.toContain('11111111-2222-3333-4444-555555555555');
    expect(md).not.toContain('sk-live-super-secret');
    expect(md).not.toContain('cs-live-also-secret');
    expect(md).toContain('"api_key": "*****"');
    expect(md).toContain('"client_secret": "*****"');
  });

  it('omits kizen.json from the rendered source files', () => {
    const md = generateMarkdown(secretManifest(), files);

    expect(md).toContain('### `src/index.ts`');
    expect(md).not.toContain('### `kizen.json`');
  });

  it('titles the document with the manifest name and version', () => {
    const md = generateMarkdown({ name: 'Acme', version: '2.1.0' }, []);

    expect(md.startsWith('# Acme v2.1.0\n')).toBe(true);
  });

  it('falls back to a generic title when the manifest has no name', () => {
    expect(generateMarkdown({}, []).startsWith('# Plugin\n')).toBe(true);
  });

  it('fences file bodies with a run long enough to survive nested fences', () => {
    const md = generateMarkdown({ name: 'Acme' }, [
      textFile('README.md', 'Example:\n\n```js\nconst a = 1;\n```\n'),
    ]);

    expect(md).toContain('````markdown\n');
    expect(md).toContain('```js\nconst a = 1;\n```');
  });

  it('summarises image and binary files instead of inlining them', () => {
    const md = generateMarkdown({ name: 'Acme' }, [
      { path: 'icon.png', content: '', base64Image: 'AAAA' },
      { path: 'blob.bin', content: '', binaryData: Buffer.from('abcd') },
    ]);

    expect(md).toContain('[Image file: icon.png]');
    expect(md).toContain('[Binary file: 4 bytes]');
    expect(md).not.toContain('AAAA');
  });

  it('includes a text file tree of the source files', () => {
    const md = generateMarkdown({ name: 'Acme' }, files);

    expect(md).toContain('## File Tree');
    expect(md).toContain('└── src/');
    expect(md).toContain('    └── index.ts');
  });

  it('ends with a trailing newline', () => {
    expect(generateMarkdown({ name: 'Acme' }, [])).toMatch(/\n$/);
  });

  it('places the description directly under the title when present', () => {
    const md = generateMarkdown({ name: 'Acme', description: 'Does things.' }, []);

    expect(md.split('\n').slice(0, 3)).toEqual(['# Acme', '', 'Does things.']);
  });
});

describe('generateHtml', () => {
  const files = [textFile('kizen.json', '{}'), textFile('src/index.ts', 'export const a = 1;\n')];

  it('never leaks developer_business_id or auth_credentials values', () => {
    const html = generateHtml(secretManifest(), files);

    expect(html).not.toContain('developer_business_id');
    expect(html).not.toContain('11111111-2222-3333-4444-555555555555');
    expect(html).not.toContain('sk-live-super-secret');
    expect(html).not.toContain('cs-live-also-secret');
    expect(html).toContain('&quot;api_key&quot;: &quot;*****&quot;');
  });

  it('omits kizen.json from the rendered file sections and nav', () => {
    const html = generateHtml(secretManifest(), files);

    expect(html).toContain('id="file-src-index-ts"');
    expect(html).not.toContain('id="file-kizen-json"');
  });

  it('escapes manifest text so a crafted name cannot inject markup', () => {
    const html = generateHtml({ name: '<script>alert(1)</script>', description: 'a & b' }, []);

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('<p>a &amp; b</p>');
  });

  it('escapes file contents inside their code block', () => {
    const html = generateHtml({ name: 'Acme' }, [textFile('a.ts', 'const x = a < b && c > d;')]);

    expect(html).toContain('const x = a &lt; b &amp;&amp; c &gt; d;');
  });

  it('embeds images as data URIs keyed off the file extension', () => {
    const html = generateHtml({ name: 'Acme' }, [
      { path: 'icon.svg', content: '', base64Image: 'AAAA' },
      { path: 'photo.jpeg', content: '', base64Image: 'BBBB' },
      { path: 'mystery.xyz', content: '', base64Image: 'CCCC' },
    ]);

    expect(html).toContain('src="data:image/svg+xml;base64,AAAA"');
    expect(html).toContain('src="data:image/jpeg;base64,BBBB"');
    expect(html).toContain('src="data:image/png;base64,CCCC"');
  });

  it('reports binary files by size rather than embedding them', () => {
    const html = generateHtml({ name: 'Acme' }, [
      { path: 'blob.bin', content: '', binaryData: Buffer.from('abcd') },
    ]);

    expect(html).toContain('[Binary file: 4 bytes]');
  });

  it('links every rendered file from the nav tree by its section id', () => {
    const html = generateHtml({ name: 'Acme' }, files);

    expect(html).toContain('href="#file-src-index-ts" data-id="file-src-index-ts"');
    expect(html).toContain('<a href="#config" class="cfg" data-id="config">');
  });

  it('lists directories before files in the nav tree', () => {
    const html = generateHtml({ name: 'Acme' }, [
      textFile('zz.ts'),
      textFile('src/index.ts'),
      textFile('aa.ts'),
    ]);
    const nav = html.slice(html.indexOf('<nav>'), html.indexOf('</nav>'));

    expect(nav.indexOf('>src/<')).toBeLessThan(nav.indexOf('>aa.ts<'));
    expect(nav.indexOf('>aa.ts<')).toBeLessThan(nav.indexOf('>zz.ts<'));
  });

  it('is a self-contained document', () => {
    const html = generateHtml({ name: 'Acme' }, files);

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });
});
