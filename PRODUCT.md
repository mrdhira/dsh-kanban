# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Two operators of equal standing, on the same board at the same time.**

- **Dhira**, the human. Works inside the DSH desktop app with several agent sessions running
  concurrently. Reaches the board through the left sidebar panel; reads it to decide what to pull
  next, what to unblock, and what an agent has finished. Scans in seconds, between other work.
- **Agent sessions**, one per task. Reach the same board through nine `kanban_*` tools and a skill.
  They create cards, refine them until the Definition of Ready is ticked, move them through the
  gates, comment, and block.

Neither is a second-class citizen: anything an agent can do to a card, Dhira must be able to do by
mouse and keyboard, and vice versa.

## Product Purpose

One SQLite board at `~/.dsh/tasks/board.db` is the single source of task truth shared by the human and
by agent sessions, with the workflow rules — WIP limits, the Definition of Ready and Definition of
Done gates, priority and class of service — enforced in **one** place. The panel is the human's view
of that board; the tools are the agents' view; the CLI is the scripted view; `tasks/todo.md` is a
generated projection, never edited by hand.

Success means: Dhira can see the state of play at a glance and act on it without asking, and an agent
can pull work, be refused with a reason, and be trusted to be telling the truth about progress.

## Positioning

**The same store, the same gates, two hands.** A card dragged by mouse and a card moved by a tool call
land in the same row through the same policy engine, and both leave the same event — so the four flow
metrics and the SLE are recomputable from the log rather than asserted by the interface. A
neighbouring task board could copy the lanes; it could not copy "the gate that refused the agent is
the gate that refused the human", because that requires the rules to live below both surfaces.

## Operating Context

- Lives in the DSH desktop app's **left sidebar panel**, beside Plugins, Skills and Automation tasks.
- **Narrow by construction**: the panel column is ~1000 px at desktop width, and lanes lay out
  horizontally, so a lane is a fixed ~236 px and the board scrolls sideways.
- Board sizes seen so far: 13–14 cards, all six states in use, 1–2 lanes occupied at a time.
- Follows the app's **active theme** (light or dark) through the app's own CSS custom properties.
- The board is source-controlled in the plugin repo; the board **file** is not.
- The board tracks this project itself: the plugin's own work is on it, including this card.

## Capabilities and Constraints

- Nine tools (`kanban_list`, `get`, `create`, `update`, `move`, `delete`, `sprint`, `board`,
  `metrics`) plus the `kanban` skill for agents; `bin/kanban.mjs` for the human's shell.
- A seeded **Board** view (backlog through review) and an **Ageing** view, plus **All** as the escape
  from the default filter -- without it a filtered board strands every `done` card, which is why it stays
  even though it is not a seeded view. Each lane shows its count and flags when it is over its limit; a
  card drawer carries both checklists, comments and history, alongside sprint and metrics surfaces.
- **Priority and class of service are the human's** — editing happens in the card drawer, and
  creation is a title with the store's defaults (`p2-normal` / `standard`); an agent may still pass
  both to `kanban_create`, including a template's carried values.
- WIP limits 2 (in progress) and 1 (review); expedite is human-only and the only exception to a limit.
- Sprints are one month or less, enforced exactly; cancelling releases only unfinished cards.
- **Constraints**: no new dependencies; TypeScript strict; the panel must never become the source of a
  rule (the store is); the route is loopback-only and unauthenticated by design, so the CORS allowlist
  is the fence.
- **Undecided / deferred**: cumulative-flow chart, right-sidebar tab, custom tool-call cards,
  multi-board, daily digest.

## Brand Commitments

- The **app's own theme tokens are binding** (`--dsw-*`). The panel must look like it was made by the
  same hand as the rest of DSH, in both themes. Carrying its own palette is not on offer.
- The entry is named **Kanban** in the sidebar; the panel heading is **Board**.
- Voice in the UI: plain and specific, the same as the plugin's docs — refusals say what is missing
  and what to do, never "invalid input".

## Evidence on Hand

- The live board at `~/.dsh/tasks/board.db` (13 real cards plus one dropped probe) and its generated
  projection `~/.dsh/tasks/todo.md`.
- The plugin's own record: `README.md`, `CHANGELOG.md`, `PRODUCT.md` (this file), and
  `../tasks/T-013-dsh-kanban/{requirements,process,probes,review}.md` in `~/.dsh`.
- 300 tests over the built artifacts, including a jsdom harness that renders the real client bundle.
- Screenshots of the live panel, captured by Dhira.
- **Absent, and not to be invented**: testimonials, usage benchmarks, customers, pricing, roadmap
  promises, or adoption numbers. There is one user and one machine.

## Product Principles

1. **The store is the truth; every view is generated.** No screen may hold state the board cannot
   reproduce.
2. **One rule, one place.** Gates, limits and permissions live in the store. A surface that
   re-implements a rule is a surface that will disagree with the store.
3. **Both operators are first-class.** Every action exists in both hands, through the same gate, with
   the same refusal.
4. **A refusal is an explanation.** Say what is missing and what would satisfy it; never blame input.
5. **Never claim what was not verified.** Unverified work is reported as unverified, in the interface
   and in the report.

## Accessibility & Inclusion

Confirmed standard: **keyboard-first with visible focus, AA contrast in both themes, reduced motion
respected.**

- Every board action reachable without a pointer — lane moves, card open/close, checklist ticks,
  comment, block, drop — sharing the pointer's gates rather than a parallel code path.
- Visible focus on every interactive control; focus is never trapped in the drawer or on the board, and
  may be trapped only while a modal dialog is open. Closing a dialog always returns focus to the
  control that opened it, and `Escape` always closes it.
- AA contrast for text and for the state colours that carry meaning (priority, ageing, refusal).
- `prefers-reduced-motion` honoured: no transition is load-bearing.
