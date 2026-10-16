#!/usr/bin/env node
/**
 * The whole gate, in one command, with a verdict that cannot be misread.
 *
 * Written after a real failure: the build broke (a backtick inside the stylesheet's template literal) and
 * the failure hid behind `tail -1`, because the guard prints its own memory line LAST. The suite then went
 * green against a **stale bundle** -- the exact trap this project already had a freshness check for, walked
 * into anyway. Composing ad-hoc pipelines by hand is what allowed it, so the pipeline is now a file.
 *
 * Usage:  node scripts/gate.mjs          (run it through the guard like everything else)
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const steps = [
  ['build', process.execPath, ['build.mjs']],
  ['typecheck', process.execPath, ['scripts/typecheck.mjs']],
  ['tests', process.execPath, ['--test', '--test-isolation=none', '--test-timeout=30000', '--test-force-exit', 'test/*.test.ts']],
  ['freshness', process.execPath, ['../../scripts/checks/check-build-freshness.mjs', '.']],
];

const failures = [];
for (const [name, command, args] of steps) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  // The verdict is the *process exit code*, never the last line: that is how the failure hid.
  // Verdict by exit code -- except freshness, which *warns* by design (the running app is older than the
  // build, so a reload is pending) and still exits non-zero. Its own FAIL word is the gate failure.
  const verdict = name === 'freshness' ? (/FAIL/.test(output) ? 'FAIL' : 'warn') : result.status === 0 ? 'pass' : 'FAIL';
  if (verdict === 'FAIL') failures.push(name);
  const line = output
    .split('\n')
    .map((text) => text.trim())
    .filter((text) => /^(typecheck|WARN|FAIL|ℹ (tests|pass|fail)|.*(ERROR|error TS)|✖)/.test(text))
    .slice(0, 6)
    .join(' | ');
  console.log(`${verdict.padEnd(5)} ${name.padEnd(10)} ${line}`);
}

console.log(failures.length === 0 ? '\nGATE PASS' : `\nGATE FAIL: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
