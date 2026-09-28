// Publishes the current checkout under the `poc` dist-tag as <base>-poc-<sha7>.
// package.json is stamped for the publish and always restored afterwards.
// Extra args are passed through to `pnpm publish` (e.g. --otp=123456, --dry-run).
import { readFileSync, writeFileSync } from 'fs';
import { execFileSync, spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');

// Official semver 2.0.0 grammar (no build metadata needed here).
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

function fail(message) {
  console.error(`release:poc: ${message}`);
  process.exit(1);
}

function git(...args) {
  // trimEnd only: porcelain status lines start with a meaningful space column.
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trimEnd();
}

let sha;
let dirty;
try {
  sha = git('rev-parse', '--short=7', 'HEAD');
  dirty = git('status', '--porcelain');
} catch {
  fail('could not read git state (not a git repo, or no commits yet).');
}
if (!/^[0-9a-f]{7,}$/.test(sha)) fail(`unexpected git SHA "${sha}".`);
if (dirty) {
  fail(
    `working tree is dirty, so ${sha} would not describe what gets published.\n` +
      `Commit or stash these first:\n${dirty}`,
  );
}

const original = readFileSync(pkgPath);
const pkg = JSON.parse(original.toString('utf8'));
const baseVersion = pkg.version.replace(/[-+].*$/, '');
const version = `${baseVersion}-poc-${sha}`;
if (!SEMVER.test(version)) fail(`computed version "${version}" is not valid semver.`);

let restored = false;
function restore() {
  if (restored) return;
  writeFileSync(pkgPath, original);
  restored = true;
}

const passthrough = process.argv.slice(2);
console.log(`Publishing ${pkg.name}@${version} with dist-tag "poc"`);
if (passthrough.length) console.log(`Extra publish args: ${passthrough.join(' ')}`);

let code = 1;
try {
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  const child = spawn(
    'pnpm',
    ['publish', '--tag', 'poc', '--access', 'public', '--no-git-checks', ...passthrough],
    { cwd: root, stdio: 'inherit' },
  );
  // Ctrl-C reaches the child via the process group; SIGTERM to this process
  // alone is forwarded. Either way we wait for the child, then restore.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  code = await new Promise((resolve) => {
    child.on('error', (err) => {
      console.error(`release:poc: failed to start pnpm: ${err.message}`);
      resolve(1);
    });
    child.on('exit', (exitCode, signal) =>
      resolve(exitCode ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)),
    );
  });
} finally {
  restore();
}

if (code === 0 && passthrough.includes('--dry-run')) {
  console.log(`\nDry run of ${pkg.name}@${version} complete; nothing was published.`);
} else if (code === 0) {
  console.log(`\nPublished ${pkg.name}@${version} (dist-tag "poc").`);
  console.log(`Install: npm i -g ${pkg.name}@poc`);
  console.log(`   or:   npm i -g ${pkg.name}@${version}`);
} else {
  console.error(`\nrelease:poc: pnpm publish exited with code ${code}; package.json restored.`);
}
process.exit(code);
