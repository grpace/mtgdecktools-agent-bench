// Builds the mtgdt-bench npm package into dist/: the CLI and the scripted random player as single ES modules that
// run on plain Node 22 (no tsx, no dependencies), plus the assets they read (join and setup prompts, engine lock).
//   node scripts/bench/build.mjs        (also runs on `npm pack` / `npm publish` in scripts/bench)
import { build } from 'esbuild';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const here = import.meta.dirname;
const root = join(here, '../..');
const dist = join(here, 'dist');
const { version } = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

rmSync(dist, { recursive: true, force: true });
// Some bundled dependencies (the MCP SDK's validators) are CommonJS: give the ES module a `require`.
const banner = "import { createRequire as __mtgdtCreateRequire } from 'node:module'; const require = __mtgdtCreateRequire(import.meta.url);";
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none', logLevel: 'warning' };
await build({
  ...common, entryPoints: [join(here, 'cli.ts')], outfile: join(dist, 'cli.js'),
  banner: { js: `#!/usr/bin/env node\n${banner}` }, define: { __BENCH_VERSION__: JSON.stringify(version) },
});
await build({ ...common, entryPoints: [join(root, 'scripts/mcp-random-agent.mjs')], outfile: join(dist, 'random-agent.mjs'), banner: { js: banner } });
chmodSync(join(dist, 'cli.js'), 0o755);

for (const [from, to] of [
  ['prompts/join.md', 'prompts/join.md'],
  ['prompts/setup.md', 'prompts/setup.md'],
  ['engine/phase.lock.json', 'engine/phase.lock.json'],
  ['LICENSE', 'LICENSE'],
  ['NOTICE', 'NOTICE'],
]) {
  mkdirSync(dirname(join(dist, to)), { recursive: true });
  copyFileSync(join(root, from), join(dist, to));
}
console.log(`built mtgdt-bench ${version} → ${dist}`);
