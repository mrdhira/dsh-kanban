# Changelog

All notable changes to `dsh-kanban`. The version identifies the generation the app is running; the
panel footer and `/api/kanban/health` both report the build id, which is
`dsh-kanban/<version>+<stamp>`.

## Unreleased — SQLite only

The board is now one file, `$DSH_HOME/.kanban/board.db`. The old folder tree, the generated Markdown
view and every writer that existed to keep them in step are gone.

### Removed

- **The Markdown mirror**: `renderTodoMd` and its module, `GET /export`, the `mirror` mutation, the
  `kanban_board` actions `mirror` and `export`, and the CLI's `mirror` and `export` verbs. `--no-mirror`
  and the `mirror`/`mirrorPath` settings go with them.
- **The legacy importer**: `migrate-todo.ts`, the `import-todo` mutation, and `bin/kanban.mjs migrate`.
  The board it imported from no longer exists.
- **The folder-tree check**: `check-board.mjs` validated rows against per-card folders and the
  generated view; both are gone, so the check is too. The `folder` column remains as history and is
  not a link.

### Changed

- `defaultBoardPath()` is `$DSH_HOME/.kanban/board.db`; the parent directory is created on first open,
  so a fresh install needs no `tasks/` tree at all.
- The `kanban` skill now says the database is the only copy, and lesson intake lives at
  `~/.dsh/memory/lessons.md`.

## Unreleased — distill pass on the panel

Dhira's verdict on the panel was *"there are too much, too complex at front, should be easy enough
to use and direct"*, after `critique` scored *Aesthetic and Minimalist* 2/10 and the parity pass
answered it by **adding** controls. This pass keeps every capability and removes the surface.

### Removed from the front, and where it went

- **The create row is a title and `Add`.** Priority and class of service are the store's defaults
  (`p2-normal` / `standard`) at creation and are set in the card drawer, one step later, which is
  also where an agent's `kanban_create` values can be edited. *Watch:* whether a human creating a
  `p1` card finds the drawer in one move.
- **The metrics strip leads with two numbers** (`WIP n/limit`, `oldest Xd vs SLE Yd`) and the
  history — cycle median, p85 and mean, throughput, the SLE's basis — opens behind `More metrics`.
  The disclosure carries all three cycle readings rather than the median alone; `kanban_metrics`
  remains the full answer, including each band's own basis.
- **The host diagnostic line** (`host … · __DSH_TRANSPORT__.streamBaseUrl`) is behind a `Host`
  toggle. The error notice that replaces the lanes on a failed read still names the URL, the origin
  and the document, which is the only moment the line was worth reading.
- **The state-filter chip row is gone.** It repeated the lane headers, and the two saved views
  (`Board`, `Ageing`) already filter by state. The panel's own `All` button stays: it is **not** one
  of the seeded views, it is the only control that shows `done`, and without it choosing `Board`
  would be a one-way door. State filtering is unchanged for `kanban_list`, `bin/kanban.mjs` (which
  still takes `--state`) and the other tools — but **the panel cannot ask for an arbitrary state set
  any more**: the seeded views, `All` and `Dropped` are the only state questions it can put, and
  that trade was approved in the distill rather than lost by accident.
- **Card chips carry only what demands attention** — `blocked`, the P0/P1 word, an age band past
  `fresh`, and `expedite`. Class, assignee, project and sprint moved to the drawer, which already
  printed all four. `expedite` keeps its word although it is a class: its other signal on the card
  is a red hairline, and a state that is only a colour is not a state a reader can be trusted to see.
- **The drawer leads with one move** (the next state in board order) and hides every other target,
  `Block`, `Drop`, the reason fields, `Exception…` and the numeric position behind `More…`. The two
  checklists and the comment stay visible — they are the gate and the conversation. `Unblock` is the
  exception: it sits on the notice that names the blocker, because a blocked card is the one case
  where the obvious move is not a move.

No capability became unreachable; the DOM suite pins each one (`test/client.dom.test.ts`, the `D1`
/ `D5` / `D6` cases and the updated `A1`–`A3`, `C9`). The state-chip helpers `activeStates` and
`filterableStates` went with the chip row. No CSS rule was orphaned.

### Fixed after the independent review

The reviewer read the distill and polish commits against the code rather than the tests and found
six places where this file and DESIGN.md claimed something the code did not do. All six are fixed,
in the code where the intent was right and in the claim where it was not:

- **The `over limit` chip really is a warning now** (`kb-chip kb-chip-warn`): the stylesheet authored
  the class and the lane never emitted it, so OQ14 described a chip that looked like every other one.
- **The dead `kb-lane-loading` push is gone**, and the bare `kb-age` hook with it. `P4.11` now walks
  *every* class the components file emits against the sheet, which is what DESIGN.md always claimed
  it did — and which fails if either hook returns.
- **A keyboard-opened drawer no longer leaks its claim onto another card**: the flag is kept only
  when the clicked card is the selected one, so a click that replaces the drawer is a pointer path.
- **Checklist rows are disabled while a mutation is in flight**, so the `[aria-pressed="true"]:disabled`
  rule and the sentence about it describe a state the panel really renders.
- **A pending lane prints no WIP limit** it has not been told, instead of a `0/2` synthesised from
  `DEFAULT_DOW`, and the pending lanes are named as `BOARD_STATES` rather than "the saved views".
- **The header count matches the screen** (`showing 5 of 6 cards` when a dropped card has no lane),
  `Alt+←/→` on a dropped card says it is dropped rather than at an edge, and `More metrics` carries
  the cycle's median, p85 and mean.

## Unreleased — the view row removed, and every state drawn

Dhira's verdict on the view switcher was *"Remove it, do not group by that, I think it's not common,
just view all."* Taken literally, that means no view row and no state filter on the panel, and a
board that draws every state.

### Removed

- **The `Board | Ageing | All | Dropped` view row.** The panel no longer renders the saved views the
  payload carries, the unfiltered `All` button or the `Dropped` button. `board.db`, the `views`
  payload field, the store, the host API and `kanban_list` / `bin/kanban.mjs --state` are untouched:
  the switcher was a panel affordance, not the data.
- **The `all states` select** added by the previous pass. It was the fresh critique's item 18 ("the
  human lost single-state narrowing") and the user overrode it deliberately — single-state narrowing
  is the tools' job again. Deleted, not deprecated: no disabled control is left behind.
- **`filterStates()` and `DROPPED_FILTER` in `model.ts`**, and `sameFilter` with the buttons that
  compared filters. `hasFilter` went too: it was the header's "nothing is narrowed" test, and the
  header now compares what is drawn against what the host holds (`shown !== total`) — the honest test,
  because a truncated read hides cards with no filter at all.

### Changed

- **The board draws every state as a lane, `dropped` last** — `backlog, ready, in-progress, review,
  done, dropped`. `BOARD_STATES` is `STATES`, and `columnsOf` maps it directly: no filter can take a
  lane away, because the only filter the panel sets is the search box. The `dropped` lane is what
  keeps a dropped card reachable from the panel — two passes ago it was invisible and the CLI was the
  only way back, and that defect stays closed. Empty lanes keep the content-width dashed slot, so the
  sixth lane costs little when it is empty.
- **The toolbar is the search box, the title field and `Add`.** Nothing else.
- **A dropped card's drawer leads with `→ Backlog` again** — and this time it really does. The primary
  move was computed with `… : here < 0 ? BOARD_STATES[0] ?? null : null`, and `??` binds looser than
  `?:`, so the whole conditional was its left operand: once `dropped` had an index on the board, the
  branch stopped answering and the drawer offered `Close` and nothing else. The move set now asks by
  state, and the DOM suite pins the button rather than the drawer's mere presence.
- **`Alt+←/→` from `done` now moves to `dropped`**, and from `dropped` back to `done`, because the
  board order includes the dropped lane. `dropped` remains the end of that order.
- **The pending board draws six lanes**, the same ones the answered board will.

### Still true

The ageing information survives the loss of the `Ageing` view: the metrics strip's lead already reads
`Oldest 1.5d vs 3d SLE · 0 past`. The header's honesty line is unchanged — `N cards` when every card
the board holds is drawn, `showing X of Y cards` when the search or a truncated read hides one.

## 1.0.0 — 2026-10-15

First release. One live check is still outstanding and is stated rather than implied: **this running
instance has not reloaded the host half**, so `probe.json` still reads `tools: []` and the nine tools
and the skill appear only after an app restart. A fresh install loads them with everything else.

### 0.1.0 — 2026-10-15

First working board.

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

### Fixed after adversarial review (2026-10-15)

Three blockers, all invisible to a green suite because the tests only exercised the happy path:

- **An agent could set a priority by creating a card.** `createTask` gated only `expedite` and never
  went through `checkEdit`, so `kanban_create {priority: 'p0-critical'}` succeeded, and the `bugfix`
  template handed an agent `p1-high`. Creation now goes through the same gate as an edit; a
  template's human-only fields are dropped for an agent **and reported** rather than refusing the
  card, and an explicit `priority` argument is refused outright.
- **The import fabricated history.** `insertTask` stamped `started_at = finished_at = now` on any row
  inserted as `done`, so eleven migrated cards were born with a zero-length cycle time and the
  generated view advertised *"Throughput 11 in 7 days · Cycle time median 0d · SLE (history)"* while
  the event log held two moves. Imported rows now carry null timestamps — unknown, and excluded from
  throughput and cycle time as a result. `scripts/repair-imported-timestamps.mjs` repaired the
  existing rows on the live board (12 of them), and `import-todo` is now human-only.
- **`set-dow` was unauthenticated and unvalidated.** It rewrote the Definition of Workflow with no
  actor gate, so a non-numeric WIP limit disabled WIP control and a malformed `dor` made every move
  throw. It is human-only now, and `writeDow` validates: absent fields keep their stored value, and a
  present-but-wrong field refuses the write.

Also fixed: the 31-day sprint window was rounded to the nearest day (so 31.375 days passed) and
`docs/kanban.md` claimed SQL enforcement the schema never had; `cancelSprint` accepted a closed
sprint and wrote no events; a tag filter interpolated `%` and `_` as LIKE wildcards; the probe record
reported `tasks: 0` beside a warning that rows had been imported; and `DEFAULT_CONFIG` computed the
board paths **once at module load**, freezing them to whatever `DSH_HOME` was at first import.

### Bounded input and visible caps (same day)

- A comment is capped at 10 000 characters and the event log keeps a 200-character preview plus the
  true length, rather than duplicating the whole body; the importer refuses a table over 5 000 000
  characters. The HTTP body cap does not cover the tools or the CLI, so the store enforces it.
- A board larger than the 500 cards the panel and the view read now **says so**: the payload carries
  `truncated`, the panel shows "showing N of M cards", and the generated file carries a
  *Partial board* note — because the flow metrics are computed from the rows that were read.
- A test now pins the `304` path's snapshot identity: an unchanged board must be the *same object*,
  since a defensive copy in `getSnapshot` once caused "Maximum update depth exceeded".
