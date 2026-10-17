/**
 * Visual alignment, **measured in a real browser**, for every surface and state of the kanban panel.
 *
 * ## Why this exists
 *
 * Every visual judgement of this panel so far came from either the source or from one board-at-rest
 * screenshot. The `impeccable critique` read `components.ts`/`styles.ts` and listed hover, focus,
 * drag/drop and the painted results as *unjudged*; the `impeccable audit` computed contrast from
 * tokens and said plainly that "jsdom paints nothing — every ratio is computed, not observed pixels".
 * A control that floats outside its row, or a row whose children disagree about their edge, is
 * invisible to both: one is a question about geometry and the other about layout that jsdom does not
 * perform at all. This script closes that gap the same way `scripts/drag-probe.mts` closes the drag
 * gap — the real bundle, the real stylesheet, the real React, real Chrome — and then measures the
 * boxes the browser actually produced with `getBoundingClientRect`.
 *
 * ## The page, and what is real on it
 *
 * `scripts/drag-probe.mts` builds the page this script builds: the **bundle** is `lib/v1/client.js`,
 * the artifact the app loads, evaluated through a stub `window.__ModuleLoader__` and applied the way
 * the app applies it; the **board** is `test/harness.ts`'s own `boardPayload()`; the **transport is
 * faked** and nothing else — one `window.fetch` answering `/board`, `/mutate` and `/task/`. So the
 * DOM, the store, the renderer, the cascade and the layout are all real.
 *
 * One addition is this script's own: the `--dsw-*` token layer is the app's **own stylesheet**,
 * pasted verbatim from the installed `app.asar`
 * (`@deepseek-ai/dsh-client-ui-theme/lib/client.js`, `var design_platform_css_default = "…"`, 19 KB).
 * An earlier capture resolved that string token by token in Node and injected the results; a real
 * browser needs none of that, and pasting it whole means the theme is decided by the app's own
 * cascade — `body` for light, `body[data-ds-dark-theme]` for dark — which is exactly how the app
 * decides it. `<html>` also carries `data-platform="darwin"`, as the desktop app's does.
 *
 * ## The widths, and where they come from
 *
 * The panel's column is not chosen here. The app solves it in
 * `@deepseek-ai/dsh-client-ui-layout/lib/client.js` (in `app.asar`), verbatim:
 *
 *     function computeColumns(viewport, sidebar, rightbar, collapsedWidth = 56) {
 *       const s = sidebar === 0 ? collapsedWidth : clampWidth(sidebar, 264, 420);
 *       const available = viewport - s - 400;
 *       const r = rightbar === 0 || available < 300 ? 0
 *                 : Math.min(available, clampWidth(rightbar, 300, viewport * .7));
 *       return { sidebar: s, center: Math.max(0, viewport - s - r), rightbar: r };
 *     }
 *
 * and `AppFrame` feeds it `rightbarPreference = layoutInfo.rightbar ?? viewport * .45`, with the left
 * sidebar's own default of 280. The panel is registered at slot `main` ("central panel selected by
 * sidebar entry id"), so the width it is given is `center`. Three configurations of that solver are
 * used, each named by the frame that produces it:
 *
 * - **1000** — `computeColumns(1280, 280, 0)` with no right track. This reproduces, exactly, the
 *   "panel column is ~1000 px at desktop width" that `PRODUCT.md` records, from the app's own code
 *   rather than from a guess. This is the width the named screenshots are taken at.
 * - **932** — `computeColumns(1512, 280, 300)`: the user's own display (3024x1964 Retina, i.e. 1512
 *   logical points) with the right panel dragged to its 300px contract minimum.
 * - **552** — `computeColumns(1512, 280, 680)`: the same frame with the right panel at the app's
 *   *default* preference of 45% of the frame, which is the narrowest column the default app actually
 *   gives the panel.
 *
 * ## What is measured
 *
 * Per row, from the live layout:
 *
 * - **row integrity** — the spread of the row's children's top, bottom, centre and text-ink baselines
 *   within each visual line. The edge that *should* agree is the one the row's own `align-items`
 *   names (`stretch` -> top and bottom, `center` -> centres, `baseline` -> ink bottoms, `flex-start`
 *   -> tops), so a centred row's 2px top spread is reported as a number and not as a defect. Raw
 *   spreads are reported either way, so nothing is hidden by the interpretation.
 * - **control heights** — each control against the median height of the controls in its own line.
 * - **content edge** — the first child's left and the last child's right against the row's content
 *   box, plus the trailing slack for every row (a control that stops far short of its row's right
 *   edge is the "floating button" pattern, whatever the CSS intended).
 * - **gaps** — every consecutive sibling gap in a line, against the row's declared `gap` and against
 *   each other. Gaps adjacent to a `.kb-spacer` and rows with a distributing `justify-content` are
 *   excluded, because those gaps are supposed to differ.
 * - **escape** — a child leaving its row's border box; a child leaving its row's content box where
 *   the row does not scroll; two sibling controls overlapping; and — a separate sweep over every
 *   element under `.kb-page` — any box crossing the panel's own bounds. Elements inside an ancestor
 *   with non-visible overflow are excluded and counted, because the lane row and the drawer body are
 *   scrollers by design.
 *
 * ## States
 *
 * Every state in the brief is driven through the panel's own code where a path exists — a card click
 * for the drawer, the `More moves…` disclosure then the drawer's own move button for the staged drop,
 * the real `input` event for the search box, the store's own `drop` for the confirmation notice — and
 * through the transport stub where the state *is* the failure (a 500 for the error notice, a promise
 * that never settles for the loading skeleton). Both themes, both at each of the three widths.
 *
 * ## Run
 *
 * Through the guard, one run at a time. This spawns Chrome, whose macOS process tree needs ~1.35 GB
 * before it renders anything, so the cap is 2560 MB and not the 1024 MB a pure-logic run takes:
 *
 *   node ~/.dsh/scripts/guard/guard.mjs --limit-mb 2560 -- \
 *     node --max-old-space-size=384 \
 *     ~/.dsh/profiles/desktop/plugins/dsh-kanban/scripts/align-probe.mts
 *
 * One Chrome, one page, many `Emulation.setDeviceMetricsOverride` frames — the browser is started
 * once and every state, theme and width is measured inside it, which is what keeps the run inside the
 * cap. Nothing is cached: the bundle, the design-platform CSS, the harness fixture and the page are
 * read fresh on every run.
 *
 * ## The report
 *
 * `~/.dsh/logs/kanban/align-report.json` is a **summary**, not the finding stream. The full set stays
 * in memory for the terminal table, which is where a run is read; the file keeps what a later reader
 * acts on:
 *
 * - `summary.totalFindings` — every finding measured, matching the terminal's first count.
 * - `summary.countsByMetric` — the same total broken down by finding type.
 * - `summary.actionable` — the number of findings in the file's `findings` array; this is the total
 *   minus the excluded classes below.
 * - `summary.excludedByMetric` — the classes kept out of `findings` because they are noise by
 *   construction. `spread-explained` is the only one, and it is the bulk: it records a row whose
 *   *declared* alignment is within 1px while a different edge differs, which is what the declaration
 *   means rather than a defect. The old file carried them, and at ~2.4 MB a run the home memory check
 *   flagged every measurement.
 * - `rows` — the per-row measurements, keyed by `state/theme/width`. Each row is a positional array
 *   described once by `rowFields`; the first field indexes `rowNames`, because the same 75 names
 *   repeat across every frame. Keeping the names and field names out of every row is what makes the
 *   summary small.
 * - `diagnostics` — the computed font and focus per frame, as indices into `panelFonts` and
 *   `focusStates`; only the values that actually differ are stored.
 *
 * The terminal prints both counts (`N findings, M actionable`) so the file's `findings.length` and
 * `summary.totalFindings` can never silently disagree with what the run said.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boardPayload } from '../test/harness.ts';

// ------------------------------------------------------------------ paths and constants

const HERE = new URL('..', import.meta.url);
const BUNDLE_PATH = fileURLToPath(new URL('lib/v1/client.js', HERE));
const ASAR_PATH = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const THEME_MODULE = '/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js';
const DESIGN_PLATFORM_MARKER = 'var design_platform_css_default = "';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = join(homedir(), '.dsh', 'logs', 'kanban');
const REPORT_PATH = join(OUT_DIR, 'align-report.json');
const PAGE_PATH = '/tmp/dsh-kanban-align-probe-page.html';
const TEMP_DIR = mkdtempSync(join(tmpdir(), 'dsh-kanban-align-'));

/** The frame height every measurement is taken in. The panel is `height: 100%`, so this is its height. */
const VIEW_HEIGHT = 900;

/**
 * The widths the app gives the panel, each with the frame it comes from.
 *
 * `computeColumns(1280, 280, 0).center === 1000`, which is the figure `PRODUCT.md` records; the other
 * two are the same solver against the display this machine actually has. The first is the width the
 * named screenshots use, so `align-<state>-<theme>.png` is the recorded desktop column.
 */
const WIDTHS: ReadonlyArray<{ readonly width: number; readonly frame: string }> = [
  { width: 1000, frame: 'computeColumns(1280, 280, 0) — no right track; the ~1000px column PRODUCT.md records' },
  { width: 932, frame: 'computeColumns(1512, 280, 300) — real display, right panel at its 300px contract minimum' },
  { width: 552, frame: 'computeColumns(1512, 280, 680) — real display, right panel at the default 45% preference' },
];

const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

/** Per-command bound: a CDP call that never answers is a failure, not a reason to hang the guard. */
const COMMAND_TIMEOUT_MS = 20_000;
/** How long one state's own wait is given to be satisfied. Bounded on purpose; it never hangs. */
const SETTLE_TIMEOUT_MS = 10_000;

// ------------------------------------------------------------------ the page's own inputs

/**
 * The rows measured, by selector.
 *
 * A selector may match many elements (`.kb-bar`, `.kb-check`, `.kb-lane-head`); each match is one
 * measured row and is named from its own ancestry, so a finding says which row it was.
 */
const ROW_SPECS: ReadonlyArray<{ readonly selector: string; readonly name: string }> = [
  { selector: '.kb-head', name: 'page-head' },
  { selector: '.kb-page > .kb-bar', name: 'page-bar' },
  { selector: '.kb-page > .kb-notice', name: 'page-notice' },
  { selector: '.kb-metrics', name: 'metrics' },
  { selector: '.kb-lanes', name: 'lanes-row' },
  { selector: '.kb-lane', name: 'lane' },
  { selector: '.kb-lane-head', name: 'lane-head' },
  { selector: '.kb-cards', name: 'cards-column' },
  { selector: '.kb-card-top', name: 'card-top' },
  { selector: '.kb-card-meta', name: 'card-meta' },
  { selector: '.kb-drawer', name: 'drawer' },
  { selector: '.kb-drawer-head', name: 'drawer-head' },
  { selector: '.kb-fold', name: 'drawer-fold' },
  { selector: '.kb-group', name: 'drawer-group' },
  { selector: '.kb-drawer .kb-bar', name: 'drawer-bar' },
  { selector: '.kb-checks', name: 'checks-group' },
  { selector: '.kb-check', name: 'check-row' },
  { selector: '.kb-list', name: 'list-column' },
];

/**
 * The board every state renders, from the suite's own fixture.
 *
 * `boardPayload()` gives T-001…T-005 with one empty lane (`review`). Three cards are added: the
 * dropped one the panel must be able to show, a card whose title is long but **breakable**, and a
 * card whose title carries a long **unbreakable** token (a 64-character digest, the shape a real
 * board has in a bug title). The pair is deliberate: two lanes with a long title, one of which can
 * wrap and one of which cannot, so whatever the two lanes do is attributable to the token and not to
 * "a long title" in general. T-001 gets a full DoR so one drawer holds ticked and unticked checklist
 * rows at once.
 */
function fixture(): Record<string, unknown> {
  const payload = boardPayload();
  const fullDor = Object.fromEntries(
    ['outcome', 'acceptance', 'write-scope', 'estimate'].map((id) => [id, { at: '2026-10-01T00:00:00.000Z', by: 'human:dhira' }])
  );
  const tasks = (payload.tasks as Record<string, unknown>[]).map((task) =>
    task.id === 'T-001' ? { ...task, dor: fullDor } : task
  );
  const base = tasks[0] as Record<string, unknown>;
  return {
    ...payload,
    tasks: [
      ...tasks,
      {
        ...base,
        id: 'T-006',
        state: 'dropped',
        position: 0,
        droppedReason: 'superseded by T-004',
        title: 'Retire the hand-rolled lane rail now that the board draws every state itself',
      },
      {
        ...base,
        id: 'T-007',
        state: 'ready',
        position: 1,
        title:
          'Reconcile the board render timing with the host scheduler and the 30-day throughput window; the poll loop stalls on payload hash 3f9a1c7e5b2d48f6a0c3e9b7d1f4a8c2e6b0d5f9a3c7e1b4d8f2a6c0e5b9d3f7 while session 01J8ZQ4M7XK2P9V3TB6NDRWY5C8E is idle',
      },
      {
        ...base,
        id: 'T-008',
        state: 'backlog',
        position: 1,
        // Long, and every word breakable: the control for T-007. If this lane stays 236px while T-007's
        // grows, the cause is the unbreakable token and not the length of the title.
        title:
          'Reconcile the board render timing with the host scheduler and the 30-day throughput window before the next pass, and write down what the poll loop does when the payload reference is replaced by a read that changed nothing',
      },
    ],
    sprints: [
      {
        id: 'S-001',
        name: 'Alignment probe',
        goal: 'Measure every surface before changing one',
        start: '2026-10-15T00:00:00.000Z',
        end: '2026-10-29T00:00:00.000Z',
        state: 'active',
        createdAt: '2026-10-15T00:00:00.000Z',
        closedAt: null,
      },
    ],
    total: 8,
  };
}

/** The card detail the drawer reads. Only the long-comment state uses it. */
const DETAIL_COMMENTS: ReadonlyArray<Record<string, unknown>> = [
  {
    id: 1,
    taskId: 'T-007',
    at: '2026-10-16T09:12:00.000Z',
    actor: 'human:dhira',
    body:
      'The board redraws on every poll even when the revision has not moved, which is why the lane scroll jumps back to the left while I am reading the dropped lane. Worth pinning down before the next pass.',
  },
  {
    id: 2,
    taskId: 'T-007',
    at: '2026-10-16T09:14:00.000Z',
    actor: 'agent:01J8ZQ4M7XK2P9V3TB6NDRWY5C8E',
    body: 'Reproduced in 01J8ZQ4M7XK2P9V3TB6NDRWY5C8E: the read that the poll itself makes replaces the payload reference, so every consumer re-renders.',
  },
];

const DETAIL_EVENTS: ReadonlyArray<Record<string, unknown>> = [
  {
    id: 1,
    at: '2026-10-16T09:10:00.000Z',
    actor: 'human:dhira',
    taskId: 'T-007',
    kind: 'create',
    fromState: null,
    toState: 'backlog',
    payload: {},
  },
  {
    id: 2,
    at: '2026-10-16T09:15:00.000Z',
    actor: 'agent:01J8ZQ4M7XK2P9V3TB6NDRWY5C8E',
    taskId: 'T-007',
    kind: 'move',
    fromState: 'backlog',
    toState: 'ready',
    payload: {},
  },
];

// ------------------------------------------------------------------ reading the artifacts

/** The captured stylesheet, read from the artifact exactly as the other probes read it. */
function readStyles(): string {
  const source = readFileSync(BUNDLE_PATH, 'utf8');
  const at = source.indexOf('STYLES = `');
  if (at < 0) throw new Error('lib/v1/client.js no longer assigns STYLES a template literal');
  const start = source.indexOf('`', at) + 1;
  const end = source.indexOf('`', start);
  if (end < 0) throw new Error('unterminated STYLES template literal');
  return source.slice(start, end);
}

/** One file out of the asar, through its own header — no extractor, and no 121 MB buffer. */
function asarRead(entryPath: string): string {
  const fd = openSync(ASAR_PATH, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(12);
    const headerBytes = Buffer.alloc(headerSize);
    readSync(fd, headerBytes, 0, headerSize, 16);
    const header = JSON.parse(headerBytes.toString('utf8')) as { files?: Record<string, unknown> };
    const base = 16 + headerSize;
    let node: Record<string, unknown> | undefined = header as Record<string, unknown>;
    for (const part of entryPath.split('/').filter((piece) => piece.length > 0)) {
      const files = node['files'] as Record<string, Record<string, unknown>> | undefined;
      node = files?.[part];
      if (node === undefined) throw new Error(`${entryPath} is not in the asar (lost at ${part})`);
    }
    const offset = node['offset'];
    const size = node['size'];
    if (typeof offset !== 'string' || typeof size !== 'number') throw new Error(`${entryPath} has no readable offset`);
    const buffer = Buffer.alloc(size);
    readSync(fd, buffer, 0, size, base + Number(offset));
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * The app's own token stylesheet, verbatim.
 *
 * The string is a JS string literal in the shipped module, so it is unescaped on the way out: `\"`
 * becomes `"` and `\\` becomes `\`. Everything else — including every `var()` chain — is handed to
 * the browser exactly as the app hands it to itself.
 */
function readDesignPlatformCss(): string {
  const source = asarRead(THEME_MODULE);
  const at = source.indexOf(DESIGN_PLATFORM_MARKER);
  if (at < 0) throw new Error(`the design-platform CSS string (${DESIGN_PLATFORM_MARKER}) is no longer in the asar`);
  let index = at + DESIGN_PLATFORM_MARKER.length;
  const out: string[] = [];
  while (index < source.length) {
    const char = source[index] as string;
    if (char === '\\') {
      out.push(source[index + 1] ?? '');
      index += 2;
      continue;
    }
    if (char === '"') break;
    out.push(char);
    index += 1;
  }
  const css = out.join('');
  if (css.length < 1000) throw new Error(`the design-platform CSS came out at ${String(css.length)} bytes, which is not a stylesheet`);
  return css;
}

// ------------------------------------------------------------------ the states

interface ProbeStep {
  /** Single-quoted page code, run after the previous step has committed. */
  readonly setup?: string;
  /** The page fact that says this step is on screen. */
  readonly ready: string;
}

interface ProbeStateSpec {
  readonly name: string;
  /** What the transport stub answers `/board` with while this state is being built. */
  readonly mode: 'ok' | 'fail' | 'hold';
  /**
   * The state, one committed step at a time.
   *
   * A step per commit, because each gesture needs the DOM the previous one produced: clicking a card
   * and then clicking a button *inside the drawer it opens* is two commits, and a probe that fires
   * both in one expression is clicking at a node that does not exist yet. That was measured, not
   * guessed — the first run of this script timed out on exactly that pair.
   */
  readonly steps: ReadonlyArray<ProbeStep>;
  /** An extra scroll, applied after the last step: a scroller's own content is off-screen by design. */
  readonly scroll?: 'lanes-end' | 'drawer-checks' | 'drawer-comments' | 'drawer-staged';
}

/**
 * The states, in the brief's own order.
 *
 * Every `ready` is a fact about a commit, never a sleep: the drawer state is `[data-drawer]` present,
 * the staged state is `data-staged="dropped"` *and* the reason field focused (the attribute and the
 * field arrive one commit after the drawer does), and the notice states are the notice element
 * itself. A wait that cannot name what it was looking at is what let earlier probes report a panel
 * that had done the right thing as one that had not.
 */
const STATES: ReadonlyArray<ProbeStateSpec> = [
  {
    name: 'board',
    mode: 'ok',
    steps: [{ ready: "document.querySelector('.kb-lane') !== null && document.querySelectorAll('[data-card]').length === 8" }],
  },
  {
    name: 'board-dropped',
    mode: 'ok',
    steps: [{ ready: "document.querySelector('[data-lane=\"dropped\"] [data-card=\"T-006\"]') !== null" }],
    scroll: 'lanes-end',
  },
  {
    name: 'drawer',
    mode: 'ok',
    steps: [
      { setup: "window.__click('[data-card=\"T-003\"]')", ready: "document.querySelector('[data-drawer=\"T-003\"]') !== null" },
      {
        ready:
          "document.querySelector('[data-drawer=\"T-003\"]').getAttribute('data-open') === 'pointer' && document.querySelector('[data-drawer=\"T-003\"] .kb-check') !== null",
      },
    ],
  },
  {
    name: 'drawer-more',
    mode: 'ok',
    steps: [
      { setup: "window.__click('[data-card=\"T-003\"]')", ready: "document.querySelector('[data-drawer=\"T-003\"]') !== null" },
      {
        setup: "window.__click('[data-action=\"more\"]')",
        ready: "document.querySelector('[data-action=\"more\"]') !== null && document.querySelector('[data-action=\"more\"]').getAttribute('aria-expanded') === 'true'",
      },
    ],
  },
  {
    name: 'drawer-staged',
    mode: 'ok',
    steps: [
      { setup: "window.__click('[data-card=\"T-003\"]')", ready: "document.querySelector('[data-drawer=\"T-003\"]') !== null" },
      // The **pointer** route, which is the one the brief's "reason focused" describes: the drawer's
      // own `Move … to Dropped` button stages with `via: 'keyboard'` and deliberately leaves focus on
      // the drawer, while the drop gesture hands the keyboard to the reason field. `stageDrop` is the
      // store call the drop's own handler makes; only the mouse is left out of it.
      {
        setup: "void window.__panelStore.stageDrop('T-003', 'pointer')",
        ready:
          "document.querySelector('[data-drawer=\"T-003\"]') !== null && document.querySelector('[data-drawer=\"T-003\"]').getAttribute('data-staged') === 'dropped' && document.activeElement === document.querySelector('[data-field=\"drop-reason\"]')",
      },
    ],
    scroll: 'drawer-staged',
  },
  {
    name: 'drawer-staged-keyboard',
    mode: 'ok',
    steps: [
      { setup: "window.__click('[data-card=\"T-003\"]')", ready: "document.querySelector('[data-drawer=\"T-003\"]') !== null" },
      {
        setup: "window.__click('[data-action=\"more\"]')",
        ready: "document.querySelector('[data-action=\"more\"]') !== null && document.querySelector('[data-action=\"more\"]').getAttribute('aria-expanded') === 'true'",
      },
      {
        setup: "window.__click('[aria-label=\"Move T-003 to Dropped\"]')",
        ready:
          "document.querySelector('[data-drawer=\"T-003\"]').getAttribute('data-staged') === 'dropped' && document.querySelector('[data-field=\"drop-reason\"]') !== null",
      },
    ],
    scroll: 'drawer-staged',
  },
  {
    name: 'checks',
    mode: 'ok',
    steps: [
      { setup: "window.__click('[data-card=\"T-001\"]')", ready: "document.querySelector('[data-drawer=\"T-001\"]') !== null" },
      { ready: "document.querySelectorAll('.kb-check').length === 9" },
    ],
    scroll: 'drawer-checks',
  },
  {
    name: 'metrics',
    mode: 'ok',
    steps: [
      {
        setup: "window.__click('[data-action=\"more-metrics\"]')",
        ready: "document.querySelector('.kb-metrics') !== null && document.querySelector('.kb-metrics').textContent.indexOf('Throughput') !== -1",
      },
    ],
  },
  {
    name: 'new-card',
    mode: 'ok',
    steps: [
      {
        setup: "window.__click('[data-action=\"new-card\"]')",
        ready:
          "document.querySelector('.kb-new-card') !== null && document.querySelector('[data-action=\"new-card\"]').getAttribute('aria-expanded') === 'true'",
      },
    ],
  },
  {
    name: 'notice-drop',
    mode: 'ok',
    steps: [
      { setup: "window.__panelStore.drop('T-002', 'no longer needed'); void 0", ready: "document.querySelector('.kb-notice-info') !== null" },
    ],
  },
  {
    name: 'notice-error',
    mode: 'fail',
    steps: [
      {
        ready:
          "document.querySelector('.kb-notice-error') !== null && document.querySelector('[data-action=\"retry-board\"]') !== null",
      },
    ],
  },
  {
    name: 'loading',
    mode: 'hold',
    steps: [{ ready: "document.querySelectorAll('.kb-skeleton').length === 6" }],
  },
  {
    name: 'long',
    mode: 'ok',
    steps: [
      {
        setup: "window.__longComment = true; window.__click('[data-card=\"T-007\"]')",
        ready: "document.querySelector('[data-drawer=\"T-007\"]') !== null",
      },
      // The card record and the comment are the visible lists; history starts closed behind its
      // toggle, so this state waits on two lists plus the history control rather than the old three.
      { ready: "document.querySelectorAll('.kb-list').length >= 2 && document.querySelector('[data-action=\"history\"]') !== null" },
    ],
    scroll: 'drawer-comments',
  },
  {
    name: 'search',
    mode: 'ok',
    steps: [
      {
        setup: "window.__type('[type=\"search\"]', 'card T-003')",
        ready: "document.querySelector('.kb-sub') !== null && document.querySelector('.kb-sub').textContent.indexOf('showing 1 of 8') !== -1",
      },
    ],
  },
];

// ------------------------------------------------------------------ the page

function pageSource(styles: string, designCss: string): string {
  const bundle = readFileSync(BUNDLE_PATH, 'utf8');
  const payload = JSON.stringify(fixture());
  const specs = JSON.stringify(ROW_SPECS);
  const comments = JSON.stringify(DETAIL_COMMENTS);
  const events = JSON.stringify(DETAIL_EVENTS);
  // React and ReactDOM are the app's own dependency from the plugin's `node_modules`, inlined: a
  // `file://` document has an opaque origin and Chrome refuses to load a linked subresource from one,
  // so a `<script src>` silently never runs. One self-contained document is what makes this testable.
  const react = readFileSync(join(fileURLToPath(HERE), 'node_modules/react/umd/react.development.js'), 'utf8');
  const reactDom = readFileSync(join(fileURLToPath(HERE), 'node_modules/react-dom/umd/react-dom.development.js'), 'utf8');
  // The page is a template literal in *this* file, so its own scripts cannot use backticks or `${`.
  // Everything inside is single-quoted plain ES2020, plus `+` where a string has to be built.
  return `<!doctype html>
<html data-platform="darwin">
<head><meta charset="utf-8" /><style>
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
/* The app's own shell rule for body, with the app's own token for its family, taken from
   ui-theme's base sheet (var(--dsw-font-family) -> -apple-system, BlinkMacSystemFont, ...). The
   size is deliberately left alone: the app's shell sets none on html/body/#root (checked against
   dsh-web-frontend/dist/assets/index-*.css and the design-platform string), so the panel inherits
   the browser's 16px there too and this page inherits the same. */
body { font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif);
  color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-base, #fff);
  -webkit-font-smoothing: antialiased; }
#root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
#root > * { flex: 1 1 auto; min-height: 0; }
${designCss}
${styles}
</style></head>
<body>
<div id="root"></div>
<script>
window.__pageErrors = [];
window.addEventListener('error', function (event) {
  window.__pageErrors.push(String(event.message) + ' @ ' + String(event.filename) + ':' + String(event.lineno));
});
</script>
<script>
(function () {
  'use strict';
  var BOARD = ${payload};
  var COMMENTS = ${comments};
  var EVENTS = ${events};
  var SPECS = ${specs};
  var calls = [];
  var mutations = 0;
  window.__mode = 'ok';
  window.__longComment = false;
  window.__calls = calls;
  window.__rowSpecs = SPECS;

  window.fetch = function (url, init) {
    var method = (init && init.method) || 'GET';
    var body = {};
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (error) { body = {}; }
    calls.push({ url: String(url), method: method, body: body });
    var answer = function (status, payload) {
      return Promise.resolve({ ok: status >= 200 && status < 300, status: status,
        text: function () { return Promise.resolve(JSON.stringify(payload)); } });
    };
    if (String(url).indexOf('/board') !== -1) {
      // Three answers, all of them states the brief asks for. 'hold' is a promise that never settles,
      // which is the only honest way to hold the panel in its first-read state; 'fail' is a real 500
      // with a real body, which is what the error notice and its Retry are built from.
      if (window.__mode === 'hold') return new Promise(function () {});
      if (window.__mode === 'fail') {
        return Promise.resolve({ ok: false, status: 500, text: function () { return Promise.resolve('the board route did not answer'); } });
      }
      return mutations === 0 ? answer(200, { ok: true, board: BOARD, rev: BOARD.rev }) : answer(304, {});
    }
    if (String(url).indexOf('/mutate') !== -1) {
      mutations += 1;
      return answer(200, { ok: true, rev: BOARD.rev + mutations, result: {} });
    }
    if (String(url).indexOf('/task/') !== -1) {
      return answer(200, { ok: true, task: null, comments: window.__longComment ? COMMENTS : [], events: EVENTS });
    }
    return answer(404, { ok: false, message: 'no route' });
  };

  window.__ModuleLoader__ = {
    load: function (entry) {
      try {
        window.__bundle = entry.factory(function (specifier) {
          if (specifier === 'react') return window.React;
          if (specifier === 'react-dom') return window.ReactDOM;
          throw new Error('unexpected require: ' + specifier);
        });
        window.__bundle.apply({
          slots: {
            register: function (spec, component) { if (spec.name === 'main') window.__bundle.__panel = component; },
            inject: function (name, run) { run(); }
          }
        });
      } catch (error) {
        window.__bundleError = String(error && error.stack ? error.stack : error);
      }
    }
  };

  window.__reset = function () { calls.length = 0; mutations = 0; window.__longComment = false; };
  window.__root = null;
  window.__epoch = 0;
  window.__mountError = null;
  window.__mountState = { stageable: null, renderedRev: null };
  window.__mark = function (key, value) {
    var next = Object.assign({}, window.__mountState);
    next[key] = value;
    window.__mountState = next;
  };
  window.__mount = function () {
    try {
      // One React root for the page's life, re-rendered under a new key per state: React then tears
      // the previous panel down itself, so no state can read the previous mount's board or DOM.
      window.__epoch += 1;
      if (window.__root === null) window.__root = window.ReactDOM.createRoot(document.getElementById('root'));
      var store = window.__bundle.createStore();
      window.__panelStore = store;
      window.__mountState = { stageable: null, renderedRev: null };
      window.__root.render(
        window.React.createElement(window.__bundle.__panel, {
          key: 'panel-' + window.__epoch,
          React: window.React,
          store: store,
          documentRef: document
        })
      );
    } catch (error) {
      window.__mountError = String(error && error.stack ? error.stack : error);
    }
  };

  window.__health = function () {
    return {
      pageErrors: window.__pageErrors,
      hasReact: typeof window.React === 'object',
      hasReactDom: typeof window.ReactDOM === 'object',
      hasBundle: typeof window.__bundle === 'object',
      hasPanel: typeof window.__bundle === 'object' && typeof window.__bundle.__panel === 'function',
      bundleError: window.__bundleError,
      mountError: window.__mountError,
      rootHtml: document.getElementById('root').innerHTML.length
    };
  };

  window.__click = function (selector) {
    var node = document.querySelector(selector);
    if (node === null) return false;
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  };

  /**
   * Type into a controlled input the way a browser does.
   *
   * Through the prototype's own value setter and a real 'input' event, so React's onChange runs and
   * the state that draws the header's 'showing X of Y' is the panel's own, not a value set behind it.
   */
  window.__type = function (selector, value) {
    var node = document.querySelector(selector);
    if (node === null) return false;
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };

  window.__scrollLanesToEnd = function () {
    var lanes = document.querySelector('.kb-lanes');
    if (lanes !== null) lanes.scrollLeft = lanes.scrollWidth;
    return lanes === null ? 0 : lanes.scrollLeft;
  };

  /** Bring something inside a scroller into view by scrolling that scroller alone. */
  window.__bringIntoView = function (selector) {
    var node = document.querySelector(selector);
    if (node === null) return null;
    var box = node.closest('.kb-drawer') || node.closest('.kb-lanes');
    if (box === null) return null;
    var top = node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTop = Math.max(0, top - 6);
    return box.scrollTop;
  };

  /** Let the browser settle: two frames, so the layout a screenshot reads is the committed one. */
  window.__settle = function () {
    return new Promise(function (resolve) {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () { resolve(true); });
      });
    });
  };

  // ------------------------------------------------------------------ measurement

  function px(value) {
    var number = parseFloat(value);
    return isFinite(number) ? number : 0;
  }

  function rectOf(node) {
    var box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
  }

  /**
   * What the page has on screen right now, for a wait that is about to give up.
   *
   * Not part of the measurement: a timed-out wait that says only "timed out" cannot tell a panel that
   * did nothing from a probe that looked at the wrong node, and both were reachable in this script's
   * own first runs.
   */
  window.__diag = function () {
    var drawer = document.querySelector('.kb-drawer');
    var moves = document.querySelectorAll('[aria-label^="Move "]');
    var labels = [];
    for (var i = 0; i < moves.length; i += 1) labels.push(moves[i].getAttribute('aria-label'));
    var more = document.querySelector('[data-action="more"]');
    return {
      drawer: drawer === null ? null : drawer.getAttribute('data-drawer'),
      staged: drawer === null ? null : drawer.getAttribute('data-staged'),
      open: drawer === null ? null : drawer.getAttribute('data-open'),
      active: document.activeElement === null || document.activeElement === undefined ? 'none' : describe(document.activeElement),
      fieldPresent: document.querySelector('[data-field="drop-reason"]') !== null,
      moreExpanded: more === null ? null : more.getAttribute('aria-expanded'),
      moveButtons: labels,
      cards: document.querySelectorAll('[data-card]').length,
      checks: document.querySelectorAll('.kb-check').length,
      skeleton: document.querySelectorAll('.kb-skeleton').length,
      notices: document.querySelectorAll('.kb-notice').length,
      lists: document.querySelectorAll('.kb-list').length,
      sub: (function () { var s = document.querySelector('.kb-sub'); return s === null ? null : s.textContent; })()
    };
  };

  function round(box) {
    var out = {};
    for (var key in box) out[key] = Math.round(box[key] * 100) / 100;
    return out;
  }

  function contentBoxOf(node) {
    var style = getComputedStyle(node);
    var box = rectOf(node);
    var out = {
      left: box.left + px(style.borderLeftWidth) + px(style.paddingLeft),
      top: box.top + px(style.borderTopWidth) + px(style.paddingTop),
      right: box.right - px(style.borderRightWidth) - px(style.paddingRight),
      bottom: box.bottom - px(style.borderBottomWidth) - px(style.paddingBottom)
    };
    // A classic scrollbar is taken out of the content box, so the drawer's own content stops 10px
    // short of its padding. Without this the drawer's rows are measured against a content edge 10px
    // too far right, and every trailing-slack number in the drawer is 10px too large.
    var side = (node.offsetWidth - node.clientWidth) - px(style.borderLeftWidth) - px(style.borderRightWidth);
    if (side > 0) out.right -= side;
    var end = (node.offsetHeight - node.clientHeight) - px(style.borderTopWidth) - px(style.borderBottomWidth);
    if (end > 0) out.bottom -= end;
    return out;
  }

  function borderBoxOf(node) {
    var style = getComputedStyle(node);
    var box = rectOf(node);
    return {
      left: box.left + px(style.borderLeftWidth),
      top: box.top + px(style.borderTopWidth),
      right: box.right - px(style.borderRightWidth),
      bottom: box.bottom - px(style.borderBottomWidth)
    };
  }

  /** A readable name for one box: tag, classes, the data attributes that identify a control, its text. */
  function describe(node) {
    var text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text.length > 26) text = text.slice(0, 26) + '~';
    var classes = typeof node.className === 'string' && node.className.length > 0 ? '.' + node.className.split(' ').join('.') : '';
    var data = '';
    var names = ['data-action', 'data-field', 'data-select', 'data-card', 'data-lane', 'data-drawer'];
    for (var i = 0; i < names.length; i += 1) {
      var value = node.getAttribute(names[i]);
      if (value !== null) data += '[' + names[i] + '=' + value + ']';
    }
    return node.tagName.toLowerCase() + classes + data + (text.length > 0 ? ' "' + text + '"' : '');
  }

  function isHidden(node) {
    if (typeof node.className === 'string' && node.className.indexOf('kb-vh') !== -1) return true;
    var style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;
    var box = node.getBoundingClientRect();
    return box.width === 0 && box.height === 0;
  }

  function isControl(node) {
    var tag = node.tagName.toLowerCase();
    if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea') return true;
    return node.getAttribute('role') === 'button';
  }

  /** The ink box of this node's first real text run — the baseline proxy every text check uses. */
  function textBoxOf(node) {
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
    var text = walker.nextNode();
    while (text !== null && (text.nodeValue || '').replace(/\\s+/g, '').length === 0) text = walker.nextNode();
    if (text === null) return null;
    var range = document.createRange();
    range.selectNodeContents(text);
    var boxes = range.getClientRects();
    if (boxes.length === 0) return null;
    var box = boxes[0];
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  }

  /**
   * The nearest ancestor that scrolls, so a child of a scroller is not reported as escaping it.
   *
   * The lane row and the drawer body are 'overflow: auto' by design: their content is *supposed* to
   * leave the visible box. Everything else is held to its container.
   */
  function scrollerAncestor(node, stopAt) {
    var current = node.parentElement;
    while (current !== null && current !== stopAt) {
      var style = getComputedStyle(current);
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') return current;
      current = current.parentElement;
    }
    return null;
  }

  /** A row's own name, from its ancestry: enough to say which row a finding is about. */
  function rowName(node, specName) {
    var parts = [];
    var current = node;
    while (current !== null && parts.length < 3) {
      if (typeof current.className === 'string' && current.className.indexOf('kb-') !== -1) {
        var first = current.className.split(' ')[0];
        if (current.classList && current.classList.contains('kb-group')) {
          var label = current.querySelector(':scope > .kb-label') || current.querySelector(':scope > .kb-dim');
          parts.unshift(first + (label === null ? '' : ':' + (label.textContent || '').trim().split(' ')[0]));
        } else {
          parts.unshift(first);
        }
      }
      current = current.parentElement;
    }
    return parts.length === 0 ? specName : parts.join(' > ');
  }

  /** Does this row lead with its own text, so that its element children are not the whole story? */
  function hasDirectText(node) {
    for (var i = 0; i < node.childNodes.length; i += 1) {
      var child = node.childNodes[i];
      if (child.nodeType === 3 && (child.nodeValue || '').replace(/\s+/g, '').length > 0) return true;
    }
    return false;
  }

  function spread(values) {    if (values.length === 0) return 0;
    return Math.max.apply(null, values) - Math.min.apply(null, values);
  }

  function median(values) {
    if (values.length === 0) return 0;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  }

  function clusterLines(items) {
    var sorted = items.slice().sort(function (a, b) { return a.box.top - b.box.top; });
    var lines = [];
    for (var i = 0; i < sorted.length; i += 1) {
      var item = sorted[i];
      var placed = false;
      for (var j = 0; j < lines.length; j += 1) {
        var line = lines[j];
        if (item.box.top < line.bottom - 0.5 && item.box.bottom > line.top + 0.5) {
          line.items.push(item);
          line.top = Math.min(line.top, item.box.top);
          line.bottom = Math.max(line.bottom, item.box.bottom);
          placed = true;
          break;
        }
      }
      if (!placed) lines.push({ top: item.box.top, bottom: item.box.bottom, items: [item] });
    }
    for (var k = 0; k < lines.length; k += 1) {
      lines[k].items.sort(function (a, b) { return a.box.left - b.box.left; });
    }
    lines.sort(function (a, b) { return a.top - b.top; });
    return lines;
  }

  var ALIGN_FOR = {
    'flex-start': 'top', start: 'top',
    'flex-end': 'bottom', end: 'bottom',
    center: 'center',
    baseline: 'baseline',
    stretch: 'stretch',
    normal: 'stretch', '': 'stretch'
  };

  window.__measure = function (specs) {
    var out = { rows: [], findings: [], skippedInScroller: 0, panel: null, viewport: null, overflow: null };
    var panel = document.querySelector('.kb-page');
    out.viewport = { innerWidth: window.innerWidth, innerHeight: window.innerHeight };
    if (panel === null) return out;
    var panelBounds = borderBoxOf(panel);
    out.panel = round(rectOf(panel));
    // What the panel actually renders its text at. The sheet's own base rule is font: 13px/1.5
    // inherit, and this is the number that says whether that rule is in force or was dropped by the
    // parser — which no amount of reading the sheet can tell you.
    out.panelFont = {
      size: getComputedStyle(panel).fontSize,
      lineHeight: getComputedStyle(panel).lineHeight,
      family: getComputedStyle(panel).fontFamily.slice(0, 40),
      bodySize: getComputedStyle(document.body).fontSize
    };
    // The focused element, and whether it is wearing a :focus-visible ring. Recorded because this
    // probe drives every gesture with a **synthetic** MouseEvent, and Chrome's heuristic for
    // painting :focus-visible cannot see a pointer that never moved — so a ring may be this
    // script's artefact rather than the app's behaviour, and the honest thing is to say which
    // element is focused and what the browser decided, rather than to describe the pixels alone.
    out.focus = (function () {
      var active = document.activeElement;
      if (active === null || active === undefined) return null;
      var activeStyle = getComputedStyle(active);
      var visible = false;
      try { visible = active.matches(':focus-visible'); } catch (error) { visible = false; }
      return {
        element: describe(active),
        focusVisible: visible,
        outline: activeStyle.outlineWidth + ' ' + activeStyle.outlineStyle + ' ' + activeStyle.outlineColor,
        outlineOffset: activeStyle.outlineOffset
      };
    })();
    out.overflow = {
      documentScrollWidth: document.documentElement.scrollWidth,
      rootClientWidth: document.getElementById('root').clientWidth,
      rootScrollWidth: document.getElementById('root').scrollWidth,
      pageClientWidth: panel.clientWidth,
      pageScrollWidth: panel.scrollWidth
    };

    function finding(row, metric, magnitude, detail, numbers) {
      out.findings.push({
        row: row,
        metric: metric,
        mag: Math.round(magnitude * 100) / 100,
        detail: detail,
        numbers: numbers
      });
    }

    for (var s = 0; s < specs.length; s += 1) {
      var spec = specs[s];
      var nodes = document.querySelectorAll(spec.selector);
      for (var n = 0; n < nodes.length; n += 1) {
        var node = nodes[n];
        if (isHidden(node)) continue;
        var style = getComputedStyle(node);
        var display = style.display;
        var isFlex = display.indexOf('flex') !== -1;
        var column = isFlex && (style.flexDirection === 'column' || style.flexDirection === 'column-reverse');
        var name = spec.name + ' @ ' + rowName(node, spec.name) + (nodes.length > 1 ? ' #' + n : '');
        var content = contentBoxOf(node);
        var own = borderBoxOf(node);
        var declaredGap = px(style.columnGap || style.gap);
        var declaredAlign = style.alignItems === 'normal' ? 'stretch' : style.alignItems;
        var distributes = style.justifyContent === 'space-between' || style.justifyContent === 'space-around' || style.justifyContent === 'space-evenly';
        var items = [];
        var aligned = [];
        for (var c = 0; c < node.children.length; c += 1) {
          var child = node.children[c];
          // A .kb-spacer is a real flex child whose whole purpose is to push the rest of the row
          // apart, so it stays in the child list (its two gaps are the ones that are *meant* to be
          // enormous) and is left out of the alignment checks, where a zero-height box would be a
          // phantom outlier in every one of them.
          var isSpacer = typeof child.className === 'string' && child.className.indexOf('kb-spacer') !== -1;
          if (!isSpacer && isHidden(child)) continue;
          var childStyle = getComputedStyle(child);
          var entry = {
            node: child,
            label: describe(child),
            box: rectOf(child),
            text: textBoxOf(child),
            control: isControl(child),
            spacer: isSpacer,
            // Why a control is the height it is: the number alone says a button disagrees with the
            // input beside it, and only the font/line-height/padding says which declaration did it.
            font:
              'font ' + childStyle.fontSize + '/' + childStyle.lineHeight +
              ', padding ' + childStyle.paddingTop + ' ' + childStyle.paddingRight +
              ', border ' + childStyle.borderTopWidth +
              ', min-height ' + childStyle.minHeight
          };
          items.push(entry);
          if (!isSpacer) aligned.push(entry);
        }
        if (aligned.length === 0) continue;

        var record = {
          name: name,
          selector: spec.selector,
          dir: isFlex ? (column ? 'column' : 'row') : 'block',
          align: style.alignItems,
          justify: style.justifyContent,
          wrap: style.flexWrap,
          gap: declaredGap,
          // The row's own box, and whether it leads with a bare text node. Both are recorded because
          // two of this script's findings are only interpretable with them: a lane's width against the
          // 236px its CSS declares, and the fact that a notice's first child *is* its message text, so
          // "the first element child starts far into the content box" means nothing there.
          box: round(rectOf(node)),
          mixed: hasDirectText(node),
          count: items.length,
          lines: 0,
          topSpread: 0,
          bottomSpread: 0,
          centerSpread: 0,
          baselineSpread: 0,
          heightSpread: 0,
          gapSpread: 0,
          leadingSlack: 0,
          trailingSlack: 0,
          off: []
        };

        var lines = clusterLines(aligned);
        record.lines = lines.length;

        for (var l = 0; l < lines.length; l += 1) {
          var lineItems = lines[l].items;
          if (lineItems.length < 2) continue;
          var label = name + (lines.length > 1 ? ' line' + String(l + 1) : '');
          var tops = lineItems.map(function (item) { return item.box.top; });
          var bottoms = lineItems.map(function (item) { return item.box.bottom; });
          var centres = lineItems.map(function (item) { return (item.box.top + item.box.bottom) / 2; });
          var baselines = [];
          for (var t = 0; t < lineItems.length; t += 1) {
            if (lineItems[t].text !== null) baselines.push(lineItems[t].text.bottom);
          }
          var topSpread = spread(tops);
          var bottomSpread = spread(bottoms);
          var centerSpread = spread(centres);
          var baselineSpread = spread(baselines);
          record.topSpread = Math.max(record.topSpread, topSpread);
          record.bottomSpread = Math.max(record.bottomSpread, bottomSpread);
          record.centerSpread = Math.max(record.centerSpread, centerSpread);
          record.baselineSpread = Math.max(record.baselineSpread, baselineSpread);

          var expected = column ? 'left' : (ALIGN_FOR[declaredAlign] || 'top');
          if (column) {
            var lefts = lineItems.map(function (item) { return item.box.left; });
            var rights = lineItems.map(function (item) { return item.box.right; });
            var leftSpread = spread(lefts);
            var rightSpread = spread(rights);
            record.leadingSlack = Math.round((Math.min.apply(null, lefts) - content.left) * 100) / 100;
            record.trailingSlack = Math.round((content.right - Math.max.apply(null, rights)) * 100) / 100;
            var crossExpected = declaredAlign === 'center' ? 'center' : declaredAlign === 'flex-end' || declaredAlign === 'end' ? 'right' : 'left';
            var crossSpread = crossExpected === 'right' ? rightSpread : crossExpected === 'center' ? spread(lineItems.map(function (item) { return (item.box.left + item.box.right) / 2; })) : leftSpread;
            if (crossSpread > 1 && crossExpected !== 'center') {
              var offs = crossExpected === 'left' ? lefts : rights;
              var base = crossExpected === 'left' ? Math.min.apply(null, lefts) : Math.max.apply(null, rights);
              finding(label, 'row-edge', crossSpread,
                'column, align-items=' + declaredAlign + ' should share their ' + crossExpected + ' edge; it spreads by ' + crossSpread.toFixed(2) + 'px',
                { expected: crossExpected, spread: crossSpread, leftSpread: leftSpread, rightSpread: rightSpread,
                  off: lineItems.filter(function (item) { return Math.abs((crossExpected === 'left' ? item.box.left : item.box.right) - base) > 1; }).map(function (item) { return item.label; }) });
            }
          } else {
            var declaredOffenders = [];
            var reference = expected === 'center' ? centres[0] : expected === 'baseline' ? baselines[0] : expected === 'bottom' ? Math.max.apply(null, bottoms) : Math.min.apply(null, tops);
            for (var o = 0; o < lineItems.length; o += 1) {
              var item = lineItems[o];
              var value = expected === 'center' ? (item.box.top + item.box.bottom) / 2 : expected === 'baseline' ? (item.text === null ? null : item.text.bottom) : expected === 'bottom' ? item.box.bottom : item.box.top;
              if (value === null) continue;
              if (Math.abs(value - reference) > 1) declaredOffenders.push(item.label);
            }
            // The edge the row's own align-items names is the one that has to agree; the others are
            // reported as numbers and classified as explained. flex-start with lanes of different
            // heights is the case this exists for: their tops agree exactly and their bottoms differ
            // by 116px, which is what align-items: flex-start *means*.
            var declaredOkay =
              expected === 'center' ? centerSpread <= 1
                : expected === 'baseline' ? baselineSpread <= 1
                  : expected === 'bottom' ? bottomSpread <= 1
                    : expected === 'stretch' ? topSpread <= 1 && bottomSpread <= 1
                      : topSpread <= 1;
            var declaredSpread = expected === 'center' ? centerSpread : expected === 'baseline' ? baselineSpread : expected === 'bottom' ? bottomSpread : expected === 'stretch' ? Math.max(topSpread, bottomSpread) : topSpread;
            var unexplained = Math.max(topSpread, bottomSpread);
            if (!declaredOkay) {
              finding(label, expected === 'center' || expected === 'baseline' ? 'spread-explained' : 'row-edge',
                declaredSpread,
                'align-items=' + declaredAlign + ' should agree on their ' + expected + ', and they spread by ' + declaredSpread.toFixed(2) + 'px'
                  + ' (top ' + topSpread.toFixed(2) + 'px, bottom ' + bottomSpread.toFixed(2) + 'px)'
                  + (declaredOffenders.length > 0 ? ', off the ' + expected + ': ' + declaredOffenders.join(', ') : ''),
                { align: declaredAlign, checks: expected, spread: declaredSpread, topSpread: topSpread, bottomSpread: bottomSpread,
                  centerSpread: centerSpread, baselineSpread: baselineSpread, off: declaredOffenders.slice(0, 6) });
            } else if (unexplained > 1) {
              finding(label, 'spread-explained', unexplained,
                'align-items=' + declaredAlign + ' (checks the ' + expected + '); top spread ' + topSpread.toFixed(2) + 'px, bottom spread ' + bottomSpread.toFixed(2) + 'px'
                  + ' — the ' + expected + ' itself is within 1px',
                { align: declaredAlign, checks: expected, topSpread: topSpread, bottomSpread: bottomSpread, centerSpread: centerSpread,
                  baselineSpread: baselineSpread, off: declaredOffenders.slice(0, 6) });
            }

            // Gaps: consecutive sibling gaps in the line, against the row's declared gap and each other.
            // The walk is over the row's real children, so a pair that a a .kb-spacer stands between is
            // two pairs that both touch the spacer — and both are skipped, because the space around a
            // spacer is the one gap in the row that is meant to be enormous.
            var lineSet = [];
            for (var ls = 0; ls < lineItems.length; ls += 1) lineSet.push(lineItems[ls].node);
            var gaps = [];
            for (var g = 0; g < items.length - 1; g += 1) {
              var a = items[g];
              var b = items[g + 1];
              if (lineSet.indexOf(a.node) === -1 || lineSet.indexOf(b.node) === -1) continue;
              if (a.spacer || b.spacer) continue;
              gaps.push({ value: b.box.left - a.box.right, from: a.label, to: b.label });
            }
            if (gaps.length > 0) {
              var values = gaps.map(function (entry) { return entry.value; });
              var gapSpread = spread(values);
              record.gapSpread = Math.max(record.gapSpread, gapSpread);
              if (gapSpread > 1) {
                finding(label, distributes ? 'gap-distributed' : 'gap-mismatch', gapSpread,
                  'consecutive gaps in one line differ by ' + gapSpread.toFixed(2) + 'px (declared gap ' + declaredGap + 'px): '
                    + gaps.map(function (entry) { return entry.value.toFixed(2) + ' between ' + entry.from + ' and ' + entry.to; }).join('; '),
                  { declaredGap: declaredGap, values: values.map(function (value) { return Math.round(value * 100) / 100; }) });
              }
              if (!distributes) {
                var worst = null;
                for (var w = 0; w < gaps.length; w += 1) {
                  var delta = Math.abs(gaps[w].value - declaredGap);
                  if (worst === null || delta > worst.delta) worst = { delta: delta, entry: gaps[w] };
                }
                if (worst !== null && worst.delta > 1) {
                  finding(label, 'gap-vs-declared', worst.delta,
                    'a gap of ' + worst.entry.value.toFixed(2) + 'px between ' + worst.entry.from + ' and ' + worst.entry.to
                      + ' against the row\\'s declared ' + declaredGap + 'px',
                    { declaredGap: declaredGap, actual: Math.round(worst.entry.value * 100) / 100 });
                }
              }
            }
          }

          // Control heights: a control's own box, against the median of the controls in its line.
          var controls = lineItems.filter(function (item) { return item.control; });
          if (controls.length > 1) {
            var heights = controls.map(function (item) { return item.box.height; });
            var middle = median(heights);
            var offHeight = controls.filter(function (item) { return Math.abs(item.box.height - middle) > 1; });
            record.heightSpread = Math.max(record.heightSpread, spread(heights));
            if (offHeight.length > 0) {
              finding(label, 'control-height', spread(heights),
                'controls in one line differ in height by ' + spread(heights).toFixed(2) + 'px (median ' + middle.toFixed(2) + 'px): '
                  + offHeight.map(function (item) { return item.label + ' at ' + item.box.height.toFixed(2) + 'px (' + item.font + ')'; }).join('; '),
                { median: Math.round(middle * 100) / 100, off: offHeight.map(function (item) { return item.label + '=' + item.box.height.toFixed(2); }) });
            }
          }

          // A child leaving the row's own border box, or overlapping a sibling control.
          for (var e = 0; e < lineItems.length; e += 1) {
            var item2 = lineItems[e];
            var outsideRow = item2.box.top < own.top - 0.5 || item2.box.bottom > own.bottom + 0.5;
            if (outsideRow && getComputedStyle(node).overflow === 'visible') {
              finding(label, 'escape-row', Math.max(own.top - item2.box.top, item2.box.bottom - own.bottom),
                item2.label + ' leaves its own row\\'s border box',
                { row: round(own), child: round(item2.box) });
            }
          }
          for (var p = 0; p < lineItems.length; p += 1) {
            for (var q = p + 1; q < lineItems.length; q += 1) {
              if (!lineItems[p].control || !lineItems[q].control) continue;
              var overlapX = Math.min(lineItems[p].box.right, lineItems[q].box.right) - Math.max(lineItems[p].box.left, lineItems[q].box.left);
              var overlapY = Math.min(lineItems[p].box.bottom, lineItems[q].box.bottom) - Math.max(lineItems[p].box.top, lineItems[q].box.top);
              if (overlapX > 1 && overlapY > 1) {
                finding(label, 'overlap', Math.min(overlapX, overlapY),
                  lineItems[p].label + ' and ' + lineItems[q].label + ' overlap by ' + overlapX.toFixed(2) + 'x' + overlapY.toFixed(2) + 'px',
                  { a: lineItems[p].label, b: lineItems[q].label, x: overlapX, y: overlapY });
              }
            }
          }
        }

        // Content edge and trailing slack, for the row as a whole.
        var allLeft = null;
        var allRight = null;
        for (var m = 0; m < aligned.length; m += 1) {
          allLeft = allLeft === null ? aligned[m].box.left : Math.min(allLeft, aligned[m].box.left);
          allRight = allRight === null ? aligned[m].box.right : Math.max(allRight, aligned[m].box.right);
        }
        record.leadingSlack = Math.round((allLeft - content.left) * 100) / 100;
        record.trailingSlack = Math.round((content.right - allRight) * 100) / 100;
        // A row that leads with its own text (the error notice is a bare string and then a button) is
        // in inline flow, not flex placement: its element children are wherever the text pushed them,
        // so an edge measurement against the content box is measuring the sentence, not the layout.
        if (!record.mixed && record.leadingSlack > 1) {
          finding(name, 'leading-slack', record.leadingSlack,
            'the row\\'s first child starts ' + record.leadingSlack.toFixed(2) + 'px inside its content box',
            { leadingSlack: record.leadingSlack, content: round(content) });
        }
        var lastItem = aligned[aligned.length - 1];
        if (!record.mixed && lastItem.control && record.trailingSlack > 24) {
          finding(name, 'trailing-slack', record.trailingSlack,
            'the row\\'s last child is a control (' + lastItem.label + ') and stops ' + record.trailingSlack.toFixed(2) + 'px short of the row\\'s right content edge',
            { trailingSlack: record.trailingSlack, last: lastItem.label, justify: style.justifyContent, wrap: style.flexWrap, count: aligned.length });
        }

        record.off = [];
        out.rows.push(record);
      }
    }

    /**
     * A lane's used width against the width its own rule gives it.
     *
     * .kb-lane is flex: 0 0 var(--kb-lane-width, 236px) — it may neither grow nor shrink, and the
     * board scrolls sideways instead of reflowing. But flex-shrink: 0 does not cap a flex item at
     * its basis: the item's automatic minimum size (min-width: auto, i.e. its min-content width)
     * still wins, so one unbreakable token in one card title can push one lane wider than the sheet
     * says it is — which is exactly the kind of thing a scroller hides from every other check here,
     * because the row clips it. flexBasis reads 'auto' on the empty parked slot, which is
     * content-width on purpose, so only a resolved pixel basis is checked.
     */
    var laneNodes = panel.querySelectorAll('.kb-lane');
    for (var ln = 0; ln < laneNodes.length; ln += 1) {
      var laneNode = laneNodes[ln];
      var basis = px(getComputedStyle(laneNode).flexBasis);
      if (!isFinite(basis) || basis <= 0) continue;
      var laneWidth = rectOf(laneNode).width;
      if (laneWidth > basis + 1) {
        var widest = '';
        var cards = laneNode.querySelectorAll('[data-card]');
        for (var cd = 0; cd < cards.length; cd += 1) {
          var cardWidth = rectOf(cards[cd]).width;
          if (cardWidth > 0 && (widest === '' || cardWidth > px(widest))) widest = String(Math.round(cardWidth * 100) / 100);
        }
        finding('lane @ ' + (laneNode.getAttribute('data-lane') || '?'), 'lane-width', laneWidth - basis,
          'the lane is ' + laneWidth.toFixed(2) + 'px wide against the ' + basis.toFixed(2) + 'px its own rule declares'
            + ' (its widest card is ' + widest + 'px; a card is normally ' + (basis - 20).toFixed(0) + 'px)',
          { lane: laneNode.getAttribute('data-lane'), width: Math.round(laneWidth * 100) / 100, basis: basis,
            cards: Array.prototype.map.call(cards, function (card) { return card.getAttribute('data-card'); }),
            widestCard: widest === '' ? null : Number(widest) });
      }
    }

    // Escape: every box under the panel against the panel's own bounds. A box in a scroller is
    // counted rather than reported, because a scroller's content is meant to leave the visible box.
    var every = panel.querySelectorAll('*');    for (var x = 0; x < every.length; x += 1) {
      var element = every[x];
      if (isHidden(element)) continue;
      if (scrollerAncestor(element, panel) !== null) {
        out.skippedInScroller += 1;
        continue;
      }
      var box = rectOf(element);
      if (box.left < panelBounds.left - 0.5 || box.right > panelBounds.right + 0.5 || box.top < panelBounds.top - 0.5 || box.bottom > panelBounds.bottom + 0.5) {
        // An element whose own scrollWidth exceeds its clientWidth is a scroller, not an escaper.
        if (element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== 'visible') {
          out.skippedInScroller += 1;
          continue;
        }
        out.findings.push({
          row: rowName(element, 'panel'),
          metric: 'escape-panel',
          mag: Math.max(panelBounds.left - box.left, box.right - panelBounds.right, panelBounds.top - box.top, box.bottom - panelBounds.bottom),
          detail: describe(element) + ' leaves the panel\\'s bounds',
          numbers: { panel: round(panelBounds), box: round(box) }
        });
      }
    }

    return out;
  };
})();
</script>
<script>${react}</script>
<script>${reactDom}</script>
<script>${bundle}</script>
</body></html>
`;
}

// ------------------------------------------------------------------ a small CDP client

interface CdpError {
  code: number;
  message: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class Cdp {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(url: string) {
    this.socket = new WebSocket(url);
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the DevTools socket did not open')), COMMAND_TIMEOUT_MS);
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('the DevTools socket errored before opening'));
      });
    });
    this.socket.addEventListener('message', (event: MessageEvent) => {
      const text = typeof event.data === 'string' ? event.data : '';
      let message: { id?: number; result?: unknown; error?: CdpError };
      try {
        message = JSON.parse(text) as typeof message;
      } catch {
        return;
      }
      if (typeof message.id !== 'number') return;
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) entry.reject(new Error(`${String(message.error.code)}: ${message.error.message}`));
      else entry.resolve(message.result);
    });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} did not answer within ${String(COMMAND_TIMEOUT_MS)}ms`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression in the page and return its value (fails loudly on a page exception). */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{
      result: { value?: T; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown';
      throw new Error(`page exception in ${expression.slice(0, 80)}: ${detail}`);
    }
    return result.result.value as T;
  }

  /** Wait for a page fact, bounded, naming what it was looking at when it gives up. */
  async until(expression: string, what: string, timeoutMs = SETTLE_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown = null;
    while (Date.now() < deadline) {
      const value = await this.evaluate<boolean>(`Boolean(${expression})`);
      if (value) return;
      last = await this.evaluate<unknown>('typeof window.__health === "function" ? window.__health() : null');
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const diag = await this.evaluate<unknown>('typeof window.__diag === "function" ? window.__diag() : null');
    throw new Error(`timed out waiting for ${what} (health: ${JSON.stringify(last)}; page: ${JSON.stringify(diag)})`);
  }

  close(): void {
    this.socket.close();
  }
}

// ------------------------------------------------------------------ chrome

function launchChrome(page: string): { child: ChildProcess; profile: string } {
  if (!existsSync(CHROME)) throw new Error(`Chrome is not at ${CHROME}`);
  const profile = mkdtempSync(join(TEMP_DIR, 'profile-'));
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-component-update',
      '--disable-background-networking',
      '--no-first-run',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${String(WIDTHS[0]?.width ?? 1000)},${String(VIEW_HEIGHT)}`,
      `file://${page}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  return { child, profile };
}

async function waitForPort(profile: string): Promise<number> {
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const line = readFileSync(portFile, 'utf8').split('\n')[0]?.trim() ?? '';
      const parsed = Number.parseInt(line, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome never wrote its DevTools port');
}

interface Target {
  readonly id: string;
  readonly type: string;
  readonly url: string;
}

async function targetFor(port: number): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const answer = await fetch(`http://127.0.0.1:${String(port)}/json/list`);
      const targets = (await answer.json()) as Target[];
      const page = targets.find((entry) => entry.type === 'page');
      if (page !== undefined) return page.id;
    } catch {
      // Chrome is still starting; the loop is the retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Chrome exposed no page target');
}

// ------------------------------------------------------------------ the run

interface PageFinding {
  row: string;
  metric: string;
  mag: number;
  detail: string;
  numbers: Record<string, unknown>;
}

interface PageRow {
  name: string;
  selector: string;
  dir: string;
  align: string;
  justify: string;
  wrap: string;
  gap: number;
  count: number;
  lines: number;
  topSpread: number;
  bottomSpread: number;
  centerSpread: number;
  baselineSpread: number;
  heightSpread: number;
  gapSpread: number;
  leadingSlack: number;
  trailingSlack: number;
}

interface PageMeasurement {
  rows: PageRow[];
  findings: PageFinding[];
  skippedInScroller: number;
  panel: Record<string, number> | null;
  panelFont: { size: string; lineHeight: string; family: string; bodySize: string };
  focus: { element: string; focusVisible: boolean; outline: string; outlineOffset: string } | null;
  viewport: { innerWidth: number; innerHeight: number };
  overflow: Record<string, number>;
}

interface Finding extends PageFinding {
  state: string;
  theme: string;
  width: number;
}

/**
 * The classes the report keeps out of its `findings` array.
 *
 * `spread-explained` is a row whose *declared* alignment is within 1px while a different edge
 * differs — true of most rows and a statement about what `align-items` means, not a defect. It was
 * the bulk of a 2.4 MB report, so it is counted and left out.
 */
const EXCLUDED_METRICS = new Set(['spread-explained']);

/**
 * The fields of each positional row in the report's `rows`, in order.
 *
 * Positional arrays, with the names written once here, are what keeps the per-row measurements small
 * enough for the summary: the same object spelled out for every row was most of the old file's size.
 */
const REPORT_ROW_FIELDS = [
  'rowIndex',
  'align',
  'count',
  'lines',
  'topSpread',
  'bottomSpread',
  'centerSpread',
  'baselineSpread',
  'heightSpread',
  'gapSpread',
  'leadingSlack',
  'trailingSlack',
] as const;

function reportRow(row: PageRow, rowIndex: number): readonly (string | number)[] {
  return [
    rowIndex,
    row.align,
    row.count,
    row.lines,
    row.topSpread,
    row.bottomSpread,
    row.centerSpread,
    row.baselineSpread,
    row.heightSpread,
    row.gapSpread,
    row.leadingSlack,
    row.trailingSlack,
  ];
}

/** Count findings per type, most frequent first; the keys are the `metric` strings. */
function countsByMetric(findings: readonly Finding[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.metric, (counts.get(finding.metric) ?? 0) + 1);
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/** A blunt sort key, so the report can be read worst-first without pretending to be a score. */
function severity(finding: Finding): number {
  if (finding.metric === 'overlap') return 100 + finding.mag;
  if (finding.metric === 'lane-width') return 95 + finding.mag;
  if (finding.metric === 'escape-panel') return 90 + finding.mag;
  if (finding.metric === 'escape-row') return 80 + finding.mag;
  if (finding.metric === 'row-edge') return 60 + finding.mag;
  if (finding.metric === 'gap-mismatch' || finding.metric === 'gap-vs-declared') return 50 + finding.mag;
  if (finding.metric === 'control-height') return 40 + finding.mag;
  if (finding.metric === 'leading-slack') return 30 + finding.mag;
  if (finding.metric === 'trailing-slack') return 25 + finding.mag;
  if (finding.metric === 'spread-explained') return 10 + finding.mag;
  if (finding.metric === 'gap-distributed') return 5 + finding.mag;
  return 1 + finding.mag;
}

async function run(): Promise<{ findings: Finding[]; reportBytes: number }> {
  const styles = readStyles();
  const designCss = readDesignPlatformCss();
  writeFileSync(PAGE_PATH, pageSource(styles, designCss));
  mkdirSync(OUT_DIR, { recursive: true });
  const { child, profile } = launchChrome(PAGE_PATH);
  const findings: Finding[] = [];
  const rowsByState = new Map<string, PageRow[]>();
  const diagnostics = new Map<string, { font: unknown; focus: unknown }>();
  let cdp: Cdp | null = null;
  try {
    const port = await waitForPort(profile);
    const targetId = await targetFor(port);
    cdp = new Cdp(`ws://127.0.0.1:${String(port)}/devtools/page/${targetId}`);
    await cdp.open();
    await cdp.send('Page.enable', {});
    let health: Record<string, unknown> = {};
    const healthDeadline = Date.now() + 15_000;
    while (Date.now() < healthDeadline) {
      health = await cdp.evaluate<Record<string, unknown>>(
        'typeof window.__health === "function" ? window.__health() : { missing: true }'
      );
      if (health['hasPanel'] === true) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (health['hasPanel'] !== true) throw new Error(`the panel did not register: ${JSON.stringify(health)}`);
    await cdp.evaluate('document.fonts.ready.then(function () { return true; })');

    console.log(`align-probe: ${String(STATES.length)} states x ${String(THEMES.length)} themes x ${String(WIDTHS.length)} widths`);
    for (const width of WIDTHS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: width.width,
        height: VIEW_HEIGHT,
        deviceScaleFactor: 2,
        mobile: false,
      });
      console.log(`\n=== panel width ${String(width.width)}px  (${width.frame}) ===`);
      for (const theme of THEMES) {
        const dark = theme === 'dark';
        await cdp.evaluate(`(function () { document.body.${dark ? 'setAttribute' : 'removeAttribute'}('data-ds-dark-theme', ''); return document.body.hasAttribute('data-ds-dark-theme'); })()`);
        for (const state of STATES) {
          // Build the state: the transport answer, a fresh mount, the state's own setup, its own wait.
          await cdp.evaluate(`window.__mode = ${JSON.stringify(state.mode)}; window.__reset(); window.__mount(); undefined`);
          await cdp.until(
            "document.querySelector('.kb-page') !== null && window.__mountState.stageable === true",
            `${state.name} to mount`
          );
          for (const step of state.steps) {
            if (step.setup !== undefined) {
              await cdp.evaluate(`(function () { ${step.setup}; return true; })()`);
            }
            await cdp.until(step.ready, `${state.name} (${theme}, ${String(width.width)}px)`);
          }
          if (state.scroll === 'lanes-end') await cdp.evaluate('window.__scrollLanesToEnd()');
          if (state.scroll === 'drawer-checks') await cdp.evaluate("window.__bringIntoView('.kb-checks')");
          if (state.scroll === 'drawer-comments') await cdp.evaluate("window.__bringIntoView('.kb-list')");
          if (state.scroll === 'drawer-staged') await cdp.evaluate("window.__bringIntoView('.kb-group-danger')");
          await cdp.evaluate('window.__settle()');

          const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
          const suffix = width.width === 1000 ? '' : `-w${String(width.width)}`;
          const file = join(OUT_DIR, `align-${state.name}-${theme}${suffix}.png`);
          writeFileSync(file, Buffer.from(shot.data, 'base64'));

          const measured = await cdp.evaluate<PageMeasurement>('window.__measure(window.__rowSpecs)');
          const key = `${state.name}/${theme}/${String(width.width)}`;
          rowsByState.set(key, measured.rows);
          diagnostics.set(key, { font: measured.panelFont, focus: measured.focus });
          for (const entry of measured.findings) {
            findings.push({ ...entry, state: state.name, theme, width: width.width });
          }
          const worst = measured.findings.reduce((top, entry) => Math.max(top, entry.mag), 0);
          const overflow = measured.overflow ?? {};
          console.log(
            `  ${theme.padEnd(5)} ${state.name.padEnd(14)} rows=${String(measured.rows.length).padStart(2)}` +
              ` lines>1=${String(measured.rows.filter((row) => row.lines > 1).length).padStart(2)}` +
              ` findings=${String(measured.findings.length).padStart(2)} worst=${worst.toFixed(2)}px` +
              ` font=${measured.panelFont?.size ?? '?'}/${measured.panelFont?.lineHeight ?? '?'} focus=${measured.focus === null ? 'none' : (measured.focus.element + (measured.focus.focusVisible ? ' [focus-visible]' : ' [no ring]'))}` +
              ` (page ${String(overflow['pageScrollWidth'])}/${String(overflow['pageClientWidth'])}` +
              ` root ${String(overflow['rootScrollWidth'])}/${String(overflow['rootClientWidth'])}` +
              ` doc ${String(overflow['documentScrollWidth'])})`
          );
          // The three worst of each state, printed as they are measured. A run that dies on a later
          // state then still says what the earlier ones found, which is how this got debugged.
          for (const entry of measured.findings.slice().sort((a, b) => b.mag - a.mag).slice(0, 3)) {
            console.log(`        ${entry.metric.padEnd(19)} ${entry.mag.toFixed(2).padStart(7)}px  ${entry.row}`);
            console.log(`          ${entry.detail}`);
          }
        }
      }
    }
    findings.sort((a, b) => severity(b) - severity(a));
    const excluded = findings.filter((finding) => EXCLUDED_METRICS.has(finding.metric));
    const reportable = findings.filter((finding) => !EXCLUDED_METRICS.has(finding.metric));
    const excludedByMetric = countsByMetric(excluded);
    for (const metric of EXCLUDED_METRICS) excludedByMetric[metric] ??= 0;
    const rowNames: string[] = [];
    const rowNameIndex = new Map<string, number>();
    const reportRows: Record<string, (string | number)[][]> = {};
    for (const [key, rows] of rowsByState) {
      reportRows[key] = rows.map((row) => {
        let index = rowNameIndex.get(row.name);
        if (index === undefined) {
          index = rowNames.length;
          rowNameIndex.set(row.name, index);
          rowNames.push(row.name);
        }
        return reportRow(row, index);
      });
    }
    const panelFonts: unknown[] = [];
    const fontIndex = new Map<string, number>();
    const focusStates: unknown[] = [];
    const focusIndex = new Map<string, number>();
    const diagnosticRefs: Record<string, { font: number; focus: number | null }> = {};
    for (const [key, value] of diagnostics) {
      const font = JSON.stringify(value.font);
      if (!fontIndex.has(font)) {
        fontIndex.set(font, panelFonts.length);
        panelFonts.push(value.font);
      }
      const fontRef = fontIndex.get(font) as number;
      if (value.focus === null) {
        diagnosticRefs[key] = { font: fontRef, focus: null };
        continue;
      }
      const focus = JSON.stringify(value.focus);
      if (!focusIndex.has(focus)) {
        focusIndex.set(focus, focusStates.length);
        focusStates.push(value.focus);
      }
      diagnosticRefs[key] = { font: fontRef, focus: focusIndex.get(focus) as number };
    }
    const report = {
      at: new Date().toISOString(),
      widths: WIDTHS,
      states: STATES.map((state) => state.name),
      // The counts cover every finding; `findings` below covers only what a reader acts on. Both
      // numbers are printed, so the file cannot quietly mean a different total than the terminal.
      summary: {
        totalFindings: findings.length,
        actionable: reportable.length,
        excludedByMetric,
        countsByMetric: countsByMetric(findings),
      },
      rowFields: REPORT_ROW_FIELDS,
      rowNames,
      findings: reportable,
      rows: reportRows,
      panelFonts,
      focusStates,
      diagnostics: diagnosticRefs,
    };
    const json = JSON.stringify(report);
    writeFileSync(REPORT_PATH, json);
    return { findings, reportBytes: Buffer.byteLength(json) };
  } finally {
    cdp?.close();
    child.kill('SIGKILL');
  }
}

// ------------------------------------------------------------------ main

const { findings, reportBytes } = await run();
/**
 * The outlier table: one line per (metric, row), worst magnitude first.
 *
 * Grouped rather than listed one finding at a time, because the same disagreement repeats across 12
 * states, 2 themes and 3 widths — 1792 rows of it in the first full run. A table of 28 groups says
 * what is wrong; a table of 1792 says the same thing 64 times. This table is the run's ungrouped
 * record; the report beside it keeps the actionable subset and the counts for every type, not the
 * `spread-explained` stream.
 */
const groups = new Map<string, { metric: string; row: string; count: number; mag: number; detail: string; states: Set<string>; widths: Set<string>; themes: Set<string> }>();
for (const finding of findings) {
  const key = `${finding.metric}|${finding.row.replace(/ #\d+$/, '').replace(/ line\d+$/, '')}`;
  const entry = groups.get(key) ?? { metric: finding.metric, row: key.split('|')[1] ?? '', count: 0, mag: 0, detail: finding.detail, states: new Set<string>(), widths: new Set<string>(), themes: new Set<string>() };
  entry.count += 1;
  if (finding.mag >= entry.mag) {
    entry.mag = finding.mag;
    entry.detail = finding.detail;
  }
  entry.states.add(finding.state);
  entry.widths.add(`${String(finding.width)}px`);
  entry.themes.add(finding.theme);
  groups.set(key, entry);
}
const table = [...groups.values()].sort((a, b) => b.mag - a.mag);
const actionable = findings.filter((finding) => !EXCLUDED_METRICS.has(finding.metric)).length;
console.log(`\n${String(findings.length)} findings in ${String(table.length)} groups, worst first:`);
console.log(
  `  ${String(actionable)} actionable, ${String(findings.length - actionable)} spread-explained` +
    ` (kept out of the report's findings; both counts are in its summary)`
);
console.log('metric | row | measured | states x themes x widths | what disagrees');
for (const entry of table) {
  console.log(
    `\n${entry.mag.toFixed(2).padStart(8)}px  ${entry.metric.padEnd(18)} ${entry.row}\n` +
      `          seen ${String(entry.count)}x over ${String(entry.states.size)} states, ${[...entry.themes].join('/')}, ${[...entry.widths].join(' ')}\n` +
      `          ${entry.detail}`
  );
}
console.log(`\nsummary report: ${REPORT_PATH} (${(reportBytes / 1024).toFixed(0)} KB)`);
process.exit(0);
