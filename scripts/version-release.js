import { readFileSync } from 'fs';

const rawVersion = process.env.RELEASE_VERSION;
if (!rawVersion) throw new Error('RELEASE_VERSION environment variable is required');
const tagVersion = rawVersion.replace(/^v/, '');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.version !== tagVersion) {
  console.error(`Version mismatch: tag is "${tagVersion}" but package.json has "${pkg.version}"`);
  process.exit(1);
}
console.log('Version check passed:', pkg.version);
