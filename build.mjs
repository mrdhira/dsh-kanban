/**
 * Build both halves of the plugin.
 *
 * The host half is ESM for the Loader and is emitted **per module** (`bundle: false`) so `lib/`
 * mirrors `src/` file for file: the suite imports the built modules directly, and bundling once
 * left stale per-module artifacts behind that the tests happily validated. The browser half is
 * the lazy CommonJS factory the client module loader evaluates, exactly as a hand-written
 * bundle would be.
 *
 * Nothing is bundled from outside this package: `@deepseek-ai/*`, react, react-dom and scheduler
 * stay external, which is also what the client bundle-purity gate requires.
 */
import { build } from 'esbuild';
import { chmodSync as chmod, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const buildId = `${pkg.name}/${pkg.version}+${stamp}`;

const shared = {
  bundle: true,
  logLevel: 'info',
  define: { __BUILD_ID__: JSON.stringify(buildId) },
};

/** Every `.ts` under `dir`, recursively — the host module set grows with the feature. */
function tsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) tsFiles(path, out);
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

// `outbase: 'src'` keeps `src/host/index.ts` at `lib/v1/host/index.js`, which is what
// `package.json#main` and the Loader both name.
//
// The browser half's **pure** modules are emitted here as well as being bundled below. Same writer,
// same run, one source: the bundle is what ships, and the per-module copy is what the suite imports
// so that "tests exercise built artifacts" stays true for the panel's model and drag logic without
// a test reaching into `src/`. `src/client/index.cts` is excluded by `tsFiles` (it only collects
// `.ts`), which is right — it exists only as the bundle entry.
await build({
  ...shared,
  bundle: false,
  entryPoints: [...tsFiles('src/host'), ...tsFiles('src/store'), ...tsFiles('src/client')],
  outbase: 'src',
  outdir: 'lib/v1',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});

// The CLI is bundled rather than emitted per module: it is one executable that must run from a
// clean checkout with no relative-import graph to get wrong, and esbuild hoists the shebang so
// `bin/kanban.mjs` stays directly executable. It is authored in TypeScript like everything else —
// a `.mjs` file cannot carry type annotations, which is exactly how the first draft failed.
await build({
  ...shared,
  entryPoints: ['src/cli/kanban.ts'],
  outfile: 'bin/kanban.mjs',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});

await chmod(new URL('./bin/kanban.mjs', import.meta.url), 0o755);

// Declarations, so `lib/**` is a typed mirror of `src/**` and the suite can import the built
// modules without the `any`-shaped hole that plain JavaScript exports leave.
const require = createRequire(import.meta.url);
const typescriptPackagePath = require.resolve('typescript/package.json');
const typescriptPackage = JSON.parse(readFileSync(typescriptPackagePath, 'utf8'));
const tsc = join(dirname(typescriptPackagePath), typescriptPackage.bin.tsc);
const declarations = spawnSync(process.execPath, ['--max-old-space-size=384', tsc, '-p', 'tsconfig.build.json'], {
  stdio: 'inherit',
});
if (declarations.status !== 0) {
  console.error('declaration build failed');
  process.exit(declarations.status ?? 1);
}

// `.cts` marks the browser half as CommonJS to both esbuild and tsc: the loader's factory
// returns `module.exports`, and `package.json` is `"type": "module"` for the host half.
await build({
  ...shared,
  entryPoints: ['src/client/index.cts'],
  outfile: 'lib/v1/client.js',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react-dom', 'scheduler', '@deepseek-ai/*'],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports; // ${buildId}`,
  },
  footer: { js: 'return module.exports; } });' },
});
