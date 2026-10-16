/**
 * The drag affordance, driven through **real Chrome** — the check jsdom cannot make.
 *
 * `test/client.dom.test.ts` fires synthetic `dragstart`/`dragover`/`drop` events, so it can prove the
 * route, the staging and the mutation record, but it cannot prove that a real drag over a real lane
 * ever reaches that route: hit-testing, the browser's own drag pipeline, and the coordinates a human's
 * pointer actually occupies are all outside jsdom. This script closes that gap by driving the Chrome
 * DevTools Protocol against the panel rendered in a real browser.
 *
 * ## How the page is built
 *
 * There is no test framework here and no second implementation of the harness. Node renders nothing
 * for the assertions to see — the page does that, exactly as `scripts/capture-panel.mts` does it:
 *
 * - the **bundle** is `lib/v1/client.js`, the artifact the app loads, evaluated through a stub
 *   `window.__ModuleLoader__` and required the way the app requires it;
 * - the **board** is `test/harness.ts`'s own `boardPayload()`, serialised into the page;
 * - the **transport is faked** and nothing else: one `window.fetch` answering `/board`, `/mutate` and
 *   `/task/`, recording every mutation. That is the same bargain the jsdom suite makes (only the
 *   network is fake), and it is why the DOM, the store, the renderer and this drag are all real.
 *
 * ## The protocol commands, and why those
 *
 * 1. **`Input.setInterceptDrags`** — hands the drag to the protocol after `dragstart` instead of
 *    letting Chrome run its own blocking drag loop. Without it, the `mousePressed`/`mouseMoved` calls
 *    that begin the drag never return, because the renderer is inside the native loop.
 * 2. **`Input.dispatchMouseEvent`** (`mouseMoved`, `mousePressed`, `mouseMoved`, `mouseReleased`) —
 *    this is what makes it a *real* drag: Chrome decides that the card under the pointer is draggable,
 *    fires the card's own `dragstart`, and only then does interception take over. Hit-testing is the
 *    browser's, not ours.
 * 3. **`Input.dispatchDragEvent`** (`dragEnter`, `dragOver`, `drop`) — the intercepted half. The
 *    coordinates are the lane's own centre, read from the live DOM, so the drop lands where the layout
 *    actually is; this is the part jsdom cannot imitate, because jsdom has no layout.
 * 4. **`Input.dispatchKeyEvent`** (`rawKeyDown` + `Alt` modifier) for `Alt+ArrowRight`, so the keyboard
 *    path into Dropped is also driven by the browser rather than by a synthetic DOM event.
 *
 * The alternative (`Input.dispatchDragEvent` alone, with a hand-made `DragData`) was rejected: it never
 * fires the source's `dragstart`, so the panel's own drag state would be set by this script rather than
 * by the page, and the drag pipeline would not be under test at all.
 *
 * ## What it observes
 *
 * One observation per behaviour, each printed PASS/FAIL, with a non-zero exit if any fails:
 *
 * - a real drag from a card to a legal lane moves the card and sends exactly one `move`;
 * - a real drag onto Dropped sends **no** mutation, leaves the card where it was, and opens that
 *   card's drawer with the drop staged and the reason field focused;
 * - the drawer's own `Move … to Dropped` stages into the drawer that is already open;
 * - `Alt+→` into Dropped stages rather than sending.
 *
 * ## Run
 *
 * Through the guard, one run at a time — this spawns Chrome, which needs ~1.35 GB of process tree on
 * macOS just to start, so the cap is 2560 MB and not the 1024 MB a pure-logic run takes:
 *
 *   node ~/.dsh/scripts/guard/guard.mjs --limit-mb 2560 -- \
 *     node --max-old-space-size=384 \
 *     ~/.dsh/profiles/desktop/plugins/dsh-kanban/scripts/drag-probe.mts
 *
 * Nothing is cached: the bundle, the harness and the page are read fresh on every run, so this can be
 * re-run after any client change. No new dependency is used — `WebSocket` is Node's own, and Chrome is
 * the browser the capture script already spawns.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boardPayload } from '../test/harness.ts';

// ------------------------------------------------------------------ paths and constants

const HERE = new URL('..', import.meta.url);
const BUNDLE_PATH = fileURLToPath(new URL('lib/v1/client.js', HERE));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TEMP_DIR = mkdtempSync(join(tmpdir(), 'dsh-kanban-drag-'));
const VIEW = { width: 1280, height: 900 } as const;
/** Per-command bound. A drag step that never returns is a failure, not a reason to hang the guard. */
const COMMAND_TIMEOUT_MS = 20_000;

// ------------------------------------------------------------------ the page

/**
 * The board the page mounts, from the suite's own fixture.
 *
 * One refined backlog card, one ready, two in progress, one done and one dropped — the same six cards
 * `test/client.dom.test.ts` renders, so an observation here and a case there are about the same board.
 */
function fixture(): Record<string, unknown> {
  const payload = boardPayload();
  const fullDor = Object.fromEntries(
    ['outcome', 'acceptance', 'write-scope', 'estimate'].map((id) => [id, { at: '2026-10-01T00:00:00.000Z', by: 'human:dhira' }])
  );
  const tasks = (payload.tasks as Record<string, unknown>[]).map((task) => (task.id === 'T-001' ? { ...task, dor: fullDor } : task));
  return {
    ...payload,
    tasks: [...tasks, { ...(tasks[0] as Record<string, unknown>), id: 'T-006', state: 'dropped', position: 0, droppedReason: 'superseded' }],
    total: 6,
  };
}

/** The captured stylesheet, read from the artifact exactly as `capture-panel.mts` reads it. */
function readStyles(): string {
  const source = readFileSync(BUNDLE_PATH, 'utf8');
  const at = source.indexOf('STYLES = `');
  if (at < 0) throw new Error('lib/v1/client.js no longer assigns STYLES a template literal');
  const start = source.indexOf('`', at) + 1;
  const end = source.indexOf('`', start);
  if (end < 0) throw new Error('unterminated STYLES template literal');
  return source.slice(start, end);
}

function pageSource(): string {
  const bundle = readFileSync(BUNDLE_PATH, 'utf8');
  const styles = readStyles();
  const payload = JSON.stringify(fixture());
  // React and ReactDOM are the app's own dependency, inlined from the plugin's `node_modules` — no CDN
  // and no new dependency. **Inline, not `<script src>`**: a `file://` document has an opaque origin
  // and Chrome refuses to load a subresource from one, so a linked script silently never runs. One
  // self-contained document is what makes this page testable at all.
  const react = readFileSync(join(fileURLToPath(HERE), 'node_modules/react/umd/react.development.js'), 'utf8');
  const reactDom = readFileSync(join(fileURLToPath(HERE), 'node_modules/react-dom/umd/react-dom.development.js'), 'utf8');
  // The page is a template literal in *this* file, so its own scripts cannot use backticks or `${`.
  // Everything inside is single-quoted plain ES2020, which also keeps this readable.
  return `<!doctype html>
<html><head><meta charset="utf-8" /><style>
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
#root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
#root > * { flex: 1 1 auto; min-height: 0; }
${styles}
</style></head>
<body data-ds-dark-theme>
<div id="root"></div>
<script>
// Capture anything the page scripts throw: a silently dead script is the failure mode this whole
// script exists to avoid, and "the panel did not register" with no reason is not a report.
window.__pageErrors = [];
window.addEventListener('error', function (event) {
  window.__pageErrors.push(String(event.message) + ' @ ' + String(event.filename) + ':' + String(event.lineno));
});
</script>
<script>
(function () {
  'use strict';
  var BOARD = ${payload};
  var calls = [];
  var mutations = 0;
  window.__calls = calls;
  window.__mutations = function () { return mutations; };

  window.fetch = function (url, init) {
    var method = (init && init.method) || 'GET';
    var body = {};
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (error) { body = {}; }
    calls.push({ url: String(url), method: method, body: body });
    var answer = function (status, payload) {
      return Promise.resolve({ ok: status >= 200 && status < 300, status: status, text: function () { return Promise.resolve(JSON.stringify(payload)); } });
    };
    if (String(url).indexOf('/board') !== -1) {
      // After a mutation the host would answer 304 for a revision it has already sent, which is what
      // keeps the panel's own optimistic payload on screen; the same answer is given here so an
      // observation about where a card landed is about the panel rather than about this stub.
      return mutations === 0 ? answer(200, { ok: true, board: BOARD, rev: BOARD.rev }) : answer(304, {});
    }
    if (String(url).indexOf('/mutate') !== -1) {
      mutations += 1;
      return answer(200, { ok: true, rev: BOARD.rev + mutations, result: {} });
    }
    if (String(url).indexOf('/task/') !== -1) return answer(200, { ok: true, task: null, comments: [], events: [] });
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
        // The plugin is applied here, in the same turn the bundle finishes loading: the factory is
        // what module.exports would have been, so this is the app's own registration path. No
        // backticks in this document, deliberately: the whole page is one template literal.
        window.__bundle.apply({
          slots: {
            register: function (spec, component) { if (spec.name === 'main') window.__bundle.__panel = component; },
            inject: function (name, run) { run(); }
          }
        });
        window.__probeReady = true;
      } catch (error) {
        window.__bundleError = String(error && error.stack ? error.stack : error);
      }
    }
  };

  window.__reset = function () {
    calls.length = 0;
    mutations = 0;
  };
  window.__mountError = null;
  window.__root = null;
  window.__epoch = 0;
  window.__mount = function () {
    try {
      // One React root for the page's life, re-rendered under a new key for each observation. React
      // therefore tears the previous panel down itself — doing it from outside made its own
      // reconciliation throw removeChild on nodes it still owned, which killed the mount silently —
      // and the new panel is genuinely new: new store, new board, and the old one's polling stopped by
      // its own effect cleanup, so one observation cannot read another's board.
      window.__epoch += 1;
      if (window.__root === null) window.__root = window.ReactDOM.createRoot(document.getElementById('root'));
      window.__root.render(
        window.React.createElement(window.__bundle.__panel, {
          key: 'panel-' + window.__epoch,
          React: window.React,
          store: window.__bundle.createStore(),
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
      hasLoader: typeof window.__ModuleLoader__ === 'object',
      storeFactory: typeof window.__bundle === 'object' ? typeof window.__bundle.createStore : 'n/a',
      bundleError: window.__bundleError,
      mountError: window.__mountError,
      rootHtml: document.getElementById('root').innerHTML.length
    };
  };
  window.__probeState = function () {
    var lanes = {};
    var nodes = document.querySelectorAll('[data-lane]');
    for (var i = 0; i < nodes.length; i += 1) {
      var lane = nodes[i];
      lanes[lane.getAttribute('data-lane')] = Array.prototype.map.call(
        lane.querySelectorAll('[data-card]'),
        function (card) { return card.getAttribute('data-card'); }
      );
    }
    var drawer = document.querySelector('[data-drawer]');
    var reason = document.querySelector('[data-field="drop-reason"]');
    return {
      lanes: lanes,
      drawer: drawer === null ? null : drawer.getAttribute('data-drawer'),
      staged: drawer === null ? null : drawer.getAttribute('data-staged'),
      reasonPresent: reason !== null,
      reasonFocused: reason !== null && document.activeElement === reason,
      reasonValue: reason === null ? null : reason.value,
      moreOpen: (function () {
        var toggle = document.querySelector('[data-action="more"]');
        return toggle !== null && toggle.getAttribute('aria-expanded') === 'true';
      })(),
      overLane: (function () {
        var over = document.querySelector('.kb-lane-over');
        return over === null ? null : over.getAttribute('data-lane');
      })(),
      mutations: mutations,
      mutateBodies: calls.filter(function (call) { return call.url.indexOf('/mutate') !== -1; }).map(function (call) { return call.body; })
    };
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

  /** Send one command and wait for its own answer, or for the bound. */
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
      throw new Error(`page exception in ${expression.slice(0, 60)}: ${detail}`);
    }
    return result.result.value as T;
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
      `--window-size=${VIEW.width},${VIEW.height}`,
      `file://${page}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  return { child, profile };
}

/**
 * The port Chrome chose, read from the profile it was told to write it into.
 *
 * `--remote-debugging-port=0` is deliberate: a fixed port would collide with the running app's debug
 * port or with a second run of this script, and the profile file is how the browser reports the one it
 * actually took.
 */
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

// ------------------------------------------------------------------ drag helpers

/** A rectangle in the page's own coordinates, read from the live layout. */
interface Box {
  readonly x: number;
  readonly y: number;
}

/**
 * Bring a lane into view before its centre is measured.
 *
 * The board is six fixed 236px lanes in an `overflow-x: auto` row, so at the page's width Dropped is
 * scrolled off the right-hand edge. A coordinate outside the viewport is not over the lane at all —
 * the first run of this probe dropped a card onto the *Done* lane because Dropped's measured centre
 * was past the clip — so the lane is scrolled to its own end first and only then measured.
 */
async function showLane(cdp: Cdp, lane: string): Promise<void> {
  await cdp.evaluate(`(function () {
    var node = document.querySelector(${JSON.stringify(lane)});
    if (node === null) return undefined;
    var row = node.closest('.kb-lanes');
    if (row !== null) row.scrollLeft = node.offsetLeft - row.offsetLeft;
    else if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return undefined;
  })()`);
  // Wait until the element really is inside the viewport: a scroll that has not been applied yet
  // measures the pre-scroll rectangle, and a coordinate outside the clip belongs to whatever lane is
  // actually under it. This is the check that a sleep cannot make.
  await untilEval(
    cdp,
    `(function () { var r = document.querySelector(${JSON.stringify(lane)}).getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; })()`,
    `${lane} to be scrolled into view`
  );
}

async function centreOf(cdp: Cdp, selector: string): Promise<Box> {
  const box = await cdp.evaluate<Box | null>(`(function () {
    var node = document.querySelector(${JSON.stringify(selector)});
    if (node === null) return null;
    var rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (box === null) throw new Error(`nothing matches ${selector}`);
  return box;
}

/**
 * A point over the **lane itself**, not over a card standing in it.
 *
 * The lane's vertical centre lands on whatever card happens to be there, and a card is not inside a
 * `[data-lane]` from the drag controller's point of view — the drop went to an element whose nearest
 * lane ancestor was null. The lane's header row is always part of the lane and never a card, so that
 * is where the pointer goes.
 */
async function lanePoint(cdp: Cdp, lane: string): Promise<Box> {
  const box = await cdp.evaluate<Box | null>(`(function () {
    var lane = document.querySelector(${JSON.stringify(lane)});
    if (lane === null) return null;
    var head = lane.querySelector('.kb-lane-head');
    var rect = (head === null ? lane : head).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (box === null) throw new Error(`nothing matches ${lane}`);
  return box;
}

const mouse = (type: string, point: Box, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type,
  x: Math.round(point.x),
  y: Math.round(point.y),
  button: 'left',
  buttons: type === 'mouseReleased' ? 0 : 1,
  ...extra,
});

const dragData = (point: Box): Record<string, unknown> => ({ x: Math.round(point.x), y: Math.round(point.y), data: { items: [], dragOperationsMask: 1 } });

/**
 * One genuine drag from a card to a lane, through Chrome's own pipeline.
 *
 * `setInterceptDrags` is enabled **before** the press: interception is what stops Chrome entering its
 * blocking native loop, so the three protocol calls that begin the drag all return. The drag events
 * themselves are then dispatched at the lane's measured centre.
 */
async function dragCardToLane(cdp: Cdp, card: string, lane: string): Promise<{ painted: string }> {
  let painted = '';
  await cdp.send('Input.setInterceptDrags', { enabled: true });
  // The card is scrolled to itself first (a no-op when the whole row fits), so the press lands on the
  // card whatever the viewport; `showLane` then checks the *target* really is inside the window before
  // any coordinate is taken from it.
  await showLane(cdp, card);
  const from = await centreOf(cdp, card);
  await showLane(cdp, lane);
  const to = await lanePoint(cdp, lane);
  const over = await cdp.evaluate<string>(`(function () {
    var node = document.elementFromPoint(${String(Math.round(to.x))}, ${String(Math.round(to.y))});
    var laneNode = node === null ? null : node.closest('[data-lane]');
    return laneNode === null ? 'none' : String(laneNode.getAttribute('data-lane'));
  })()`);
  // A coordinate that is not over the lane it was measured for produces a silently wrong drop — this
  // probe made exactly that mistake once, landing on Done — so the assumption is checked, not assumed.
  if (over !== lane.replace(/^\[data-lane="|"\]$/g, '')) {
    throw new Error(`the point for ${lane} is over ${over}, so the layout and the measurement disagree`);
  }

  // The panel's drag state is set by the card's own `dragstart`, which Chrome fires from the move
  // below at its own moment. A `dragOver`/`drop` that arrives before it reaches `onDrop` with
  // `drag === null`, and the gesture is silently a no-op — so the listener goes on **before** the
  // press and the drag is waited for rather than assumed.
  await cdp.send('Runtime.evaluate', {
    expression: '(function () { window.__dragSeen = false; document.addEventListener("dragstart", function () { window.__dragSeen = true; }, true); return true; })()',
  });
  await cdp.send('Input.dispatchMouseEvent', mouse('mouseMoved', from));
  await cdp.send('Input.dispatchMouseEvent', mouse('mousePressed', from, { clickCount: 1 }));
  // Four pixels is past Chrome's drag threshold and nowhere near a lane boundary.
  await cdp.send('Input.dispatchMouseEvent', mouse('mouseMoved', { x: from.x + 4, y: from.y + 4 }));
  await untilEval(cdp, 'window.__dragSeen === true', 'the card to start a drag');

  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...dragData(to) });
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...dragData(to) });
  // Read the legal-target class **while the gaze is live**: this is the affordance itself, and it is
  // read from the page's own DOM rather than inferred from the drop that follows.
  await new Promise((resolve) => setTimeout(resolve, 80));
  painted = await cdp.evaluate<string>('String((document.querySelector(".kb-lane-over") || {}).getAttribute ? document.querySelector(".kb-lane-over").getAttribute("data-lane") : "")');
  // `dragOver` is where the lane's own `setDrag(dragOver(...))` lands, so the drop below is the one a
  // human's release would produce rather than a second, independent call.
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...dragData(to) });

  await cdp.send('Input.dispatchMouseEvent', mouse('mouseReleased', to, { clickCount: 1 }));
  await cdp.send('Input.setInterceptDrags', { enabled: false });
  return { painted };
}

/** Wait until a boolean expression in the page is true, or fail with what it was. */
async function untilEval(cdp: Cdp, expression: string, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await cdp.evaluate<boolean>(`Boolean(${expression})`);
    if (value) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const log = await cdp.evaluate<unknown>('window.__pageErrors ?? null');
  throw new Error(`timed out waiting for ${what} (page errors: ${JSON.stringify(log)})`);
}

// ------------------------------------------------------------------ observations

interface Observation {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface ProbeState {
  lanes: Record<string, string[]>;
  drawer: string | null;
  staged: string | null;
  reasonPresent: boolean;
  reasonFocused: boolean;
  reasonValue: string | null;
  moreOpen: boolean;
  overLane: string | null;
  mutations: number;
  mutateBodies: Array<Record<string, unknown>>;
}

async function state(cdp: Cdp): Promise<ProbeState> {
  return cdp.evaluate<ProbeState>('window.__probeState()');
}

/** Wait until the page answers a predicate, so no observation races the render. */
async function until(cdp: Cdp, predicate: (state: ProbeState) => boolean, what: string): Promise<ProbeState> {
  const deadline = Date.now() + 5_000;
  let last = await state(cdp);
  while (Date.now() < deadline) {
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 60));
    last = await state(cdp);
  }
  throw new Error(`timed out waiting for ${what} (last state: ${JSON.stringify(last.lanes)})`);
}

async function fresh(cdp: Cdp): Promise<void> {
  await cdp.evaluate('window.__reset(); window.__mount(); undefined');
  await until(cdp, (current) => (current.lanes['dropped'] ?? []).length > 0, 'the board to render');
}

async function run(): Promise<Observation[]> {
  // The page is written to a fixed path rather than a temp file that is deleted: when an observation
  // fails, the document the browser actually saw is the first thing worth reading.
  const page = '/tmp/dsh-kanban-drag-probe-page.html';
  writeFileSync(page, pageSource());
  const { child, profile } = launchChrome(page);
  const observations: Observation[] = [];
  let cdp: Cdp | null = null;
  try {
    const port = await waitForPort(profile);
    const targetId = await targetFor(port);
    cdp = new Cdp(`ws://127.0.0.1:${String(port)}/devtools/page/${targetId}`);
    await cdp.open();
    // The page reports whether the bundle registered a panel at all. This is polled rather than asked
    // once: the protocol attaches as soon as a target exists, which can be before the document's own
    // scripts have finished running, and "not yet" is not the same as "never".
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
    // The board is six fixed 236px lanes in an `overflow-x: auto` row — a real constraint, and the
    // reason a screenshot review has to scroll. A drag, though, needs the source card and the target
    // lane hittable at the same moment: with the row clipped, scrolling the target into view takes the
    // card out of it, and the drop lands on whatever lane really is under those coordinates (the first
    // run of this probe dropped onto Done for exactly that reason). The viewport is therefore emulated
    // wide enough to hold the whole row. Nothing about the panel is changed — same markup, same
    // stylesheet, same widths — only the window the measurement is taken in.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1800,
      height: VIEW.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await fresh(cdp);

    // O1 — a real drag to a legal lane moves the card and sends exactly one move.
    await fresh(cdp);
    await dragCardToLane(cdp, '[data-card="T-003"]', '[data-lane="review"]');
    await until(cdp, (current) => (current.lanes['review'] ?? []).includes('T-003'), 'T-003 to land in review');
    const o1 = await state(cdp);
    observations.push({
      name: 'a real drag to a legal lane moves the card and sends one move',
      ok:
        (o1.lanes['review'] ?? []).includes('T-003') &&
        !(o1.lanes['in-progress'] ?? []).includes('T-003') &&
        o1.mutations === 1 &&
        o1.mutateBodies[0]?.op === 'move' &&
        o1.mutateBodies[0]?.toState === 'review',
      detail: `review=${JSON.stringify(o1.lanes['review'] ?? [])} in-progress=${JSON.stringify(o1.lanes['in-progress'] ?? [])} mutations=${String(o1.mutations)} first=${JSON.stringify(o1.mutateBodies[0] ?? null)}`,
    });

    // O2 — a real drag onto Dropped sends nothing, keeps the card, and stages the drawer.
    await fresh(cdp);
    const droppedDrag = await dragCardToLane(cdp, '[data-card="T-002"]', '[data-lane="dropped"]');
    const o2 = await until(cdp, (current) => current.drawer === 'T-002', 'the staged drawer to open');
    const o2m = await state(cdp);
    observations.push({
      name: 'a real drag onto Dropped sends no move, never paints the lane, and stages the reason',
      ok:
        o2m.mutations === 0 &&
        (o2m.lanes['ready'] ?? []).includes('T-002') &&
        !(o2m.lanes['dropped'] ?? []).includes('T-002') &&
        o2m.drawer === 'T-002' &&
        o2m.staged === 'dropped' &&
        o2m.reasonPresent &&
        o2m.reasonFocused &&
        droppedDrag.painted !== 'dropped',
      detail: `mutations=${String(o2m.mutations)} drawer=${String(o2m.drawer)} staged=${String(o2m.staged)} reasonPresent=${String(o2m.reasonPresent)} reasonFocused=${String(o2m.reasonFocused)} paintedWhileOver=${JSON.stringify(droppedDrag.painted)} ready=${JSON.stringify(o2m.lanes['ready'] ?? [])} dropped=${JSON.stringify(o2m.lanes['dropped'] ?? [])} (waited on drawer: ${String(o2.drawer)})`,
    });

    // O4 — the drawer's own `Move … to Dropped` stages into the drawer that is already open.
    await fresh(cdp);
    await cdp.evaluate(`document.querySelector('[data-card="T-005"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); undefined`);
    await until(cdp, (current) => current.drawer === 'T-005', 'the drawer to open');
    await cdp.evaluate(`document.querySelector('[data-action="more"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); undefined`);
    await until(cdp, (current) => current.moreOpen, 'More moves to open');
    await cdp.evaluate(`document.querySelector('[aria-label="Move T-005 to Dropped"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); undefined`);
    const o4 = await until(cdp, (current) => current.staged === 'dropped', 'the drop to stage');
    observations.push({
      name: 'the drawer move button to Dropped stages instead of sending a reasonless move',
      ok: o4.staged === 'dropped' && o4.reasonPresent && o4.mutations === 0 && o4.mutateBodies.length === 0,
      detail: `staged=${String(o4.staged)} reasonPresent=${String(o4.reasonPresent)} mutations=${String(o4.mutations)}`,
    });

    // O5 — the keyboard path into Dropped stages as well, driven through the protocol.
    await fresh(cdp);
    await cdp.evaluate(`document.querySelector('[data-card="T-005"]').focus(); undefined`);
    // `rawKeyDown` with the Alt modifier is what the browser sends for `Alt+→`; the panel reads
    // `event.altKey` and the arrow key on `keydown`, so this is the real shortcut, not a synthetic
    // DOM event.
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'ArrowRight',
      code: 'ArrowRight',
      windowsVirtualKeyCode: 39,
      nativeVirtualKeyCode: 39,
      modifiers: 1,
    });
    const o5 = await until(cdp, (current) => current.drawer === 'T-005', 'the keyboard move to stage');
    observations.push({
      name: 'Alt+ArrowRight into Dropped stages instead of sending a reasonless move',
      ok: o5.drawer === 'T-005' && o5.staged === 'dropped' && o5.mutations === 0,
      detail: `drawer=${String(o5.drawer)} staged=${String(o5.staged)} mutations=${String(o5.mutations)}`,
    });

    return observations;
  } finally {
    cdp?.close();
    child.kill('SIGKILL');
    // Chrome keeps writing into its profile for a moment after the signal, so the directory is left
    // alone rather than racing it: it is the OS temp dir, and `--user-data-dir` was ours to create.
  }
}

// ------------------------------------------------------------------ main

// Observations are collected first (so every one of them is attempted) and printed together, which is
// what makes a partial run readable rather than a single thrown error.
const observations = await run();
let failed = 0;
for (const observation of observations) {
  if (!observation.ok) failed += 1;
  console.log(`${observation.ok ? 'PASS' : 'FAIL'}  ${observation.name}`);
  console.log(`      ${observation.detail}`);
}
console.log(failed === 0 ? `\ndrag-probe: PASS (${String(observations.length)} observations)` : `\ndrag-probe: FAIL (${String(failed)} of ${String(observations.length)})`);
process.exit(failed === 0 ? 0 : 1);
