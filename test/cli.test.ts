/**
 * The CLI, as a black box.
 *
 * This is the only test that runs the **built executable** the way the human will, including its
 * exit codes — which is the point: `requirements.md` is written so that acceptance is provable from
 * the shell ("`kanban show T-013` after the drag"), and a suite that only tested the store
 * functions would leave the interface between them untested.
 *
 * Table-driven, ordered by the code flow: the happy path first, then each refusal in the order the
 * policy engine produces it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../bin/kanban.mjs', import.meta.url).pathname;
const DOR = ['outcome', 'acceptance', 'write-scope', 'estimate'] as const;

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A fresh board per test: `--db` and `--mirror` both point inside the sandbox. */
function sandbox(): { dir: string; run: (...args: string[]) => Run } {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-cli-'));
  return {
    dir,
    run: (...args) => {
      const result = spawnSync(process.execPath, [CLI, '--db', join(dir, 'board.db'), '--mirror', join(dir, 'todo.md'), ...args], {
        encoding: 'utf8',
      });
      return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
  };
}

/** Create a card and tick its whole Definition of Ready, the way refinement actually goes. */
function refined(run: (...args: string[]) => Run, title: string, id: string): void {
  run('add', '--title', title, '--id', id);
  for (const check of DOR) run('check', id, 'dor', check);
}

// ------------------------------------------------------------------ positive cases

test('where names the board and the mirror it will write', () => {
  const { dir, run } = sandbox();
  const result = run('where');
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(join(dir, 'board.db').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  rmSync(dir, { recursive: true, force: true });
});

test('add then list shows the card in the backlog with its id', () => {
  const { dir, run } = sandbox();
  const added = run('add', '--title', 'a card', '--project', 'dsh');
  assert.equal(added.status, 0);
  assert.match(added.stdout, /T-001 created in backlog/);
  const listed = run('list');
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, /T-001/);
  assert.match(listed.stdout, /backlog/);
  rmSync(dir, { recursive: true, force: true });
});

test('a refined card can be moved ready and then into work', () => {
  const { dir, run } = sandbox();
  refined(run, 'a card', 'T-001');
  assert.equal(run('move', 'T-001', 'ready').status, 0);
  const moved = run('move', 'T-001', 'in-progress');
  assert.equal(moved.status, 0);
  assert.match(moved.stdout, /T-001 → in-progress/);
  rmSync(dir, { recursive: true, force: true });
});

test('check ticks and untick a checklist item', () => {
  const { dir, run } = sandbox();
  run('add', '--title', 'a card');
  assert.match(run('check', 'T-001', 'dor', 'outcome').stdout, /ticked/);
  assert.match(run('check', 'T-001', 'dor', 'outcome', '--off').stdout, /unticked/);
  rmSync(dir, { recursive: true, force: true });
});

test('comment, block and unblock are recorded', () => {
  const { dir, run } = sandbox();
  run('add', '--title', 'a card');
  assert.equal(run('comment', 'T-001', '--body', 'proposing p1').status, 0);
  const blocked = run('block', 'T-001', '--reason', 'waiting on the vendor');
  assert.equal(blocked.status, 0);
  assert.match(run('show', 'T-001').stdout, /waiting on the vendor/);
  assert.equal(run('unblock', 'T-001').status, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('dropping with a reason keeps the card, with the reason recorded', () => {
  const { dir, run } = sandbox();
  run('add', '--title', 'a card');
  const dropped = run('drop', 'T-001', '--reason', 'superseded by T-002');
  assert.equal(dropped.status, 0);
  assert.match(run('show', 'T-001').stdout, /superseded by T-002/);
  rmSync(dir, { recursive: true, force: true });
});

test('the human may set a priority and a class of service', () => {
  const { dir, run } = sandbox();
  run('add', '--title', 'a card');
  assert.equal(run('update', 'T-001', '--priority', 'p0-critical').status, 0);
  assert.equal(run('update', 'T-001', '--class', 'expedite').status, 0);
  assert.match(run('show', 'T-001').stdout, /p0-critical/);
  rmSync(dir, { recursive: true, force: true });
});

test('a sprint of 31 days can be created and started', () => {
  const { dir, run } = sandbox();
  const created = run('sprint', 'create', '--name', 'Sprint 1', '--goal', 'the board works', '--start', '2026-10-01', '--end', '2026-11-01');
  assert.equal(created.status, 0);
  assert.match(created.stdout, /S-001/);
  assert.equal(run('sprint', 'start', '--id', 'S-001').status, 0);
  assert.match(run('sprint', 'list').stdout, /active/);
  rmSync(dir, { recursive: true, force: true });
});

test('metrics reports the four flow metrics and the SLE', () => {
  const { dir, run } = sandbox();
  refined(run, 'a card', 'T-001');
  run('move', 'T-001', 'ready');
  run('move', 'T-001', 'in-progress');
  const metrics = run('metrics');
  assert.equal(metrics.status, 0);
  assert.match(metrics.stdout, /WIP\s+1/);
  assert.match(metrics.stdout, /Throughput/);
  assert.match(metrics.stdout, /Cycle time/);
  assert.match(metrics.stdout, /Work item age/);
  assert.match(metrics.stdout, /SLE\s+85% ≤ 3d \(guess/);
  rmSync(dir, { recursive: true, force: true });
});

test('--json emits a machine-readable board', () => {
  const { dir, run } = sandbox();
  run('add', '--title', 'a card');
  const result = run('list', '--json');
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as { tasks: { id: string }[]; counts: Record<string, number> };
  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.counts.backlog, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('export prints the generated markdown without rewriting it, and mirror writes it', () => {
  const { dir, run } = sandbox();
  run('add', '--title', 'a card');
  const afterAdd = readFileSync(join(dir, 'todo.md'), 'utf8');
  assert.match(afterAdd, /generated by dsh-kanban/, 'a write refreshes the view');

  const exported = run('export');
  assert.equal(exported.status, 0);
  assert.match(exported.stdout, /generated by dsh-kanban/);
  assert.equal(readFileSync(join(dir, 'todo.md'), 'utf8'), afterAdd, 'export must not write');

  assert.equal(run('mirror').status, 0);
  assert.match(readFileSync(join(dir, 'todo.md'), 'utf8'), /T-001/);
  rmSync(dir, { recursive: true, force: true });
});

test('any command that changes the board also refreshes the generated view', () => {
  const { dir, run } = sandbox();
  run('add', '--title', 'a card');
  refined(run, 'another card', 'T-002');
  run('move', 'T-002', 'ready');
  const view = readFileSync(join(dir, 'todo.md'), 'utf8');
  assert.match(view, /\| T-002 \|/, 'the new card is in the view');
  assert.match(view, /`ready`/, 'and in the state it was moved to');

  // The escape hatch for a caller that wants the store changed and the view left alone.
  run('update', 'T-002', '--outcome', 'written without mirroring', '--no-mirror');
  assert.doesNotMatch(readFileSync(join(dir, 'todo.md'), 'utf8'), /written without mirroring/);
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ refusals, in policy order

test('refused (3): leaving the backlog without its Definition of Ready, naming what is missing', () => {
  const { dir, run } = sandbox();
  run('add', '--title', 'a card');
  const result = run('move', 'T-001', 'ready');
  assert.equal(result.status, 3);
  assert.match(result.stderr, /Definition of Ready/);
  assert.match(result.stderr, /missing: outcome, acceptance, write-scope, estimate/);
  rmSync(dir, { recursive: true, force: true });
});

test('refused (3): the WIP limit, counted from the board', () => {
  const { dir, run } = sandbox();
  refined(run, 'one', 'T-001');
  refined(run, 'two', 'T-002');
  refined(run, 'three', 'T-003');
  run('move', 'T-001', 'in-progress');
  run('move', 'T-002', 'in-progress');
  const third = run('move', 'T-003', 'in-progress');
  assert.equal(third.status, 3);
  assert.match(third.stderr, /in-progress limit is 2/);
  rmSync(dir, { recursive: true, force: true });
});

test('refused (3): an agent may not set a priority', () => {
  const { dir, run } = sandbox();
  run('add', '--title', 'a card');
  const result = run('update', 'T-001', '--priority', 'p0-critical', '--actor', 'agent:sess-1');
  assert.equal(result.status, 3);
  assert.match(result.stderr, /priority is the human's to set/);
  rmSync(dir, { recursive: true, force: true });
});

test('refused (3): dropping without a reason', () => {
  const { dir, run } = sandbox();
  run('add', '--title', 'a card');
  const result = run('drop', 'T-001');
  assert.equal(result.status, 3);
  assert.match(result.stderr, /requires a reason/);
  rmSync(dir, { recursive: true, force: true });
});

test('refused (3): a sprint longer than a month', () => {
  const { dir, run } = sandbox();
  const result = run('sprint', 'create', '--name', 'too long', '--start', '2026-10-01', '--end', '2026-11-02');
  assert.equal(result.status, 3);
  assert.match(result.stderr, /may not exceed 31 days/);
  rmSync(dir, { recursive: true, force: true });
});

test('refused (4): a stale revision, so a write cannot silently overwrite', () => {
  const { dir, run } = sandbox();
  run('add', '--title', 'a card');
  const first = run('update', 'T-001', '--outcome', 'written once', '--rev', '1');
  assert.equal(first.status, 0);
  const stale = run('update', 'T-001', '--outcome', 'written again', '--rev', '1');
  assert.equal(stale.status, 4);
  assert.match(stale.stderr, /changed since it was read/);
  assert.match(run('show', 'T-001').stdout, /written once/);
  rmSync(dir, { recursive: true, force: true });
});

test('refused (2): an unknown card', () => {
  const { dir, run } = sandbox();
  const result = run('show', 'T-404');
  assert.equal(result.status, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('refused (5): an invalid check id, and an unknown command is a usage error (1)', () => {
  const { dir, run } = sandbox();
  run('add', '--title', 'a card');
  assert.equal(run('check', 'T-001', 'dor', 'evidence').status, 5);
  assert.equal(run('wibble').status, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('help exits 0 and documents every command', () => {
  const { dir, run } = sandbox();
  const result = run('help');
  assert.equal(result.status, 0);
  for (const command of ['list', 'show', 'add', 'update', 'move', 'check', 'block', 'drop', 'sprint', 'metrics', 'mirror', 'migrate']) {
    assert.match(result.stdout, new RegExp(`kanban ${command}`));
  }
  rmSync(dir, { recursive: true, force: true });
});
