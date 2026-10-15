#!/usr/bin/env node
/**
 * Repair the timestamps the importer invented.
 *
 * Before this was fixed, `insertTask` stamped `started_at = finished_at = now` on any row inserted
 * directly as `done`, and `started_at = now` on a row inserted into a work-in-progress state. The
 * importer is the only caller that inserts rows that are not `backlog`, so every one of the board's
 * migrated cards was born with a **zero-length cycle time** — and the generated view advertised it:
 * "Throughput 11 in 7 days · Cycle time median 0d · SLE … (history, from 11 finished)" while the
 * event log held two moves. The metrics were not merely unproven; they were wrong, and this script
 * is how the existing rows are put right.
 *
 * It is deliberately narrow. It touches only rows the **importer** wrote (`created_by =
 * 'plugin:kanban-import'`) whose timestamps match the fabricated shape exactly:
 *
 *   - finished: `started_at = created_at AND finished_at = created_at`
 *   - in progress: `started_at = created_at` with no finish
 *
 * A card that genuinely started and finished in the same second is left alone, because its
 * `created_by` is not the importer. Idempotent: a second run finds nothing.
 *
 *   node scripts/repair-imported-timestamps.mjs            # dry run, prints what it would do
 *   node scripts/repair-imported-timestamps.mjs --apply    # writes
 *   node scripts/repair-imported-timestamps.mjs --db <path>
 *
 * Never run it with the app mid-write; it opens the board directly.
 */
import {
  defaultBoardPath,
  openBoard,
  readBoardRev,
  bumpBoardRev,
  withWrite,
  query,
  execute,
  boardRevision,
} from '../lib/v1/store/index.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbFlag = args.indexOf('--db');
const dbPath = dbFlag >= 0 ? (args[dbFlag + 1] ?? defaultBoardPath()) : defaultBoardPath();

const IMPORTED_BY = 'plugin:kanban-import';

const board = openBoard(dbPath);
try {
  const fabricated = query(
    board,
    `SELECT id, title, state, started_at, finished_at, created_at
       FROM tasks
      WHERE created_by = ?
        AND started_at IS NOT NULL
        AND started_at = created_at
        AND (finished_at IS NULL OR finished_at = created_at)`,
    [IMPORTED_BY]
  );

  console.log(`board        ${dbPath}`);
  console.log(`revision     ${readBoardRev(board)}`);
  console.log(`fabricated   ${fabricated.length} row(s) written by ${IMPORTED_BY}\n`);

  for (const row of fabricated) {
    console.log(`  ${row.id}  ${row.state.padEnd(12)} started=${row.started_at} finished=${row.finished_at ?? '—'}  ${row.title}`);
  }

  if (fabricated.length === 0) {
    console.log('\nnothing to repair');
  } else if (!apply) {
    console.log('\ndry run: pass --apply to clear those timestamps');
  } else {
    withWrite(board, () => {
      execute(
        board,
        `UPDATE tasks
            SET started_at = NULL, finished_at = NULL, rev = rev + 1
          WHERE created_by = ?
            AND started_at IS NOT NULL
            AND started_at = created_at
            AND (finished_at IS NULL OR finished_at = created_at)`,
        [IMPORTED_BY]
      );
      bumpBoardRev(board);
    });
    console.log(`\ncleared the invented timestamps on ${fabricated.length} row(s); revision now ${boardRevision(board)}`);
    console.log('run `bin/kanban.mjs mirror` to refresh the generated view');
  }
} finally {
  board.close();
}
