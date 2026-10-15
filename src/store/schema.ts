/**
 * The schema, as ordered migrations.
 *
 * Migrations are plain SQL strings applied in array order, with `PRAGMA user_version` as the
 * version. Every vocabulary list is interpolated from `types.ts` so the CHECK constraints and the
 * TypeScript unions cannot drift apart — a `CHECK` that disagrees with its union fails at the
 * worst possible moment, on a write.
 *
 * Two constraints are load-bearing rather than decorative:
 *
 * - `state <> 'dropped' OR dropped_reason IS NOT NULL` — an item cannot be abandoned silently.
 * - the same for entering `done` is deliberately **not** in SQL: the Definition of Done is a
 *   policy that can be explicitly excepted with a reason, and it belongs in the policy engine.
 */
import {
  CLASSES_OF_SERVICE,
  PRIORITIES,
  SPRINT_STATES,
  STATES,
  type SprintState,
} from './types.js';

/** The version this build writes. A change to `MIGRATIONS` increments it. */
export const SCHEMA_VERSION = 1;

/** `'a', 'b', 'c'` — the SQL form of a union, from its single source. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/** Table creation order respects foreign keys: `sprints` before `tasks`. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE sprints (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL CHECK (length(name) > 0),
    goal       TEXT NOT NULL DEFAULT '',
    start      TEXT NOT NULL,
    end        TEXT NOT NULL,
    state      TEXT NOT NULL CHECK (state IN (${inList(SPRINT_STATES)})),
    created_at TEXT NOT NULL,
    closed_at  TEXT,
    CHECK (end > start)
  );

  CREATE TABLE tasks (
    id               TEXT PRIMARY KEY CHECK (length(id) > 0),
    title            TEXT NOT NULL CHECK (length(trim(title)) > 0),
    outcome          TEXT,
    description      TEXT,
    acceptance       TEXT,
    state            TEXT NOT NULL CHECK (state IN (${inList(STATES)})),
    priority         TEXT NOT NULL CHECK (priority IN (${inList(PRIORITIES)})),
    class_of_service TEXT NOT NULL CHECK (class_of_service IN (${inList(CLASSES_OF_SERVICE)})),
    blocked_reason   TEXT,
    dropped_reason   TEXT,
    assignee         TEXT,
    project          TEXT,
    workspace        TEXT,
    sprint_id        TEXT REFERENCES sprints(id) ON DELETE SET NULL,
    estimate         REAL,
    due              TEXT,
    tags             TEXT NOT NULL DEFAULT '[]',
    links            TEXT NOT NULL DEFAULT '[]',
    folder           TEXT,
    parent_id        TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    position         REAL NOT NULL DEFAULT 0,
    rev              INTEGER NOT NULL DEFAULT 1,
    dor              TEXT NOT NULL DEFAULT '{}',
    dod              TEXT NOT NULL DEFAULT '{}',
    exceptions       TEXT NOT NULL DEFAULT '[]',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    started_at       TEXT,
    finished_at      TEXT,
    created_by       TEXT NOT NULL,
    updated_by       TEXT NOT NULL,
    CHECK (state <> 'dropped' OR dropped_reason IS NOT NULL),
    CHECK (started_at IS NULL OR started_at >= created_at),
    CHECK (finished_at IS NULL OR started_at IS NOT NULL)
  );

  CREATE INDEX tasks_by_state ON tasks (state, position);
  CREATE INDEX tasks_by_assignee ON tasks (assignee);
  CREATE INDEX tasks_by_project ON tasks (project);
  CREATE INDEX tasks_by_sprint ON tasks (sprint_id);
  CREATE INDEX tasks_by_updated ON tasks (updated_at);

  CREATE TABLE events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL,
    actor      TEXT NOT NULL,
    task_id    TEXT NOT NULL,
    kind       TEXT NOT NULL,
    from_state TEXT,
    to_state   TEXT,
    payload    TEXT NOT NULL DEFAULT '{}'
  );

  CREATE INDEX events_by_task ON events (task_id, at);
  CREATE INDEX events_by_time ON events (at);

  CREATE TABLE comments (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    at      TEXT NOT NULL,
    actor   TEXT NOT NULL,
    body    TEXT NOT NULL CHECK (length(trim(body)) > 0)
  );

  CREATE INDEX comments_by_task ON comments (task_id, at);

  CREATE TABLE templates (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL CHECK (length(name) > 0),
    description TEXT NOT NULL DEFAULT '',
    patch       TEXT NOT NULL DEFAULT '{}',
    order_index REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE views (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL CHECK (length(name) > 0),
    description TEXT NOT NULL DEFAULT '',
    filter      TEXT NOT NULL DEFAULT '{}',
    group_by    TEXT NOT NULL DEFAULT 'state',
    order_index REAL NOT NULL DEFAULT 0
  );
  `,
];

/** The three templates every new board starts with. */
export const SEED_TEMPLATES: readonly {
  id: string;
  name: string;
  description: string;
  patch: string;
  orderIndex: number;
}[] = [
  {
    id: 'feature',
    name: 'Feature',
    description: 'A user-visible capability with acceptance criteria.',
    patch: '{"priority":"p2-normal","classOfService":"standard","tags":["feature"]}',
    orderIndex: 0,
  },
  {
    id: 'bugfix',
    name: 'Bug fix',
    description: 'Something is wrong and is provably wrong: the failure comes first.',
    patch: '{"priority":"p1-high","classOfService":"standard","tags":["bug"]}',
    orderIndex: 1,
  },
  {
    id: 'research',
    name: 'Research spike',
    description: 'A question with a timebox and a written answer; the output is knowledge, not code.',
    patch: '{"priority":"p3-low","classOfService":"intangible","tags":["research"]}',
    orderIndex: 2,
  },
];

/** The two views every new board starts with. */
export const SEED_VIEWS: readonly {
  id: string;
  name: string;
  description: string;
  filter: string;
  groupBy: string;
  orderIndex: number;
}[] = [
  {
    id: 'board',
    name: 'Board',
    description: 'Everything still moving: backlog through review.',
    filter: '{"state":["backlog","ready","in-progress","review"]}',
    groupBy: 'state',
    orderIndex: 0,
  },
  {
    id: 'ageing',
    name: 'Ageing',
    description: 'Started but not finished: the cards the SLE is about.',
    filter: '{"state":["in-progress","review"]}',
    groupBy: 'state',
    orderIndex: 1,
  },
];

/** Guard for the one place a sprint-state string arrives from outside TypeScript. */
export function isSprintState(value: string): value is SprintState {
  return (SPRINT_STATES as readonly string[]).includes(value);
}
