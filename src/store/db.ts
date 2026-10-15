/**
 * The board connection: pragmas, migrations, the one-write-at-a-time transaction, and the meta
 * rows the rest of the store reads.
 *
 * `node:sqlite` is synchronous. That is a feature here, not an accident: one host process plus a
 * CLI cannot interleave two synchronous writes, so the only concurrency left is across processes,
 * which WAL plus `busy_timeout` plus the `rev` column already handle. The alternative — an async
 * driver — would buy nothing and would make every policy check a chance to interleave.
 *
 * Two facts about the driver are load-bearing and were observed, not assumed (see
 * `tasks/T-013-dsh-kanban/probes.md`):
 *
 * - **booleans are rejected** when binding (`TypeError`), so nothing in this store stores one:
 *   "blocked" is `blocked_reason IS NOT NULL`, and tags/links/checklists are JSON text.
 * - `PRAGMA user_version` is transactional, so a migration and its version bump commit together.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_DOW, DOD_CHECKS, DOR_CHECKS, STATES, type CheckId, type DefinitionOfWorkflow } from './types.js';
import { MIGRATIONS, SCHEMA_VERSION, SEED_TEMPLATES, SEED_VIEWS } from './schema.js';
import { InvalidError } from './errors.js';

/** A value the driver accepts. Deliberately excludes `boolean` — it throws on one. */
export type SqlValue = string | number | bigint | null | Uint8Array;

/** An open board. One instance owns one connection. */
export interface Board {
  readonly db: DatabaseSync;
  readonly path: string;
  close(): void;
  /** Set while a write transaction is open, so nesting fails loudly instead of half-committing. */
  writing: boolean;
}

/** `$DSH_HOME` when set, else `~/.dsh` — the same rule DSH itself uses for this home. */
export function dshHome(): string {
  const configured = process.env.DSH_HOME;
  return configured !== undefined && configured.length > 0 ? configured : join(homedir(), '.dsh');
}

/** The default store location: `$DSH_HOME/tasks/board.db`. */
export function defaultBoardPath(): string {
  return join(dshHome(), 'tasks', 'board.db');
}

/** The default generated mirror: `$DSH_HOME/tasks/todo.md`. */
export function defaultMirrorPath(): string {
  return join(dshHome(), 'tasks', 'todo.md');
}

/**
 * Open (creating if needed) the board at `path`.
 *
 * `:memory:` is supported for tests and skips both the directory creation and the WAL pragma
 * (WAL is a property of a file, and an in-memory database reports `memory`).
 */
export function openBoard(path: string): Board {
  const inMemory = path === ':memory:';
  if (!inMemory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const db = new DatabaseSync(path);
  if (!inMemory) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');

  const board: Board = {
    db,
    path,
    writing: false,
    close(): void {
      db.close();
    },
  };

  migrate(board);
  seed(board);
  return board;
}

/**
 * Apply every migration newer than the stored `user_version`, each in its own transaction.
 *
 * A database from the future is refused rather than opened: downgrading silently is how a board
 * loses rows it does not know about.
 */
export function migrate(board: Board): number {
  const row = board.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const current = Number(row?.user_version ?? 0);

  if (current > SCHEMA_VERSION) {
    throw new InvalidError(
      `board ${JSON.stringify(board.path)} is at schema version ${current}, newer than this build's ${SCHEMA_VERSION}; refusing to open it`
    );
  }

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    board.db.exec('BEGIN IMMEDIATE');
    try {
      board.db.exec(MIGRATIONS[version] as string);
      board.db.exec(`PRAGMA user_version = ${version + 1}`);
      board.db.exec('COMMIT');
    } catch (error) {
      try {
        board.db.exec('ROLLBACK');
      } catch {
        // The transaction is already gone; the original failure is the one that matters.
      }
      throw error;
    }
  }

  return SCHEMA_VERSION;
}

/**
 * Seed a brand-new board's meta rows and starter templates/views.
 *
 * Guarded on a missing `dow` key so an established board is opened read-mostly: the CLI opening
 * the board while the host is writing should not queue behind a needless transaction.
 */
export function seed(board: Board): void {
  if (readMeta(board, 'dow') !== undefined) return;

  const at = new Date().toISOString();
  withWrite(board, () => {
    ensureMeta(board, 'schema_version', String(SCHEMA_VERSION));
    ensureMeta(board, 'board_rev', '0');
    ensureMeta(board, 'board_title', 'Board');
    ensureMeta(board, 'dow', JSON.stringify(DEFAULT_DOW));
    ensureMeta(board, 'created_at', at);

    const template = board.db.prepare(
      'INSERT OR IGNORE INTO templates (id, name, description, patch, order_index) VALUES (?, ?, ?, ?, ?)'
    );
    for (const entry of SEED_TEMPLATES) {
      template.run(entry.id, entry.name, entry.description, entry.patch, entry.orderIndex);
    }

    const view = board.db.prepare(
      'INSERT OR IGNORE INTO views (id, name, description, filter, group_by, order_index) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const entry of SEED_VIEWS) {
      view.run(entry.id, entry.name, entry.description, entry.filter, entry.groupBy, entry.orderIndex);
    }

    bumpBoardRev(board);
  });
}

/**
 * Run `fn` inside one write transaction, committing on return and rolling back on throw.
 *
 * Not re-entrant, and it says so: a nested call would open a second `BEGIN IMMEDIATE` inside the
 * first, and SQLite would either error obscurely or — worse, on some paths — commit the inner
 * work early. One transaction per mutation is the invariant the event log depends on.
 */
export function withWrite<T>(board: Board, fn: () => T): T {
  if (board.writing) {
    throw new InvalidError('withWrite is not re-entrant: a store mutation may not open a second transaction');
  }
  board.writing = true;
  board.db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    board.db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      board.db.exec('ROLLBACK');
    } catch {
      // Nothing to undo if the transaction never opened or already aborted.
    }
    throw error;
  } finally {
    board.writing = false;
  }
}

export function query<T>(board: Board, sql: string, params: readonly SqlValue[] = []): T[] {
  return board.db.prepare(sql).all(...(params as SqlValue[])) as T[];
}

export function queryOne<T>(board: Board, sql: string, params: readonly SqlValue[] = []): T | undefined {
  return board.db.prepare(sql).get(...(params as SqlValue[])) as T | undefined;
}

export function execute(board: Board, sql: string, params: readonly SqlValue[] = []): void {
  board.db.prepare(sql).run(...(params as SqlValue[]));
}

export function readMeta(board: Board, key: string): string | undefined {
  const row = queryOne<{ value: string }>(board, 'SELECT value FROM meta WHERE key = ?', [key]);
  return row?.value;
}

export function ensureMeta(board: Board, key: string, value: string): void {
  execute(board, 'INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', [key, value]);
}

export function writeMeta(board: Board, key: string, value: string): void {
  execute(board, 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key,
    value,
  ]);
}

/** The board revision: bumped by every mutation, and the client's polling cursor. */
export function readBoardRev(board: Board): number {
  return Number(readMeta(board, 'board_rev') ?? '0');
}

export function bumpBoardRev(board: Board): number {
  const next = readBoardRev(board) + 1;
  writeMeta(board, 'board_rev', String(next));
  return next;
}

export function readBoardTitle(board: Board): string {
  return readMeta(board, 'board_title') ?? 'Board';
}

export function writeBoardTitle(board: Board, title: string): void {
  writeMeta(board, 'board_title', title);
}

/** The Definition of Workflow this board runs on. Falls back to the default if unreadable. */
export function readDow(board: Board): DefinitionOfWorkflow {
  const raw = readMeta(board, 'dow');
  if (raw === undefined) return DEFAULT_DOW;
  try {
    return JSON.parse(raw) as DefinitionOfWorkflow;
  } catch {
    return DEFAULT_DOW;
  }
}

/**
 * Validate a Definition of Workflow before it is stored.
 *
 * The DoW *is* the control — the WIP limits, the gates and the state policies all read from it — so
 * writing an unvalidated one over HTTP was the same as disabling WIP control: `wip['in-progress'] =
 * 'x'` made the limit comparison always false, and `dor: undefined` made every move throw a
 * `TypeError` from `missingChecks`. Both were reachable with no actor gate at all.
 *
 * Every field falls back to the current value when it is absent, so a partial update cannot erase
 * the policies it did not mention, and anything present must be exactly right or the whole write is
 * refused. A board with a half-applied Definition of Workflow is worse than one that rejected the
 * edit.
 */
export function validateDow(candidate: unknown, fallback: DefinitionOfWorkflow): DefinitionOfWorkflow {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new InvalidError('the Definition of Workflow must be an object');
  }
  const source = candidate as Record<string, unknown>;
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

  const wipSource = record(source.wip);
  const wip: Record<'in-progress' | 'review', number> = { ...fallback.wip };
  for (const state of ['in-progress', 'review'] as const) {
    const value = wipSource[state];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 99) {
      throw new InvalidError(`dow.wip["${state}"] must be a whole number of cards between 0 and 99`);
    }
    wip[state] = value;
  }

  const readyCapValue = source.readyCap;
  let readyCap = fallback.readyCap;
  if (readyCapValue !== undefined) {
    if (typeof readyCapValue !== 'number' || !Number.isInteger(readyCapValue) || readyCapValue < 0 || readyCapValue > 999) {
      throw new InvalidError('dow.readyCap must be a whole number of cards between 0 and 999');
    }
    readyCap = readyCapValue;
  }

  const sleSource = record(source.sle);
  const p = sleSource.p === undefined ? fallback.sle.p : sleSource.p;
  const days = sleSource.days === undefined ? fallback.sle.days : sleSource.days;
  if (typeof p !== 'number' || !(p > 0) || !(p <= 1)) {
    throw new InvalidError('dow.sle.p must be a probability greater than 0 and at most 1');
  }
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) {
    throw new InvalidError('dow.sle.days must be a whole number of days between 1 and 365');
  }
  const source_ = sleSource.source;
  const sleSourceName: 'history' | 'guess' = source_ === 'history' || source_ === 'guess' ? source_ : fallback.sle.source;

  const checks = (value: unknown, allowed: readonly CheckId[], name: string): readonly CheckId[] => {
    if (value === undefined) return name === 'dor' ? fallback.dor : fallback.dod;
    if (!Array.isArray(value)) throw new InvalidError(`dow.${name} must be an array of checklist ids`);
    const list: CheckId[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string' || !(allowed as readonly string[]).includes(entry)) {
        throw new InvalidError(`dow.${name} contains ${JSON.stringify(entry)}, which is not a known check`);
      }
      list.push(entry as CheckId);
    }
    if (list.length === 0) throw new InvalidError(`dow.${name} must keep at least one check, or the gate is not a gate`);
    return list;
  };

  const policiesSource = record(source.policies);
  const policies: Record<string, string> = { ...fallback.policies };
  for (const [state, text] of Object.entries(policiesSource)) {
    if (!(STATES as readonly string[]).includes(state)) {
      throw new InvalidError(`dow.policies names ${JSON.stringify(state)}, which is not a board state`);
    }
    if (typeof text !== 'string') throw new InvalidError(`dow.policies["${state}"] must be a string`);
    policies[state] = text;
  }

  return {
    wip,
    readyCap,
    sle: { p, days, source: sleSourceName },
    policies: policies as DefinitionOfWorkflow['policies'],
    dor: checks(source.dor, DOR_CHECKS, 'dor'),
    dod: checks(source.dod, DOD_CHECKS, 'dod'),
  };
}

/** Write the Definition of Workflow, **after** validating it. There is no other way in. */
export function writeDow(board: Board, dow: DefinitionOfWorkflow): void {
  writeMeta(board, 'dow', JSON.stringify(validateDow(dow, readDow(board))));
}

/** The next free position at the end of a column. */
export function nextPosition(board: Board, state: string): number {
  const row = queryOne<{ next: number | null }>(board, 'SELECT max(position) + 1 AS next FROM tasks WHERE state = ?', [
    state,
  ]);
  return row?.next ?? 0;
}
