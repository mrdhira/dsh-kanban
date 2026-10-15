/**
 * The one-way import of the pre-Kanban board.
 *
 * Twelve rows already existed in `tasks/todo.md` as a hand-authored Markdown table. This module
 * reads that table once and turns each row into a card, so the move to a store does not begin by
 * losing the board's history.
 *
 * Two decisions are deliberate:
 *
 * - **Idempotent by id.** Running it twice imports nothing the second time, so it is safe to call
 *   on start-up while the Markdown file is still lying around.
 * - **No fabricated evidence.** The Definition of Ready checks are ticked only where the legacy
 *   row actually carries the fact (a title is an outcome; a non-empty acceptance column is
 *   acceptance; a non-empty write scope is a scope). Size was never recorded, so it stays
 *   unticked, and a row imported as `done` keeps an empty Definition of Done with its provenance
 *   written into the description — claiming checks a row never had would be the kind of unverified
 *   claim this board exists to prevent.
 */
import type { Board } from './db.js';
import { blockTask, importTask } from './repo.js';
import { DOR_CHECKS, type Actor, type CheckId, type CreateTaskInput, type Link, type State } from './types.js';

export interface ParsedTodoRow {
  readonly id: string;
  readonly title: string;
  readonly state: State;
  readonly blockedReason: string | null;
  readonly assignee: string | null;
  readonly writeScope: string | null;
  readonly acceptance: string | null;
  readonly links: readonly Link[];
  readonly folder: string | null;
}

/** The legacy vocabulary, mapped onto the board's states. `blocked` becomes a flag. */
const STATE_MAP: Readonly<Record<string, State>> = {
  inbox: 'backlog',
  backlog: 'backlog',
  planned: 'ready',
  ready: 'ready',
  'in-progress': 'in-progress',
  inprogress: 'in-progress',
  'in progress': 'in-progress',
  review: 'review',
  done: 'done',
  dropped: 'dropped',
  cancelled: 'dropped',
  canceled: 'dropped',
};

const EMPTY = new Set(['', '—', '-', 'n/a', 'none']);

function clean(value: string): string | null {
  const trimmed = value.replace(/`/g, '').trim();
  return EMPTY.has(trimmed.toLowerCase()) ? null : trimmed;
}

/** Every Markdown link in a cell, with `file` distinguished from `url` by scheme. */
function linksIn(cell: string): Link[] {
  const out: Link[] = [];
  const pattern = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match = pattern.exec(cell);
  while (match !== null) {
    const label = (match[1] ?? '').trim();
    const ref = (match[2] ?? '').trim();
    if (ref.length > 0) {
      out.push(ref.startsWith('http') ? { kind: 'url', ref, label } : { kind: 'file', ref, label });
    }
    match = pattern.exec(cell);
  }
  return out;
}

/**
 * The task folder a row points at.
 *
 * The legacy table links `T-001-badge-status-tag/requirements.md` relative to `tasks/`, so the
 * folder is that first segment. Newer rows link the folder path in full, which is also accepted.
 */
function folderFrom(links: readonly Link[]): string | null {
  for (const link of links) {
    if (link.kind !== 'file') continue;
    const segments = link.ref.replace(/^\.\//, '').split('/');
    const first = segments[0];
    if (first === undefined || first.length === 0) continue;
    if (first.startsWith('T-')) return `tasks/${first}`;
    if (first === 'tasks') {
      const second = segments[1];
      if (second !== undefined && second.startsWith('T-')) return `tasks/${second}`;
    }
  }
  return null;
}

/** Read every `| T-### | … |` row. Tolerant of column count and of a `blocked` state. */
export function parseTodoMd(text: string): ParsedTodoRow[] {
  const rows: ParsedTodoRow[] = [];

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*\|\s*(T-\d+)\s*\|/.exec(line);
    if (match === null) continue;
    const id = match[1] as string;

    const cells = line
      .split('|')
      .slice(1)
      .map((cell) => cell.trim());
    if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();

    const title = clean(cells[1] ?? '') ?? id;
    const rawState = (clean(cells[2] ?? '') ?? 'backlog').toLowerCase();
    const assignee = clean(cells[3] ?? '');
    const writeScope = clean(cells[4] ?? '');
    const acceptance = clean(cells[5] ?? '');
    const links = linksIn(cells.slice(6).join(' '));

    const blocked = rawState === 'blocked';
    const state: State = blocked ? 'in-progress' : (STATE_MAP[rawState] ?? 'backlog');

    rows.push({
      id,
      title,
      state,
      blockedReason: blocked ? 'marked blocked on the pre-Kanban board' : null,
      assignee,
      writeScope,
      acceptance,
      links,
      folder: folderFrom(links),
    });
  }

  return rows;
}

export interface ImportResult {
  readonly imported: readonly string[];
  readonly skipped: readonly string[];
  readonly rows: number;
}

/**
 * Import every row that does not already exist.
 *
 * Each card is one transaction, so a failure part-way leaves the rows already imported in place —
 * and safely re-runnable, because the ids that landed are skipped next time.
 */
export function importTodoMd(
  board: Board,
  text: string,
  options: { readonly actor: Actor; readonly now?: Date }
): ImportResult {
  const rows = parseTodoMd(text);
  const imported: string[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const exists = board.db.prepare('SELECT id FROM tasks WHERE id = ?').get(row.id) as { id: string } | undefined;
    if (exists !== undefined) {
      skipped.push(row.id);
      continue;
    }

    const dor: CheckId[] = [];
    if (row.title.length > 0) dor.push('outcome');
    if (row.acceptance !== null) dor.push('acceptance');
    if (row.writeScope !== null) dor.push('write-scope');

    const provenance: string[] = [
      `Imported from the pre-Kanban board (\`tasks/todo.md\`) on ${(options.now ?? new Date()).toISOString().slice(0, 10)}.`,
    ];
    if (row.writeScope !== null) provenance.push(`Write scope: ${row.writeScope}`);
    if (row.blockedReason !== null) provenance.push('It was marked blocked before the board had a blocked flag.');
    if (row.state === 'done') {
      provenance.push('It was already done before this board had a Definition of Done, so its DoD is empty rather than assumed.');
    }

    const input: CreateTaskInput = {
      id: row.id,
      title: row.title,
      description: provenance.join(' '),
      acceptance: row.acceptance,
      state: row.state,
      assignee: row.assignee,
      links: row.links,
      folder: row.folder,
      dor: dor.filter((check) => (DOR_CHECKS as readonly string[]).includes(check)),
    };

    const created = importTask(board, input, options);
    // A second transaction on purpose: `withWrite` refuses to nest, and blocking is a real,
    // separately-recorded event rather than part of the insert.
    if (row.blockedReason !== null) blockTask(board, created.id, row.blockedReason, options);
    imported.push(row.id);
  }

  return { imported, skipped, rows: rows.length };
}
