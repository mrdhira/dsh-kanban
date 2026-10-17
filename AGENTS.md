# AGENTS.md — dsh-kanban

Project-level instructions for an agent working in this repository. They **add** to `~/.dsh/AGENTS.md`
(the user-global operating agreement) and never weaken it. A reader arriving from GitHub has none of
the house context, so the gates are restated here in full. Precedence, always: safety > truth > persona.

## The gate

There is one command, and it prints one verdict:

```bash
node scripts/guard.mjs --limit-mb 1024 -- node --max-old-space-size=384 scripts/gate.mjs
```

`scripts/gate.mjs` runs four steps in order — **build → typecheck → tests → freshness** — and ends in
`GATE PASS`, or `GATE FAIL: <steps>` and a non-zero exit. Judge it by that verdict and by the process
exit code, **never by the last line of output**: the guard prints its own memory line last, and twice
this project read a broken build's `tail -1` as green. A build failure invalidates every test result
after it, which is why the gate builds first and checks freshness last.

`node build.mjs`, `node scripts/typecheck.mjs` and `npm test` are the individual steps
(`npm test` builds first through `pretest`); run them when debugging, not when judging.

## What must not be edited

| path | why |
|---|---|
| `lib/**` | **generated** by `node build.mjs`; gitignored, never hand-edited |
| `bin/kanban.mjs` | **generated** by the same build; gitignored, never hand-edited |
| `node_modules/**` | pnpm's |
| `pnpm-lock.yaml` | pnpm writes it; change it only through `pnpm add` / `pnpm install` |
| `~/.dsh/profiles/desktop/package.json` | the app's composition; `./install.sh` writes it |
| `~/.dsh/{sessions,cache,storages,attachments,dsh-runtimes,llm-deepseek}`, `.credentials.yaml`, `browser.yml` | app-owned state |
| `~/.dsh/.kanban/board.db` | live board state, not source — the only copy |

Custom plugins are authored in TypeScript and built with esbuild. `src/**` is the source; `lib/**`
mirrors it file for file; `test/**` imports the built `lib/**`, so **a failed build invalidates the
tests** — a stale build is green and wrong.

## The guard caps every `node` run

Anything that spawns `node` — a test, a probe, a script in `scripts/` — goes through the vendored
`scripts/guard.mjs` (a byte-identical copy of `~/.dsh/scripts/guard/guard.mjs`; a structure check
fails if they diverge). 512 MB for pure logic, 1 GB for the DOM suite. **Exit 124 means the cap was
hit: bisect the run, never raise the cap.** One run at a time. Two defects once took a machine to
~170 GB RSS, so this is not a style preference.

**Never assert on a DOM node.** Compare primitives — `assert.ok(node === null)`, not the node.
Walking a failing React/jsdom node's fibers is what allocated the gigabytes.

## The stylesheet is one template literal

`src/client/styles.ts` holds the whole stylesheet in the single `STYLES` template literal. It must
stay **ASCII** and contain **no backtick**: a backtick in a comment ends the string and breaks the
client build. On 2026-10-16 exactly that happened, the build failed, and every "green" suite after it
was running against a stale bundle. Use 'quotes' for emphasis, and keep the text plain ASCII. A test
counts the delimiters, so the mistake fails in milliseconds rather than hours.

## Verification, not adjectives

A change is done when a gate that can actually run says so — `GATE PASS`, a fresh freshness reading,
the slot inspector for the client half. For the live app: a **host** change needs an app restart, a
**client** change needs a page reload (and if it does not appear, toggle the bundle). Name what you
could not verify instead of implying it.

## Who commits

**Every commit in this repository is authored and committed by Dhira Wigata
`<dwigata.putra@gmail.com>`.** Nobody else is credited. No `Co-authored-by`, no
`Generated-by`/`Assisted-by`, no "Generated with …" byline, in the subject or the body; work an agent
did is described in the body as prose ("Evidence: …"). `Signed-off-by` is allowed. Identity is set
**repo-locally**:

```bash
git config --local user.name  "Dhira Wigata"
git config --local user.email "dwigata.putra@gmail.com"
```

CI's `authorship` job (`.github/workflows/ci.yml`) checks the whole history — one identity, no
trailers — so `--no-verify` does not reach it. See `~/.dsh/rules/GIT-AUTHORSHIP.md`.

## Layout

```
src/store/    the board: schema, policy, metrics, the generated view, the import  -> lib/v1/store/**
src/host/     the route, the nine tools, the skill, the probe record              -> lib/v1/host/**
src/client/   the panel: model, drag logic, transport, store, components, styles  -> lib/v1/client.js
src/cli/      the CLI                                                             -> bin/kanban.mjs
types/        the ambient build facts for each half
test/         table-driven suites against the built lib/**
```

A profile plugin cannot import anything but Node builtins (`@deepseek-ai/*` does not resolve from a
profile directory), which is why the DSH contracts are vendored in `src/types/dsh.ts` and the browser
half talks to the host over this plugin's own HTTP route instead of a typed Remote.
