import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const sha = (
  process.env.SHORT_SHA ?? execSync('git rev-parse --short HEAD').toString().trim()
).slice(0, 7);
if (!sha) throw new Error('Could not determine SHA');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const baseVersion = pkg.version.replace(/-[^-]+$/, '');
pkg.version = `${baseVersion}-${sha}`;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('Stamped:', pkg.version);
