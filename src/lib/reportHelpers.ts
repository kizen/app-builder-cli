import type { FileContent } from '@kizenapps/packager';

const SENSITIVE_FIELDS = new Set(['developer_business_id']);

export function redactServices(services: unknown): unknown {
  if (!Array.isArray(services)) {
    return services;
  }

  return services.map((svc: unknown) => {
    if (typeof svc !== 'object' || svc === null) {
      return svc;
    }

    const s = svc as Record<string, unknown>;

    if (typeof s.auth_credentials !== 'object' || s.auth_credentials === null) {
      return s;
    }

    const redacted = Object.fromEntries(Object.keys(s.auth_credentials).map((k) => [k, '*****']));

    return { ...s, auth_credentials: redacted };
  });
}

export interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
  filePath: string;
}

export function buildTree(files: FileContent[]): TreeNode {
  const root: TreeNode = { name: '', children: new Map(), isFile: false, filePath: '' };

  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;

    parts.forEach((part, i) => {
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          children: new Map(),
          isFile: i === parts.length - 1,
          filePath: parts.slice(0, i + 1).join('/'),
        });
      }

      const next = node.children.get(part);

      if (next) {
        node = next;
      }
    });
  }

  return root;
}

export function fileId(path: string): string {
  return 'file-' + path.replace(/[^a-zA-Z0-9]/g, '-');
}

export function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fileExt(path: string): string {
  const idx = path.lastIndexOf('.');

  return idx >= 0 ? path.slice(idx).toLowerCase() : '';
}

const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.htm': 'html',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.py': 'python',
  '.sh': 'bash',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.xml': 'xml',
  '.toml': 'toml',
};

export function mdLang(path: string): string {
  return LANG_MAP[fileExt(path)] ?? '';
}

// A fenced block must be delimited by more backticks than the longest run inside
// it, or content that is itself markdown (a README with a code sample) escapes
// its wrapper and corrupts the rest of the document.
export function mdFence(content: string): string {
  const longestRun = [...content.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0);

  return '`'.repeat(Math.max(3, longestRun + 1));
}

export function renderTextTree(node: TreeNode, prefix = ''): string {
  const sorted = [...node.children.values()].sort((a, b) => {
    if (a.isFile !== b.isFile) {
      return a.isFile ? 1 : -1;
    }

    return a.name.localeCompare(b.name);
  });

  return sorted
    .map((child, i) => {
      const isLast = i === sorted.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';

      if (child.isFile) {
        return `${prefix}${connector}${child.name}`;
      }

      return `${prefix}${connector}${child.name}/\n${renderTextTree(child, prefix + childPrefix)}`;
    })
    .join('\n');
}

const LICENSE_FILE = /(^|\/)licen[cs]e(\.md|\.txt)?$/i;

export function filterSourceFiles(files: FileContent[]): FileContent[] {
  return files.filter(
    (f) => f.path !== 'kizen.json' && f.path !== 'plugin-report.html' && !LICENSE_FILE.test(f.path),
  );
}

export function buildFilteredConfig(manifest: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(manifest)
      .filter(([k]) => !SENSITIVE_FIELDS.has(k))
      .map(([k, v]) => [k, k === 'services' ? redactServices(v) : v]),
  );
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function renderTree(node: TreeNode): string {
  const sorted = [...node.children.values()].sort((a, b) => {
    if (a.isFile !== b.isFile) {
      return a.isFile ? 1 : -1;
    }

    return a.name.localeCompare(b.name);
  });
  const items = sorted.map((child) => {
    if (child.isFile) {
      return `<li class="tf"><a href="#${fileId(child.filePath)}" data-id="${fileId(child.filePath)}">${esc(child.name)}</a></li>`;
    }

    return `<li class="td"><span class="dn">${esc(child.name)}/</span>${renderTree(child)}</li>`;
  });

  return `<ul>${items.join('')}</ul>`;
}

function renderFileSection(file: FileContent): string {
  let body: string;

  if (file.base64Image !== undefined) {
    const mime = IMAGE_MIME[fileExt(file.path)] ?? 'image/png';

    body = `<img src="data:${mime};base64,${file.base64Image}" alt="${esc(file.path)}" style="max-width:100%">`;
  } else if (file.binaryData !== undefined) {
    body = `<p class="bin">[Binary file: ${String(file.binaryData.length)} bytes]</p>`;
  } else {
    body = `<pre><code>${esc(file.content)}</code></pre>`;
  }

  return `<section id="${fileId(file.path)}"><h2 class="fp">${esc(file.path)}</h2><div class="fb">${body}</div></section>`;
}

export function generateMarkdown(manifest: Record<string, unknown>, files: FileContent[]): string {
  const filtered = buildFilteredConfig(manifest);
  const name = typeof manifest.name === 'string' ? manifest.name : 'Plugin';
  const version = typeof manifest.version === 'string' ? manifest.version : '';
  const description = typeof manifest.description === 'string' ? manifest.description : '';
  const sourceFiles = filterSourceFiles(files);

  const lines: string[] = [];

  lines.push(`# ${name}${version ? ` v${version}` : ''}`);
  if (description) {
    lines.push('', description);
  }

  const configJson = JSON.stringify(filtered, null, 2);
  const configFence = mdFence(configJson);

  lines.push(
    '',
    '## Configuration (`kizen.json`)',
    '',
    `${configFence}json`,
    configJson,
    configFence,
  );

  lines.push('', '## File Tree', '', '```', renderTextTree(buildTree(sourceFiles)), '```');

  lines.push('', '## Files');

  for (const file of sourceFiles) {
    lines.push('', `### \`${file.path}\``, '');

    if (file.base64Image !== undefined) {
      lines.push(`[Image file: ${file.path}]`);
    } else if (file.binaryData !== undefined) {
      lines.push(`[Binary file: ${String(file.binaryData.length)} bytes]`);
    } else {
      const fence = mdFence(file.content);

      lines.push(`${fence}${mdLang(file.path)}`, file.content, fence);
    }
  }

  return lines.join('\n') + '\n';
}

export function generateHtml(manifest: Record<string, unknown>, files: FileContent[]): string {
  const filtered = buildFilteredConfig(manifest);
  const name = typeof manifest.name === 'string' ? manifest.name : 'Plugin';
  const version = typeof manifest.version === 'string' ? manifest.version : '';
  const description = typeof manifest.description === 'string' ? manifest.description : '';

  const sourceFiles = filterSourceFiles(files);
  const treeHtml = renderTree(buildTree(sourceFiles));
  const fileSections = sourceFiles.map(renderFileSection).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} — Plugin Report</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#1e1e2e;--sb:#181825;--hd:#11111b;--tx:#cdd6f4;--mu:#6c7086;
  --ac:#89b4fa;--gr:#a6e3a1;--bd:#313244;--cb:#181825;--sw:280px;
  --fn:'Menlo','Consolas','Monaco',monospace;
}
html{font-size:14px}
body{background:var(--bg);color:var(--tx);font-family:var(--fn);display:flex;flex-direction:column;height:100vh}
header{background:var(--hd);border-bottom:1px solid var(--bd);padding:14px 20px;flex-shrink:0}
header h1{font-size:1.1rem;color:var(--ac)}
header p{color:var(--mu);font-size:.85rem;margin-top:3px}
.layout{display:flex;flex:1;overflow:hidden}
nav{width:var(--sw);background:var(--sb);border-right:1px solid var(--bd);overflow-y:auto;padding:12px 0;flex-shrink:0}
nav a.cfg{display:block;padding:6px 16px;color:var(--gr);text-decoration:none;font-size:.85rem}
nav a.cfg:hover,nav a.cfg.active{background:var(--bd)}
nav ul{list-style:none;padding-left:0}
.td>.dn{display:block;padding:4px 16px;color:var(--mu);font-size:.8rem}
.td ul{padding-left:14px}
.tf a{display:block;padding:3px 16px;color:var(--tx);text-decoration:none;font-size:.8rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tf a:hover,.tf a.active{background:var(--bd);color:var(--ac)}
main{flex:1;overflow-y:auto;padding:0 24px 40px}
section{padding:32px 0;border-bottom:1px solid var(--bd)}
h2.fp{font-size:.9rem;color:var(--ac);margin-bottom:12px;word-break:break-all}
#config h2.fp{color:var(--gr)}
pre{background:var(--cb);border:1px solid var(--bd);border-radius:6px;padding:14px;overflow-x:auto;font-size:.78rem;line-height:1.6;white-space:pre}
code{font-family:var(--fn)}
img{border:1px solid var(--bd);border-radius:4px}
.bin{color:var(--mu);font-style:italic;padding:12px 0}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--bd);border-radius:3px}
</style>
</head>
<body>
<header>
  <h1>${esc(name)}${version ? ` <span style="color:var(--mu);font-size:.8em">v${esc(version)}</span>` : ''}</h1>
  ${description ? `<p>${esc(description)}</p>` : ''}
</header>
<div class="layout">
<nav>
  <a href="#config" class="cfg" data-id="config">kizen.json (config)</a>
  ${treeHtml}
</nav>
<main>
<section id="config"><h2 class="fp">kizen.json — Plugin Configuration</h2><div class="fb"><pre><code>${esc(JSON.stringify(filtered, null, 2))}</code></pre></div></section>
${fileSections}
</main>
</div>
<script>
(function(){
  var links=document.querySelectorAll('[data-id]');
  function setActive(id){links.forEach(function(l){l.classList.toggle('active',l.getAttribute('data-id')===id);})}
  links.forEach(function(l){l.addEventListener('click',function(){setActive(this.getAttribute('data-id'));});});
  var obs=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting)setActive(e.target.id);});},{rootMargin:'-20% 0px -70% 0px'});
  document.querySelectorAll('section[id]').forEach(function(s){obs.observe(s);});
})();
</script>
</body>
</html>`;
}
