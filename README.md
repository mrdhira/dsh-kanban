# dsh-kanban

One task board for the whole home directory: a Kanban panel in the DSH Web GUI, `kanban_*` tools and
a skill for agents, and a CLI for the human — all over the same SQLite store, through the same policy
engine.

## What it is

| surface | who uses it | what it does |
|---|---|---|
| **Kanban panel** (`sidebar.panellist` → `main`) | the human | lanes, drag-and-drop with a keyboard path, the card drawer with both checklists, views, templates, the flow metrics |
| **`kanban_*` tools** (9) and the `kanban` skill | agents | list, read, create, update/fill, move, drop, sprint, board, metrics |
| **`bin/kanban.mjs`** | the human, scripts, checks | the same verbs from a shell, with distinct exit codes |

The board lives at `$DSH_HOME/tasks/board.db`. `$DSH_HOME/tasks/todo.md` is a **generated view** of
it — never hand-edit that file; `check-board.mjs` fails when it drifts.

## The rules the board enforces

They come from [The Kanban Guide (May 2025)](https://kanbanguides.org/the-kanban-guide/) for flow and
[the 2020 Scrum Guide](https://scrumguides.org/scrum-guide.html) for the optional timebox. Kanban has
no sprints, so this is Scrumban and the sprint layer is optional data. See `~/.dsh/docs/kanban.md` for
the full rationale.

- `backlog → ready → in-progress → review → done`, plus `dropped`; `blocked` is a flag, so blocked
  work still counts as WIP.
- **Definition of Ready** gates every exit from `backlog` except dropping.
- **Definition of Done** gates `done`; work that does not meet it returns to the backlog.
- **WIP control**: `in-progress` 2, `review` 1, ready queue 5. `expedite` is the only exception.
- **Only the human** sets a priority or a class of service, and only the human may except a gate —
  and an exception must carry a written reason, which is recorded on the card.
- **The four flow metrics** (WIP, throughput, work item age, cycle time) and a **Service Level
  Expectation** derived from cycle time; the SLE says `guess` until ten items have finished.

## Install

```bash
cd ~/.dsh/profiles/desktop/plugins/dsh-kanban
./install.sh            # registers the bundle in the profile and links it
./install.sh --check    # what would change
./install.sh --remove   # unregister
```

**A host-half change needs an app restart; a client-half change needs a page reload.** The Loader
picks up a new bundle row by itself, but a module inside a row that is already loaded does not
reload (T-008).

## Develop

```bash
pnpm install --ignore-workspace   # this plugin's own toolchain, not the profile's
node scripts/gate.mjs             # build + typecheck + tests + freshness, ending in GATE PASS
node build.mjs                    # host + browser halves, the CLI, and the declarations
node scripts/typecheck.mjs        # three projects: host, browser, tests
npm test                          # builds first, then runs the suite under the guard
```

Run the gate rather than composing the steps by hand: it judges every step by **process exit code** and
prints one verdict, because twice this project read a broken build's `tail -1` as green — the guard prints
its own memory line last — and the suite then passed against a **stale bundle**. A build failure
invalidates every test result after it, so the gate builds first and checks freshness last.

The suite covers the store, the policy engine, the flow metrics, the generated view, the import of
the pre-Kanban board, the CLI as a black box (including its exit codes), the browser model and drag
arithmetic, and the panel under jsdom against a fake HTTP layer.

## Endpoints

`/api/kanban` — `health`, `board` (with `?since=<rev>` → `304`), `task/:id`, `export`, and `POST
mutate` with an op.

**Trust, stated plainly:** the route is registered as a prefix on the app's own web server, so it
wins the longest-prefix match over the app's `/api` bridge and therefore **does not carry that
bridge's browser-session fence** — a request from this machine is believed, including an
`x-kanban-actor: human`. The server binds loopback only. That is a deliberate, recorded trade for a
single-user local tool: the boundary that matters (an agent may not set a priority) is enforced at
the *tool* boundary, where an agent's identity is its session and not a header it can choose. A
per-launch token is the obvious hardening and is deferred until the index-injection question for a
`file://`-loaded window is answered.

## Layout

```
src/store/    the board: schema, policy, metrics, the generated view, the import   (no DSH import)
src/host/     the route, the nine tools, the skill, the probe record
src/client/   the panel: model, drag logic, transport, store, components, styles
src/cli/      the CLI, bundled to bin/kanban.mjs
types/        the ambient build facts for each half
test/         table-driven suites against lib/**
```

A profile plugin **cannot import anything but Node builtins** (`@deepseek-ai/*` is not resolvable from
a profile directory), which is why the DSH contracts are vendored in `src/types/dsh.ts`, the store is
our own SQLite, and the browser half talks to the host over this plugin's own HTTP route rather than
a typed Remote.

## Trust and concurrency, stated precisely

Two claims in this README were too strong before a review took them apart, so they are spelled out
here rather than implied:

- **Optimistic concurrency is opt-in.** Every mutation accepts an `expectedRev` and refuses a write
  that carries a stale one; `bin/kanban.mjs`, the tools and the route only send it when the caller
  does, and the panel always does. A caller that omits it is choosing last-writer-wins. The mechanism
  is "a rev you supply is checked", not "no write can clobber another".
- **The CLI is the human's tool and trusts its shell.** `bin/kanban.mjs` defaults to
  `--actor human`, so an agent that shells out without `--actor agent:<session-id>` is recorded as
  Dhira and could set a priority or except a gate. There is no way to enforce otherwise from inside
  the process — an agent with a shell can lie. The gate that *is* enforced is on the agent's proper
  surface: a tool call carries its session and cannot claim to be the human.
- **`set-dow` is human-only and validated.** The Definition of Workflow is the control itself, so a
  malformed one is refused at the store rather than stored: a non-numeric WIP limit used to disable
  WIP control silently, and a `dor` that was not an array made every move throw. Fields the payload
  does not mention keep their stored value; a field that is present and wrong refuses the whole write.
