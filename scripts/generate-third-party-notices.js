/**
 * Generates `dist/THIRD-PARTY-NOTICES.txt`.
 *
 * The published tarball ships `dist/` only (see the `files` field in
 * package.json). `dist/index.js` (tsup) externalizes every runtime dependency,
 * but `dist/viewer` (Vite) is a real bundle: it inlines third-party code with
 * license comments stripped by minification. Redistributing that code obliges
 * us to reproduce the corresponding license texts, which is what this file is.
 *
 * The package set is DERIVED, never hand-maintained:
 *
 *   1. The viewer's Vite build is re-run in memory (`build.write === false`, so
 *      nothing on disk is touched) and every module in the resulting rollup
 *      module graph that resolves inside a `node_modules` directory is mapped
 *      back to the package directory it came from. That yields the exact,
 *      transitive set of packages whose code lands in `dist/viewer`.
 *   2. Web Worker bundles are built by Vite in separate Rollup passes and come
 *      back to the main build as opaque assets with no module graph attached,
 *      so a capture plugin is injected into the worker pipeline to collect
 *      their modules too. The engine spawns several workers via
 *      `new Worker(new URL(...))`; without this, code reachable only from a
 *      worker would ship unattributed.
 *   3. Emitted CSS assets are scanned for generator banners (Tailwind writes
 *      its own), because plugin-generated CSS has no module in the graph.
 *   4. Every emitted JS asset must be covered by one of the passes above, and
 *      emitted text assets are scanned for `node_modules` path signatures. Both
 *      are hard failures: if a future Vite version emits bundled code through a
 *      pipeline this script does not instrument, the build stops instead of
 *      quietly under-reporting.
 *   5. The CLI bundle's sourcemap is checked for `node_modules` sources. Today
 *      there are none; if tsup ever stops externalizing a dependency, those
 *      packages get picked up here instead of silently going unattributed.
 *
 * Output is deterministic: packages are sorted, and the file contains no
 * timestamps, no absolute paths, and nothing else derived from the machine it
 * ran on. The same source tree always produces a byte-identical file.
 *
 * Run via `pnpm build` (and therefore via `prepublishOnly`).
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'vite';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');
const outFile = join(distDir, 'THIRD-PARTY-NOTICES.txt');
const viewerConfig = join(repoRoot, 'viewer', 'vite.config.ts');
const cliSourceMap = join(distDir, 'index.js.map');
const require = createRequire(join(repoRoot, 'package.json'));

/** Extra notes appended to a package's section, keyed by package name. */
const PACKAGE_NOTES = {
  dompurify:
    'DOMPurify is offered under a dual license, "MPL-2.0 OR Apache-2.0".\n' +
    'For this distribution the Apache License 2.0 option is elected; the full\n' +
    'text of both options as shipped by the package follows.',
  '@fortawesome/free-solid-svg-icons':
    'Font Awesome Free is a multi-licensed package: the icon graphics/data are\n' +
    'licensed CC BY 4.0 and require attribution, and the code is MIT licensed.\n' +
    'The package LICENSE.txt is reproduced verbatim below.',
};

/**
 * Canonical license texts, used only when a package ships no license file of
 * its own. `{holder}` is filled in from the package's author/contributor
 * fields. Packages that hit this path are listed on stderr at the end of a run.
 */
const CANONICAL_LICENSES = {
  MIT: `MIT License

Copyright (c) {holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  ISC: `ISC License

Copyright (c) {holder}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`,
  'BSD-2-Clause': `BSD 2-Clause License

Copyright (c) {holder}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
  'BSD-3-Clause': `BSD 3-Clause License

Copyright (c) {holder}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
};

/** CSS generator banners that identify a package with no module in the graph. */
const CSS_BANNER_PACKAGES = [
  { name: 'tailwindcss', pattern: /tailwindcss v[\d.]+ \| MIT License/ },
];

/** License file names, in the order we prefer them. */
const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|notice)([-._].*)?(\.(txt|md|markdown))?$/i;

const fail = (message) => {
  console.error(`[third-party-notices] ${message}`);
  process.exit(1);
};

/** Parses JSON, failing with context instead of an opaque stack trace. */
function parseJsonFile(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    return fail(`could not parse ${label}: ${error.message}`);
  }
}

/**
 * Maps a path to the package directory containing it, or null. `separator` is
 * '/' for Rollup/Vite module ids (always posix-normalized, on every platform)
 * and `sep` for real filesystem paths.
 */
function packageDirForPath(filePath, separator) {
  const marker = `node_modules${separator}`;
  const at = filePath.lastIndexOf(marker);

  if (at === -1) {
    return null;
  }

  const start = at + marker.length;
  const segments = filePath.slice(start).split(separator);
  // pnpm stores packages as node_modules/.pnpm/<id>/node_modules/<name>, so the
  // last node_modules segment always precedes the real package name.
  const depth = segments[0].startsWith('@') ? 2 : 1;

  if (segments.length < depth) {
    return null;
  }

  return filePath.slice(0, start) + segments.slice(0, depth).join(separator);
}

/** Resolves a Rollup module id to the package directory it lives in, or null. */
function packageDirForModuleId(id) {
  // Virtual modules ("\0..."), inline ids and query suffixes are not files.
  if (id.startsWith('\0') || id.startsWith('virtual:')) {
    return null;
  }

  return packageDirForPath(id.split('?')[0].split('#')[0], '/');
}

/** Reads and validates a package's manifest. */
function readManifest(packageDir) {
  const manifestPath = join(packageDir, 'package.json');

  if (!existsSync(manifestPath)) {
    return null;
  }

  return parseJsonFile(manifestPath, `${packageDir.split(sep).pop()}/package.json`);
}

/** Resolves the on-disk directory of a package by name, or null. */
function resolvePackageDir(name) {
  const direct = join(repoRoot, 'node_modules', ...name.split('/'));

  if (existsSync(join(direct, 'package.json'))) {
    return direct;
  }

  try {
    return packageDirForPath(require.resolve(name), sep);
  } catch {
    return null;
  }
}

/** Collects every package directory referenced by the viewer bundle. */
async function collectViewerPackages() {
  const workerModuleIds = new Set();
  const scannedFileNames = new Set();
  let workerBundles = 0;
  /**
   * Web Worker bundles are produced by their own Rollup pass and reach the main
   * build as finished assets, so their modules are captured here instead.
   */
  const workerGraphPlugin = {
    name: 'kizen:capture-worker-graph',
    generateBundle(_options, bundle) {
      workerBundles += 1;

      for (const [fileName, chunk] of Object.entries(bundle)) {
        scannedFileNames.add(fileName);

        for (const id of [...Object.keys(chunk.modules ?? {}), ...(chunk.moduleIds ?? [])]) {
          workerModuleIds.add(id);
        }
      }
    },
  };
  const outputs = await build({
    configFile: viewerConfig,
    logLevel: 'silent',
    // In-memory only: keep the real dist/viewer output from build:viewer intact.
    build: { write: false },
    worker: { plugins: () => [workerGraphPlugin] },
  });
  const bundles = (Array.isArray(outputs) ? outputs : [outputs]).flatMap((result) =>
    'output' in result ? result.output : [],
  );

  if (bundles.length === 0) {
    fail('the viewer build produced no output; cannot determine bundled packages');
  }

  const packageDirs = new Set();
  const bannerPackages = new Set();
  const scannedModuleIds = new Set();
  let scannedAssets = 0;

  const addModuleId = (id) => {
    scannedModuleIds.add(id);
    const packageDir = packageDirForModuleId(id);

    if (packageDir) {
      packageDirs.add(packageDir);
    }
  };

  for (const id of workerModuleIds) {
    addModuleId(id);
  }

  for (const chunk of bundles) {
    if (chunk.type === 'chunk') {
      scannedFileNames.add(chunk.fileName);

      for (const id of [...Object.keys(chunk.modules ?? {}), ...(chunk.moduleIds ?? [])]) {
        addModuleId(id);
      }

      continue;
    }

    if (chunk.fileName.endsWith('.css')) {
      const css = Buffer.from(chunk.source).toString('utf8');

      for (const { name, pattern } of CSS_BANNER_PACKAGES) {
        if (pattern.test(css)) {
          bannerPackages.add(name);
        }
      }

      continue;
    }

    // Everything else Vite emits as an asset: worker bundles, index.html, and
    // any copied static file. Assets carry no module graph, so each one has to
    // be accounted for by a pass that was instrumented above.
    scannedAssets += 1;

    if (/\.[cm]?js$/.test(chunk.fileName) && !scannedFileNames.has(chunk.fileName)) {
      fail(
        `emitted JS asset ${chunk.fileName} was not produced by an instrumented build pass, ` +
          'so the packages inside it are unknown. Vite builds Web Workers (and similar ' +
          'nested bundles) in separate Rollup passes; this script instruments the worker ' +
          'pipeline via worker.plugins. Extend that instrumentation to cover this pass ' +
          'before shipping, or its third-party code will go unattributed.',
      );
    }

    if (typeof chunk.source === 'string' && /node_modules[/\\]/.test(chunk.source)) {
      fail(
        `emitted asset ${chunk.fileName} contains node_modules path signatures, which means it ` +
          'embeds dependency code this script did not see in a module graph. Instrument the ' +
          'build pass that produced it before shipping.',
      );
    }
  }

  if (scannedModuleIds.size === 0) {
    fail('the viewer build exposed no module graph; the license scan cannot be trusted');
  }

  if (packageDirs.size === 0) {
    fail('no node_modules packages found in the viewer module graph; that cannot be right');
  }

  for (const { name, pattern } of CSS_BANNER_PACKAGES) {
    // Every entry here describes generated output that ships in every build, so
    // a miss means the banner format changed and attribution would be dropped.
    if (!bannerPackages.has(name)) {
      fail(
        `no emitted CSS matched the ${name} banner ${String(pattern)}. Either it no longer ` +
          'contributes generated CSS (remove the entry) or its banner changed (update the ' +
          'pattern); leaving it unmatched would silently drop its attribution.',
      );
    }

    const packageDir = resolvePackageDir(name);

    if (!packageDir) {
      fail(`${name} generated output in the bundle but could not be resolved in node_modules`);
    }

    packageDirs.add(packageDir);
  }

  console.log(
    `[third-party-notices] scanned ${scannedModuleIds.size} modules ` +
      `(${workerModuleIds.size} from ${workerBundles} worker bundle(s)) ` +
      `and ${scannedAssets} non-CSS asset(s)`,
  );

  return packageDirs;
}

/** Fails early -- before any build work -- if the CLI output is not in place. */
function requireCliBuild() {
  if (!existsSync(join(distDir, 'index.js'))) {
    fail('dist/index.js is missing; run build:cli before build:notices');
  }

  if (!existsSync(cliSourceMap)) {
    fail(
      'dist/index.js.map is missing, so the CLI bundle cannot be scanned for third-party code. ' +
        'Keep `sourcemap: true` in tsup.config.ts, or extend this script to read a metafile.',
    );
  }
}

/**
 * Collects package directories bundled into the CLI output. tsup externalizes
 * all runtime dependencies today, so this is normally empty -- it exists so a
 * future config change cannot quietly drop packages from this file.
 */
function collectCliPackages() {
  const map = parseJsonFile(cliSourceMap, 'dist/index.js.map');
  const packageDirs = new Set();

  for (const source of map.sources ?? []) {
    const packageDir = packageDirForPath(resolve(distDir, source), sep);

    if (packageDir) {
      packageDirs.add(packageDir);
    }
  }

  return packageDirs;
}

/** Normalizes the SPDX-ish license field of a manifest to a string. */
function licenseId(manifest) {
  const { license, licenses } = manifest;

  if (typeof license === 'string' && license.trim()) {
    return license.trim();
  }

  if (license && typeof license === 'object' && typeof license.type === 'string') {
    return license.type;
  }

  if (Array.isArray(licenses)) {
    const ids = licenses.map((entry) => (typeof entry === 'string' ? entry : entry?.type));

    if (ids.every(Boolean) && ids.length > 0) {
      return ids.join(' OR ');
    }
  }

  return null;
}

/** Formats the copyright holder for a canonical license stub. */
function copyrightHolder(manifest) {
  const person = manifest.author ?? manifest.contributors?.[0] ?? manifest.maintainers?.[0];

  if (typeof person === 'string') {
    return person;
  }

  if (person && typeof person === 'object' && person.name) {
    return person.email ? `${person.name} <${person.email}>` : person.name;
  }

  return null;
}

/** Reads every license/notice file a package ships, in a stable order. */
function readLicenseFiles(packageDir) {
  const files = readdirSync(packageDir)
    .filter((name) => LICENSE_FILE_PATTERN.test(name))
    .filter((name) => statSync(join(packageDir, name)).isFile())
    .sort();

  return files.map((name) => ({
    name,
    text: readFileSync(join(packageDir, name), 'utf8').replace(/\r\n/g, '\n').trimEnd(),
  }));
}

/** Builds the notice entry for one package directory. */
function describePackage(packageDir) {
  const manifest = readManifest(packageDir);

  if (!manifest) {
    fail(`no package.json found for bundled directory ending in ${packageDir.split(sep).pop()}`);
  }

  const { name, version } = manifest;

  if (!name || !version) {
    fail(`package at ${name ?? packageDir.split(sep).pop()} has no name/version`);
  }

  const license = licenseId(manifest);

  if (!license) {
    fail(`${name}@${version} declares no license; it cannot be redistributed unattributed`);
  }

  const files = readLicenseFiles(packageDir);
  const holder = copyrightHolder(manifest);
  let synthesized = false;
  let body;

  if (files.length > 0) {
    body = files.map((file) => `--- License file: ${file.name} ---\n\n${file.text}`).join('\n\n');
  } else {
    synthesized = true;
    const template = CANONICAL_LICENSES[license];

    body = template
      ? `No license file ships with this package. Canonical text of the declared\nlicense (${license}):\n\n${template.replace('{holder}', holder ?? name)}`
      : `No license file ships with this package. It declares "${license}"` +
        `${holder ? `, authored by ${holder}` : ''}.\nSee https://spdx.org/licenses/ for the canonical text of that license.`;
  }

  return { key: `${name}@${version}`, name, version, license, body, synthesized };
}

const HEADER = `================================================================================
THIRD-PARTY SOFTWARE NOTICES AND LICENSES
================================================================================

@kizenapps/cli is licensed under the GNU General Public License v3.0 only; see
the LICENSE.md file distributed with this package for its terms.

This file covers the third-party open-source software redistributed inside this
package. The browser UI in dist/viewer is a bundled, minified build, so code
from the packages listed below is compiled into the files shipped here and the
original license comments are not preserved in them. Their license terms are
reproduced in full below instead, one section per package.

The list is generated mechanically, not maintained by hand
(scripts/generate-third-party-notices.js): it is read from the module graphs of
the actual build passes -- the application bundle and each Web Worker bundle --
together with a scan of the emitted assets that fails the build if any shipped
code could not be traced back to one of those graphs. Packages that this CLI
merely depends on at runtime -- which your package manager installs separately,
with their own license files intact -- are not repeated here.

Each section gives the package name and version, its declared license
identifier, and the verbatim license and notice files that the package ships.
`;

async function main() {
  // Checked first so a standalone run fails immediately instead of after a build.
  requireCliBuild();
  const packageDirs = new Set([...(await collectViewerPackages()), ...collectCliPackages()]);
  const entries = [...packageDirs]
    .map(describePackage)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seen = new Set();
  const sections = [];

  for (const entry of entries) {
    if (seen.has(entry.key)) {
      continue;
    }

    seen.add(entry.key);
    const note = PACKAGE_NOTES[entry.name];

    sections.push(
      [
        '='.repeat(80),
        entry.key,
        `License: ${entry.license}`,
        ...(note ? ['', note] : []),
        '='.repeat(80),
        '',
        entry.body,
      ].join('\n'),
    );
  }

  const content = `${HEADER}\n${sections.join('\n\n')}\n`;

  // Guards against the two failure modes a licensing review would flag: a
  // proprietary Font Awesome package sneaking back in, and an unlicensed
  // package being shipped without notice.
  const forbidden = [/pro-(light|regular|solid|duotone|thin|sharp)/i, /\bUNLICENSED\b/];

  for (const pattern of forbidden) {
    const match = pattern.exec(content);

    if (match) {
      fail(`generated notices contain a forbidden token: ${match[0]}`);
    }
  }

  writeFileSync(outFile, content, 'utf8');

  const synthesized = entries.filter((entry) => entry.synthesized).map((entry) => entry.key);

  console.log(`[third-party-notices] wrote dist/THIRD-PARTY-NOTICES.txt (${seen.size} packages)`);

  if (synthesized.length > 0) {
    console.log(
      `[third-party-notices] no license file shipped by ${synthesized.length} package(s), ` +
        `used canonical text: ${synthesized.join(', ')}`,
    );
  }
}

await main();
