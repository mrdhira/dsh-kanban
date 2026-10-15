/**
 * Typecheck all three projects without depending on `node_modules/.bin` being on PATH.
 *
 * A profile plugin resolves its devDependencies by walking up to the profile's hoisted
 * `node_modules`, so there is no local `.bin` to call. `createRequire` performs the same walk at
 * runtime, and the package's declared `bin` entry is the one entry point that is stable across
 * TypeScript generations: in 5.x `bin/tsc` is a JS shim over `lib/tsc.js`, and in the 7.x native
 * port it is a JS shim over the platform binary in `@typescript/typescript-<platform>` — while
 * `./lib/tsc.js` is not even in the package's `exports` map any more. Resolving the declared bin
 * and spawning it with this Node executable works for both.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const typescriptPackagePath = require.resolve('typescript/package.json');
const typescriptPackage = JSON.parse(readFileSync(typescriptPackagePath, 'utf8'));
const tscBin = join(dirname(typescriptPackagePath), typescriptPackage.bin.tsc);

const projects = ['tsconfig.json', 'tsconfig.dynamic.json', 'tsconfig.test.json'];

let failed = 0;
for (const project of projects) {
  const result = spawnSync(process.execPath, ['--max-old-space-size=384', tscBin, '-p', project, '--noEmit'], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    failed += 1;
    process.exitCode = 1;
  }
}

console.log(failed === 0 ? `typecheck: ${projects.length}/${projects.length} projects clean` : `typecheck: ${failed} project(s) failed`);
