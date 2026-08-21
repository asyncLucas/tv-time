// Stamp src/build-info.json with the package version and the build moment.
// Runs as npm's `prebuild`, so every `npm run build` (locally and in the
// Pages deploy) refreshes what the Settings "About" footer shows. The file is
// committed so `ng serve` and tests work without ever running a build.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));

const info = {
  version: pkg.version,
  builtAt: new Date().toISOString(),
};
writeFileSync(`${root}src/build-info.json`, JSON.stringify(info, null, 2) + '\n');
console.log(`build-info.json stamped: v${info.version} @ ${info.builtAt}`);
