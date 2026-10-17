/**
 * Shared jsdom harness for the kanban client bundle.
 *
 * The bundle is a plain `window.__ModuleLoader__.load({...})` script, so it is evaluated through a
 * stub loader — the same path the browser takes — rather than imported. The panel then goes through
 * the **real** transport and the **real** store against a **fake `fetch`**, so a DOM test exercises
 * the whole client half: URL construction, JSON handling, the optimistic write, the rollback, and
 * the render. Only the network is fake.
 *
 * Two deliberate inheritances from the harness this was adapted from:
 *
 * - **One shared realm.** A JSDOM document plus a VM context is megabytes of native state; a realm
 *   per test left V8 with gigabytes of off-heap garbage after the tests had finished. The bundle is
 *   realm-scoped anyway, so the module is evaluated once and each test gets a fresh container.
 * - **A context that throws on undeclared property reads**, exactly like Cordis does. That mirror
 *   is what caught `cannot get property "tools" without inject` on the host half; the browser half
 *   gets the same treatment so a stray `ctx.sessions` fails here rather than in the product.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';

const CLIENT_PATH = fileURLToPath(new URL('../lib/v1/client.js', import.meta.url));
const SOURCE = readFileSync(CLIENT_PATH, 'utf8');

/** One request the bundle made, as the fake recorded it. */
export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/** What the fake `fetch` answers with. */
export interface FakeReply {
  readonly status: number;
  readonly body?: unknown;
}

export type FetchHandler = (call: RecordedCall) => FakeReply;

let handler: FetchHandler = () => ({ status: 200, body: { ok: true, board: null, rev: 0 } });
const calls: RecordedCall[] = [];

/** Install the replies for the next requests, and clear the recorded calls. */
export function setFetch(next: FetchHandler): void {
  handler = next;
  calls.length = 0;
}

/** Every request the bundle has made since the last `setFetch`. */
export function recorded(): readonly RecordedCall[] {
  return calls;
}

/** The last mutation the panel sent, or undefined. */
export function lastMutation(): RecordedCall | undefined {
  return [...calls].reverse().find((call) => call.url.includes('/mutate'));
}

export interface Registration {
  spec: { name: string; id?: string; key?: string; order?: number; label?: string | (() => string); inject?: unknown };
  component: React.ComponentType<Record<string, unknown>>;
}

export interface LoadedBundle {
  dom: JSDOM;
  inject: unknown;
  registrations: Registration[];
  plugin: {
    inject?: unknown;
    apply(ctx: unknown): void;
    store?: unknown;
    createStore?: () => unknown;
  };
  slot(name: string): Registration;
}

/**
 * A store of its own for one mount.
 *
 * The bundle is evaluated once per realm, so its own store is a singleton; a DOM test that used it
 * would inherit the previous test's board, filter and selection. The panel takes its store from
 * props, so passing a fresh one is all the isolation a test needs.
 */
export function freshStore(loaded: LoadedBundle): unknown {
  if (typeof loaded.plugin.createStore !== 'function') throw new Error('the bundle exports no createStore');
  return loaded.plugin.createStore();
}

export function clientContext(registrations: Registration[]): unknown {
  const slotsService = {
    inject(_dependency: string, callback: () => void) {
      callback();
      return () => {};
    },
    register(spec: Registration['spec'], component: Registration['component']) {
      registrations.push({ spec, component });
      return () => {};
    },
  };
  const target: Record<string, unknown> = { slots: slotsService, get: () => undefined };
  return new Proxy(target, {
    get(object, property) {
      if (property in object || typeof property === 'symbol') return Reflect.get(object, property);
      throw new Error(`cannot get property "${String(property)}" without declaring it (use ctx.get)`);
    },
  });
}

let shared: LoadedBundle | null = null;

/** Evaluate the bundle once, against a shared DOM whose `fetch` delegates to `setFetch`. */
export function loadBundle(): LoadedBundle {
  if (shared !== null) return shared;

  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' });
  const realm = dom.window as unknown as Window & typeof globalThis;
  globalThis.window = realm;
  globalThis.document = realm.document;

  const registrations: Registration[] = [];
  const SENTINEL = Symbol('not-applied');
  let applied: unknown = SENTINEL;
  let inject: unknown = null;
  let plugin: LoadedBundle['plugin'] | null = null;

  const fakeFetch = async (url: string, init?: { method?: string; body?: string }): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    const call: RecordedCall = { url, method: init?.method ?? 'GET', body };
    calls.push(call);
    const reply = handler(call);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => JSON.stringify(reply.body ?? {}),
    };
  };

  const sandbox: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    Intl,
    Date,
    Math,
    JSON,
    Promise,
    console,
    URL,
    fetch: fakeFetch,
    setTimeout: dom.window.setTimeout.bind(dom.window),
    clearTimeout: dom.window.clearTimeout.bind(dom.window),
    setInterval: dom.window.setInterval.bind(dom.window),
    clearInterval: dom.window.clearInterval.bind(dom.window),
  };
  sandbox.globalThis = sandbox;

  dom.window.__ModuleLoader__ = {
    load({ id, factory }: { id: string; factory: (require: (specifier: string) => unknown) => LoadedBundle['plugin'] }) {
      assert.equal(id, 'dsh-kanban', 'the bundle id must equal the package name');
      plugin = factory((specifier) => {
        if (specifier === 'react') return React;
        if (specifier === 'react-dom') return ReactDOM;
        throw new Error(`unexpected require("${specifier}")`);
      });
      assert.equal(String(plugin.inject), 'slots', 'the client half injects only slots');
      inject = plugin.inject;
      applied = plugin.apply(clientContext(registrations));
    },
  };

  runInContext(SOURCE, createContext(sandbox));
  assert.notStrictEqual(applied, SENTINEL, 'the bundle should have loaded');

  const loaded: LoadedBundle = {
    dom,
    inject,
    registrations,
    plugin: plugin as unknown as LoadedBundle['plugin'],
    slot(name: string): Registration {
      const found = registrations.filter((entry) => entry.spec.name === name);
      assert.equal(found.length, 1, `expected exactly one ${name} registration, got ${found.length}`);
      return found[0] as Registration;
    },
  };
  shared = loaded;
  return loaded;
}

export interface MountedView {
  readonly container: HTMLElement;
  rerender(next: Record<string, unknown>): void;
  unmount(): void;
  find(selector: string): Element | null;
  findAll(selector: string): Element[];
  text(): string;
  click(selector: string): Promise<void>;
  /** Move the document's focus to a node, the way `Tab` would. */
  focus(selector: string): Promise<void>;
  /** Fire a React-recognised key event. */
  key(selector: string, key: string, options?: { altKey?: boolean }): Promise<void>;
  /** Fire the three drag events a drop is built from. */
  drag(fromSelector: string, toSelector: string, clientY?: number): Promise<void>;
  /** Fire only the `dragstart`, so a case can inspect the board while a drag is live. */
  dragStart(selector: string): Promise<void>;
  /** Fire one `dragover` on its own, so a case can count the work a repeated event does. */
  dragOver(selector: string, clientY?: number): Promise<void>;
  type(selector: string, value: string): Promise<void>;
  /** True when the node exists — never hand a DOM node to an assertion. */
  has(selector: string): boolean;
  /**
   * True when the document's focus is on the node the selector names.
   *
   * The comparison is made here and only the boolean crosses back, for the same reason `has` exists:
   * an assertion handed a DOM node makes the runner inspect it, which once walked React's fibers and
   * allocated gigabytes. False is also returned when the selector matches nothing, so a case about
   * focus cannot pass because the node vanished.
   */
  isFocused(selector: string): boolean;
}

declare global {
  /** React's `act()` opt-in flag; @types/react 18 does not declare it. */
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Let pending promises settle inside `act`.
 *
 * The panel fetches on mount, so every assertion about its content has to happen after the fake
 * `fetch` has resolved and React has re-rendered. A macrotask boundary is the reliable point: a
 * microtask flush can return before React has processed the update it scheduled.
 */
export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export function mount(loaded: LoadedBundle, registration: Registration, props: Record<string, unknown>): MountedView {
  const container = loaded.dom.window.document.createElement('div');
  loaded.dom.window.document.body.appendChild(container);
  const root: Root = createRoot(container);
  /**
   * A slot owner calls the registration's `inject` and passes the result as the component's props —
   * that is how the panel receives its store and its React handle. The harness must do the same, or
   * it is testing a mount the app never performs.
   */
  const injected = typeof registration.spec.inject === 'function' ? (registration.spec.inject as () => Record<string, unknown>)() : {};
  const render = (next: Record<string, unknown>): void => {
    root.render(React.createElement(registration.component, { ...injected, ...next }));
  };
  act(() => {
    render(props);
  });

  const nativeEvent = (type: string, extra: Record<string, unknown>): Event => {
    const event = new loaded.dom.window.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(extra)) {
      Object.defineProperty(event, key, { value, configurable: true });
    }
    return event;
  };

  return {
    container,
    rerender(next) {
      act(() => {
        render(next);
      });
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
    find: (selector) => container.querySelector(selector),
    findAll: (selector) => [...container.querySelectorAll(selector)],
    // Typed as a string because that is all any caller does with it.
    text: () => container.textContent as string,
    has: (selector) => container.querySelector(selector) !== null,
    isFocused: (selector) => {
      const node = container.querySelector(selector);
      return node !== null && container.ownerDocument.activeElement === node;
    },

    async click(selector) {
      const node = container.querySelector(selector);
      // Never pass a DOM node to an assertion: a failure makes the runner inspect it, which walks
      // React's fibers and jsdom's getters and can allocate gigabytes.
      assert.ok(node !== null, `expected ${selector} to exist`);
      await act(async () => {
        node.dispatchEvent(new loaded.dom.window.MouseEvent('click', { bubbles: true }));
      });
    },

    async key(selector, key, options = {}) {
      const node = container.querySelector(selector);
      assert.ok(node !== null, `expected ${selector} to exist`);
      await act(async () => {
        node.dispatchEvent(nativeEvent('keydown', { key, altKey: options.altKey === true }));
      });
    },

    async focus(selector) {
      const node = container.querySelector(selector);
      assert.ok(node !== null, `expected ${selector} to exist`);
      // The jsdom realm's own constructor, not a Node global: `HTMLElement` is not defined here.
      const DomElement = (container.ownerDocument.defaultView as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement;
      if (!(node instanceof DomElement)) {
        assert.fail(`expected ${selector} to be an element that can hold focus`);
      }
      await act(async () => {
        // A dispatched `click` does not move focus in jsdom, the way it does in a browser, so a
        // case about focus has to place it explicitly.
        node.focus();
      });
    },

    async drag(fromSelector, toSelector, clientY = 10) {
      const from = container.querySelector(fromSelector);
      const to = container.querySelector(toSelector);
      assert.ok(from !== null, `expected ${fromSelector} to exist`);
      assert.ok(to !== null, `expected ${toSelector} to exist`);
      const dataTransfer = { setData: () => {}, effectAllowed: '' };
      await act(async () => {
        from.dispatchEvent(nativeEvent('dragstart', { dataTransfer }));
      });
      await act(async () => {
        to.dispatchEvent(nativeEvent('dragover', { clientY, dataTransfer }));
      });
      await act(async () => {
        to.dispatchEvent(nativeEvent('drop', { clientY, dataTransfer }));
      });
    },

    async dragStart(selector) {
      const from = container.querySelector(selector);
      assert.ok(from !== null, `expected ${selector} to exist`);
      const dataTransfer = { setData: () => {}, effectAllowed: '' };
      await act(async () => {
        from.dispatchEvent(nativeEvent('dragstart', { dataTransfer }));
      });
    },

    async dragOver(selector, clientY = 10) {
      const to = container.querySelector(selector);
      assert.ok(to !== null, `expected ${selector} to exist`);
      const dataTransfer = { setData: () => {}, effectAllowed: '' };
      await act(async () => {
        to.dispatchEvent(nativeEvent('dragover', { clientY, dataTransfer }));
      });
    },

    async type(selector, value) {
      const node = container.querySelector(selector);
      assert.ok(node !== null, `expected ${selector} to exist`);
      await act(async () => {
        // `Simulate.change`, not a hand-dispatched `input` event: React's value tracker ignores a
        // programmatic assignment followed by a synthetic event, so the handler would never run and
        // the test would assert against the value it had just written itself.
        Simulate.change(node, { target: { value } } as unknown as Parameters<typeof Simulate.change>[1]);
      });
    },
  };
}

/** A board payload shaped exactly like the host's, for the DOM tests. */
export function boardPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const task = (id: string, state: string, position: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    title: `card ${id}`,
    outcome: null,
    description: null,
    acceptance: null,
    state,
    priority: 'p2-normal',
    classOfService: 'standard',
    blockedReason: null,
    droppedReason: null,
    assignee: null,
    project: null,
    workspace: null,
    sprintId: null,
    estimate: null,
    due: null,
    tags: [],
    links: [],
    writeScopes: [],
    folder: null,
    parentId: null,
    position,
    rev: 1,
    dor: {},
    dod: {},
    exceptions: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    createdBy: 'human:dhira',
    updatedBy: 'human:dhira',
    ...extra,
  });

  return {
    rev: 7,
    title: 'Board',
    dow: {
      wip: { 'in-progress': 2, review: 1 },
      readyCap: 5,
      sle: { p: 0.85, days: 3, source: 'guess' },
      policies: { backlog: 'p', ready: 'p', 'in-progress': 'p', review: 'p', done: 'p', dropped: 'p' },
      dor: ['outcome', 'acceptance', 'write-scope', 'estimate'],
      dod: ['evidence', 'tests-or-na', 'docs-or-lesson', 'links-resolve', 'no-unverified-claims'],
    },
    tasks: [
      task('T-001', 'backlog', 0),
      task('T-002', 'ready', 0),
      task('T-003', 'in-progress', 0, { startedAt: '2026-10-14T00:00:00.000Z' }),
      task('T-004', 'in-progress', 1, { classOfService: 'expedite', priority: 'p0-critical' }),
      task('T-005', 'done', 0, { finishedAt: '2026-10-15T00:00:00.000Z', startedAt: '2026-10-12T00:00:00.000Z' }),
    ],
    metrics: {
      generatedAt: '2026-10-15T12:00:00.000Z',
      boardRev: 7,
      wip: 2,
      wipByState: { 'in-progress': 2, review: 0 },
      countsByState: { backlog: 1, ready: 1, 'in-progress': 2, review: 0, done: 1, dropped: 0 },
      throughput: { days7: 1, days30: 1 },
      ages: [{ id: 'T-003', title: 'card T-003', state: 'in-progress', days: 1.5, overSle: false }],
      cycle: { count: 1, medianDays: 3, p85Days: 3, meanDays: 3, minDays: 3, maxDays: 3 },
      sle: { p: 0.85, days: 3, source: 'guess', basis: 1 },
      ageing: { count: 0, oldestDays: 1.5 },
    },
    counts: { backlog: 1, ready: 1, 'in-progress': 2, review: 0, done: 1, dropped: 0 },
    views: [],
    templates: [],
    sprints: [],
    invalid: [],
    truncated: null,
    total: 5,
    servedAt: '2026-10-15T12:00:00.000Z',
    buildId: 'dsh-kanban/0.1.0+test',
    ...overrides,
  };
}

/** A board reply for the initial GET, and permissive answers for everything else. */
export function respondWithBoard(payload: Record<string, unknown> = boardPayload()): void {
  setFetch((call) => {
    if (call.url.includes('/board')) return { status: 200, body: { ok: true, board: payload, rev: payload.rev } };
    if (call.url.includes('/mutate')) return { status: 200, body: { ok: true, rev: Number(payload.rev) + 1, result: {} } };
    if (call.url.includes('/task/')) return { status: 200, body: { ok: true, task: null, comments: [], events: [] } };
    return { status: 404, body: { ok: false, code: 'not-found', message: 'no route' } };
  });
}
