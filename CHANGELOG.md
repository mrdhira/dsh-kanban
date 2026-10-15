# Changelog

All notable changes to `dsh-kanban`. The version identifies the generation the app is running; the
panel footer and `/api/kanban/health` both report the build id, which is
`dsh-kanban/<version>+<stamp>`.

## 0.1.0 — 2026-10-15

First working board. **Not yet released as 1.0.0**: the host half has not reloaded since the
`inject` fix, so the nine tools and the skill are not registered in the running app.

### Added

- **The store** (`src/store/**`) — one SQLite board at `$DSH_HOME/tasks/board.db`: schema and ordered
  migrations, an append-only event log written in the same transaction as every mutation, and
  optimistic concurrency through a per-card `rev`.
- **The policy engine** — one implementation of the rules, used by the tools, the HTTP route and the
  CLI: the Definition of Ready gating every exit from `backlog` except dropping, the Definition of
  Done gating `done`, WIP control (`in-progress` 2, `review` 1, ready queue 5), `expedite` as the
  only exception, priority and class of service as the human's to set, and every exception recorded
  on the card with a written reason.
- **The four flow metrics and the SLE** — WIP, throughput, work item age and cycle time, with a
  Service Level Expectation derived from the p85 of recent cycle time and honestly labelled `guess`
  until ten items have finished. Recomputed from the columns and cross-checked against the event log.
- **The generated view** — `tasks/todo.md` is rendered from the store, byte-stable and locale-free,
  refreshed by every writer, and checked for drift by `check-board.mjs`.
- **The pre-Kanban import** — the thirteen rows of the hand-authored board, ids preserved, with DoR
  checks ticked only where the old row actually carried the fact and no invented Definition of Done.
- **The panel** (`src/client/**`) — lanes for every state, drag-and-drop, a full keyboard path
  (`Alt+←/→`, `Enter`), the card drawer with both checklists, comments and history, search, saved
  views, a new-card composer, the sprint bar and the flow-metrics strip. Writes are optimistic and
  roll back with the host's own message.
- **The host surface** (`src/host/**`) — the `/api/kanban` route (`health`, `board` with a `since`
  cursor, `task/:id`, `export`, `POST mutate`), nine `kanban_*` tools, the `kanban` skill registered
  at runtime, and a probe record that reports what the plugin found when it loaded.
- **The CLI** (`bin/kanban.mjs`, built from `src/cli/kanban.ts`) — every verb, distinct exit codes
  (`3` policy refusal, `4` stale revision, `2` not found), and it refreshes the generated view after
  any write.
- **Tests** — 218 cases across the store, the policy tables, the metrics, the view, the import, the
  CLI as a black box through its exit codes, the browser model and drag arithmetic, and the panel
  under jsdom against a fake HTTP layer.

### Fixed during development

- The Definition of Ready was gating **dropping** a card, which makes "throw this away" harder than
  "do this". Dropping is now explicitly exempt.
- `compareInColumn` sorted by priority before hand position, so dragging a P3 above a P1 would
  silently do nothing. Position is now the truth and priority is a badge.
- Every tool and the skill failed with `cannot get property "tools" without inject`: Cordis gates
  *property* access on the declared `inject` list while `ctx.get()` is not gated. The plugin reported
  `status: ok` throughout, offering nothing.
- `Lane` and `Drawer` were called as plain functions while using hooks, which crashes with "Rendered
  more hooks than during the previous render" as soon as the lane count changes.
- The panel's `Drop` used `globalThis.prompt`, which the desktop renderer does not provide.
- The drift check compared elapsed time and reported a healthy board stale within a minute; it now
  compares state and was proved to still catch a real divergence.
- A CLI mutation left the generated view stale, so `check-board.mjs` failed after any shell write.

### Known gaps

- The nine tools and the skill need one app restart to load (a host change does not reload).
- `/api/kanban` is a prefix route, so it wins the longest-prefix match over the app's `/api` bridge
  and does not inherit that bridge's browser-session fence. Loopback-only plus the accepted
  single-user trust model is the mitigation; a per-launch token is deferred.
- No cumulative flow diagram, no right-sidebar tab, no multi-board.
