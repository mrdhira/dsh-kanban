/**
 * The host half, driven against a fake Cordis context.
 *
 * This is the test that would have caught the bug that cost the most: the first live load
 * registered the route, opened the board, imported thirteen rows — and failed **every** tool and
 * the skill with `cannot get property "tools" without inject`, while reporting `status: ok`. The
 * service read as a property must be declared in `inject`; `ctx.get()` is not gated.
 *
 * So the fake context is a **proxy that throws on an undeclared property read**, exactly as Cordis
 * does, and the assertions are about what actually landed on the registries: nine tools by name, the
 * skill, the route, and a probe record that says `ok`. Waiting for an app restart to find out is not
 * verification; this is.
 *
 * The second half of the file drives the registered route handler directly, with fake
 * request/response objects — so the read path, the `since` cursor, the actor header and the refusal
 * codes are all pinned without a browser.
 *
 * Every test points `DSH_HOME` at a temporary directory, so nothing here can touch the real board,
 * the real `todo.md`, or the real probe record.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, inject, name } from '../lib/v1/host/index.js';
import { TOOL_NAMES } from '../lib/v1/host/tools.js';
import { API_PREFIX, isAllowedOrigin } from '../lib/v1/host/api.js';
import { reloadPlugin } from '../lib/v1/host/reload.js';
import type { DshHostContext, DshIncomingMessage, DshServerResponse, DshToolDefinition, DshWebRoute } from '../lib/v1/types/dsh.js';

/** What the plugin declares it cannot work without. Kept here so a test cannot quietly drop one. */
const INJECTED = ['tools', 'skills', 'webServer'];

interface FakeHost {
  readonly ctx: unknown;
  readonly tools: DshToolDefinition[];
  readonly skills: Record<string, unknown>[];
  readonly routes: DshWebRoute[];
  readonly effects: string[];
  readonly indexTaps: ((html: string) => string)[];
  /** Property names the plugin read that were not declared, as Cordis would refuse them. */
  readonly refused: string[];
}

/**
 * The restricted host context.
 *
 * Three behaviours are modelled, and each one cost a live failure:
 *
 * - a **property** read works only for the names in `declared`, and otherwise throws the way Cordis
 *   does (`cannot get property "tools" without inject` — the first live failure);
 * - `get()` answers for anything **except** a service in `pending`, which stands for one the
 *   composition mounts *after* this plugin. A lookup for such a service answers `undefined` — the
 *   second live failure, where the route silently never registered;
 * - declaring a service makes it a property regardless of `pending`, because that is what `inject`
 *   buys: Cordis waits for it.
 */
function fakeHost(
  declared: readonly string[],
  services: Record<string, unknown>,
  options: { readonly pending?: readonly string[] } = {}
): FakeHost {
  const tools: DshToolDefinition[] = [];
  const skills: Record<string, unknown>[] = [];
  const routes: DshWebRoute[] = [];
  const effects: string[] = [];
  const indexTaps: ((html: string) => string)[] = [];
  const refused: string[] = [];
  const pending = options.pending ?? [];

  const registry: Record<string, unknown> = {
    tools: { register: (definition: DshToolDefinition) => (tools.push(definition), () => {}) },
    skills: { register: (skill: Record<string, unknown>) => (skills.push(skill), () => {}) },
    webServer: {
      register: (route: DshWebRoute) => (routes.push(route), () => {}),
      tapIndex: (transform: (html: string) => string) => (indexTaps.push(transform), () => {}),
    },
    timer: {}, fs: {}, storageDomain: {}, sessionProjections: {},
    ...services,
  };

  const target: Record<string, unknown> = {
    get: (serviceName: string) => (pending.includes(serviceName) ? undefined : registry[serviceName]),
    effect: (callback: () => unknown, label?: string) => {
      effects.push(label ?? '(unlabelled)');
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
  };
  for (const serviceName of declared) target[serviceName] = registry[serviceName];

  const ctx = new Proxy(target, {
    get(object, property) {
      if (property in object || typeof property === 'symbol') return Reflect.get(object, property);
      refused.push(String(property));
      throw new Error(`cannot get property "${String(property)}" without inject`);
    },
  });

  return { ctx, tools, skills, routes, effects, indexTaps, refused };
}

/** A sandbox home, and the environment variable put back afterwards. */
function sandbox(): { home: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'kanban-host-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  return {
    home,
    restore: () => {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * Boot the host half and wait for **its own** record.
 *
 * `apply()` starts an async import, and `writeProbe` recomputes its path from `DSH_HOME` on every
 * call — correct for the app, where there is one plugin instance and one home, and a trap for a
 * suite that boots many hosts in one process. A straggling `start()` from a *previous* test writes
 * its final record into the *current* test's home, so a naive "wait for a finished record" returns
 * that one: the board path then names the previous test's directory and every later assertion fails
 * for a reason that has nothing to do with the code under test. That is exactly what happened here,
 * and it cost more than the bug it was hiding.
 *
 * So each boot pins its own database path and waits for a record that names it. The general lesson
 * is worth keeping: when a shared resource resolves its location at write time, "wait until it says
 * done" is ambiguous — wait for the one that is yours.
 */
async function boot(host: FakeHost, home: string, config: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const dbPath = typeof config.dbPath === 'string' ? config.dbPath : join(home, 'tasks', 'board.db');
  const probe = join(home, 'logs', 'kanban', 'probe.json');
  apply(host.ctx as DshHostContext, { ...config, dbPath });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (existsSync(probe)) {
      const record = JSON.parse(readFileSync(probe, 'utf8')) as Record<string, unknown>;
      const board = record.board as { path?: string } | undefined;
      if (record.status !== 'starting' && board?.path === dbPath) return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the host half never finished booting for ${dbPath}`);
}

// ------------------------------------------------------------------ identity and injection

test('the plugin declares the three services it needs, and both reasons are represented', () => {
  assert.equal(name, 'kanban');
  // Two services it *calls* as properties, and one it must *wait* for: the composition mounts the
  // web server after this plugin, so a lookup for it answered undefined and the route never
  // registered on a fresh start. Both reasons live in one list.
  assert.deepEqual([...inject], ['tools', 'skills', 'webServer']);
});

test('refused: reading an undeclared service as a property throws, which is why inject is declared', () => {
  const { ctx } = fakeHost([], {});
  assert.throws(() => (ctx as Record<string, unknown>).tools, /without inject/);
});

// ------------------------------------------------------------------ what actually registers

test('the host half registers exactly the nine documented tools', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    assert.deepEqual(
      host.tools.map((tool) => tool.name).sort(),
      [...TOOL_NAMES].sort()
    );
    assert.equal(host.refused.length, 0, `the plugin read undeclared services: ${host.refused.join(', ')}`);
  } finally {
    box.restore();
  }
});

test('the host half registers the kanban skill with the rules in its body', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    assert.equal(host.skills.length, 1);
    const skill = host.skills[0] as { name: string; description: string; content: string; whenToUse?: string };
    assert.equal(skill.name, 'kanban');
    assert.match(skill.content, /Definition of Ready/);
    assert.match(skill.content, /in-progress` holds 2/);
    assert.match(skill.content, /never through a tool|never edit that file/);
  } finally {
    box.restore();
  }
});

test('the host half registers the route as a prefix under /api/kanban, and disposes it through an effect', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    assert.equal(host.routes.length, 1);
    assert.equal(host.routes[0]?.kind, 'prefix');
    assert.equal(host.routes[0]?.path, API_PREFIX);
    assert.equal(host.effects.some((label) => label.includes('/api/kanban')), true);
  } finally {
    box.restore();
  }
});

test('the probe record says what was found, including the runtime and sqlite', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    const record = await boot(host, box.home);
    assert.equal(record.status, 'ok');
    assert.equal(record.plugin, 'dsh-kanban');
    assert.equal(record.node, process.versions.node);
    assert.equal((record.sqlite as { available: boolean }).available, true);
    assert.equal((record.tools as string[]).length, 9);
    assert.equal(record.skill, 'kanban');
    assert.equal((record.route as { registered: boolean }).registered, true);
    const board = record.board as { opened: boolean; path: string };
    assert.equal(board.opened, true);
    assert.match(board.path, /board\.db$/);
  } finally {
    box.restore();
  }
});

test('the route registers even when the web server mounts after apply', async () => {
  const box = sandbox();
  try {
    // The composition mounts the web server *after* this plugin, so `ctx.get('webServer')` answers
    // `undefined` — exactly how the route silently failed to register on a fresh start while
    // working perfectly on a hot-added load where everything was already mounted. Declaring it in
    // `inject` makes Cordis wait, so the property is there whatever the composition order.
    const host = fakeHost(INJECTED, {}, { pending: ['webServer'] });
    const record = await boot(host, box.home);

    assert.equal((record.route as { registered: boolean }).registered, true, 'injected, so Cordis waited');
    assert.equal(host.tools.length, 9);
    const services = record.services as { injected: string[]; visible: Record<string, boolean> };
    assert.equal(services.injected.includes('webServer'), true);
    assert.equal(
      services.visible.webServer,
      undefined,
      'and ctx.get could not see it — precisely why a lookup was the wrong mechanism'
    );
    assert.equal(record.status, 'ok');
  } finally {
    box.restore();
  }
});

test('a bad config is reported as warnings, and the board still opens at its default path', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    const record = await boot(host, box.home, { pollMs: 'soon', mirror: 'yes' });
    assert.equal(record.status, 'ok');
    const warnings = record.warnings as string[];
    assert.equal(warnings.some((warning) => warning.startsWith('pollMs')), true);
    assert.equal(warnings.some((warning) => warning.startsWith('mirror')), true);
    assert.equal((record.board as { opened: boolean }).opened, true);
  } finally {
    box.restore();
  }
});

test('the import runs once, when the board is empty, and is recorded as a warning', async () => {
  const box = sandbox();
  try {
    // A pre-Kanban board sits where the generated view goes.
    mkdirSync(join(box.home, 'tasks'), { recursive: true });
    writeFileSync(
      join(box.home, 'tasks', 'todo.md'),
      '| ID | Task | State | Owner | Write scope | Acceptance | Links |\n|---|---|---|---|---|---|---|\n| T-001 | an old row | done | lead | `~/.dsh/**` | it worked | [req](T-001-old/requirements.md) |\n'
    );
    const host = fakeHost(INJECTED, {});
    const record = await boot(host, box.home);
    assert.equal((record.warnings as string[]).some((warning) => warning.includes('imported 1 row')), true);
    assert.equal((record.board as { tasks: number }).tasks, 1);

    // A second boot **of the same home** must not import again: the rows are already there.
    const again = fakeHost(INJECTED, {});
    const second = await boot(again, box.home);
    assert.equal((second.board as { tasks: number }).tasks, 1);
    assert.equal((second.warnings as string[]).some((warning) => warning.includes('imported')), false);
  } finally {
    box.restore();
  }
});

test('a config path is honoured, so a test never has to touch the real board', async () => {
  const box = sandbox();
  try {
    const custom = join(box.home, 'custom', 'mine.db');
    const host = fakeHost(INJECTED, {});
    const record = await boot(host, box.home, { dbPath: custom });
    assert.equal((record.board as { path: string }).path, custom);
    assert.equal(existsSync(custom), true);
  } finally {
    box.restore();
  }
});

// ------------------------------------------------------------------ the route handler

interface FakeCall {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string>;
}

/** A request whose body is delivered on the next microtask, as `node:http` delivers one. */
function fakeRequest(method: string, url: string, body = '', headers: Record<string, string> = {}): DshIncomingMessage {
  const listeners: Record<string, (chunk?: Uint8Array) => void> = {};
  const request = {
    method,
    url,
    headers,
    on(event: string, listener: (chunk?: Uint8Array) => void): unknown {
      listeners[event] = listener;
      if (event === 'end') {
        queueMicrotask(() => {
          if (body.length > 0) listeners.data?.(Buffer.from(body));
          listeners.end?.();
        });
      }
      return request;
    },
  };
  return request;
}

function fakeResponse(sink: FakeCall[]): DshServerResponse {
  let status = 0;
  let headers: Record<string, string> = {};
  return {
    writeHead(next: number, nextHeaders?: Record<string, string>): unknown {
      status = next;
      headers = nextHeaders ?? {};
      return undefined;
    },
    end(body?: string): unknown {
      sink.push({ status, body: body ?? '', headers });
      return undefined;
    },
  };
}

async function callRoute(route: DshWebRoute, method: string, url: string, body?: string, headers?: Record<string, string>): Promise<FakeCall> {
  const sink: FakeCall[] = [];
  await route.handler(fakeRequest(method, url, body, headers), fakeResponse(sink));
  const call = sink[0];
  assert.ok(call !== undefined, 'the handler never answered');
  return call;
}

test('GET /health answers without a token', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;
    const call = await callRoute(route, 'GET', `${API_PREFIX}/health`);
    assert.equal(call.status, 200);
    const payload = JSON.parse(call.body) as { ok: boolean; plugin: string; node: string; board: { rev: number } };
    assert.equal(payload.ok, true);
    assert.equal(payload.plugin, 'dsh-kanban');
    assert.equal(payload.node, process.versions.node);
    assert.equal(typeof payload.board.rev, 'number');
  } finally {
    box.restore();
  }
});

test('GET /board answers with the Definition of Workflow, then 304s on the same revision', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;

    const first = await callRoute(route, 'GET', `${API_PREFIX}/board`);
    assert.equal(first.status, 200);
    const payload = JSON.parse(first.body) as {
      board: { rev: number; dow: { wip: Record<string, number> }; tasks: unknown[]; metrics: { sle: { source: string } } };
      rev: number;
    };
    assert.equal(payload.board.dow.wip['in-progress'], 2);
    assert.equal(payload.board.dow.wip.review, 1);
    assert.equal(payload.board.metrics.sle.source, 'guess');

    const second = await callRoute(route, 'GET', `${API_PREFIX}/board?since=${String(payload.rev)}`);
    assert.equal(second.status, 304);
    assert.equal(second.body, '');
  } finally {
    box.restore();
  }
});

test('POST /mutate creates a card, and the board reflects it', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;

    const created = await callRoute(
      route,
      'POST',
      `${API_PREFIX}/mutate`,
      JSON.stringify({ op: 'create', input: { title: 'over HTTP' } }),
      { 'content-type': 'application/json', 'x-kanban-actor': 'human' }
    );
    assert.equal(created.status, 200);
    const result = JSON.parse(created.body) as { ok: boolean; result: { id: string; createdBy: string } };
    assert.equal(result.ok, true);
    assert.equal(result.result.id, 'T-001');
    assert.equal(result.result.createdBy, 'human:dhira');

    const board = JSON.parse((await callRoute(route, 'GET', `${API_PREFIX}/board`)).body) as { board: { tasks: { id: string }[] } };
    assert.deepEqual(
      board.board.tasks.map((task) => task.id),
      ['T-001']
    );
  } finally {
    box.restore();
  }
});

test('POST /mutate carries a refusal back as 422 with the missing checks', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;
    await callRoute(route, 'POST', `${API_PREFIX}/mutate`, JSON.stringify({ op: 'create', input: { title: 'a card' } }), {
      'x-kanban-actor': 'human',
    });

    const refused = await callRoute(
      route,
      'POST',
      `${API_PREFIX}/mutate`,
      JSON.stringify({ op: 'move', id: 'T-001', toState: 'ready' }),
      { 'x-kanban-actor': 'agent:sess-9' }
    );
    assert.equal(refused.status, 422);
    const payload = JSON.parse(refused.body) as { ok: boolean; code: string; missing: string[] };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'dor-incomplete');
    assert.deepEqual(payload.missing, ['outcome', 'acceptance', 'write-scope', 'estimate']);
  } finally {
    box.restore();
  }
});

test('POST /mutate without an actor header is treated as the human, and an agent header is not', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;

    // No header: the panel is the human's surface.
    const asHuman = JSON.parse(
      (await callRoute(route, 'POST', `${API_PREFIX}/mutate`, JSON.stringify({ op: 'create', input: { title: 'a' } }))).body
    ) as { result: { createdBy: string } };
    assert.equal(asHuman.result.createdBy, 'human:dhira');

    // An agent header that tries to set a priority is refused.
    const refused = await callRoute(
      route,
      'POST',
      `${API_PREFIX}/mutate`,
      JSON.stringify({ op: 'update', id: 'T-001', patch: { priority: 'p0-critical' } }),
      { 'x-kanban-actor': 'agent:sess-9' }
    );
    assert.equal(refused.status, 422);
    assert.equal((JSON.parse(refused.body) as { code: string }).code, 'human-only');
  } finally {
    box.restore();
  }
});

test('the route answers 404 for an unknown path, 404 for an unknown card, and 400 for bad JSON', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;

    assert.equal((await callRoute(route, 'GET', `${API_PREFIX}/wibble`)).status, 404);
    assert.equal((await callRoute(route, 'GET', `${API_PREFIX}/task/T-404`)).status, 404);
    assert.equal((await callRoute(route, 'POST', `${API_PREFIX}/mutate`, '{ not json')).status, 400);
    assert.equal((await callRoute(route, 'POST', `${API_PREFIX}/mutate`, '{}')).status, 400);
    assert.equal((await callRoute(route, 'POST', `${API_PREFIX}/mutate`, JSON.stringify({ op: 'wibble' }))).status, 400);
  } finally {
    box.restore();
  }
});

test('GET /export answers Markdown with the generator banner', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;
    const call = await callRoute(route, 'GET', `${API_PREFIX}/export`);
    assert.equal(call.status, 200);
    assert.match(call.headers['content-type'] ?? '', /markdown/);
    assert.match(call.body, /generated by dsh-kanban/);
  } finally {
    box.restore();
  }
});

test('a board mutation refreshes the generated view on disk', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    const record = await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;
    const view = join(box.home, 'tasks', 'todo.md');

    const written = await callRoute(route, 'POST', `${API_PREFIX}/mutate`, JSON.stringify({ op: 'create', input: { title: 'a card' } }));
    // The mirror is debounced, so give it its window. The diagnostic names what actually happened
    // when it does not arrive: a silently missing view is the failure mode this test exists for.
    for (let attempt = 0; attempt < 150 && !existsSync(view); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      existsSync(view),
      true,
      `no generated view at ${view} after a ${written.status} write; the probe says the board is at ${
        (record.board as { path: string }).path
      } and the home holds ${JSON.stringify(listing(box.home))}`
    );
    assert.match(readFileSync(view, 'utf8'), /a card/);
  } finally {
    box.restore();
  }
});

/** What a directory holds, for a failure message that does not need a second run to diagnose. */
function listing(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return ['(unreadable)'];
  }
}

// ------------------------------------------------------------------ the two gated operations

const DOW = {
  wip: { 'in-progress': 2, review: 1 },
  readyCap: 5,
  sle: { p: 0.85, days: 3, source: 'guess' },
  policies: { backlog: 'b', ready: 'r', 'in-progress': 'i', review: 'v', done: 'd', dropped: 'x' },
  dor: ['outcome', 'acceptance', 'write-scope', 'estimate'],
  dod: ['evidence', 'tests-or-na', 'docs-or-lesson', 'links-resolve', 'no-unverified-claims'],
};

test('refused (422): an agent may not rewrite the Definition of Workflow', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;

    // The DoW *is* the control: unauthenticated, this could set an unbounded WIP limit.
    const refused = await callRoute(
      route,
      'POST',
      `${API_PREFIX}/mutate`,
      JSON.stringify({ op: 'set-dow', dow: { ...DOW, wip: { 'in-progress': 'x', review: 1 } } }),
      { 'x-kanban-actor': 'agent:sess-9' }
    );
    assert.equal(refused.status, 422);
    assert.equal((JSON.parse(refused.body) as { code: string }).code, 'human-only');

    const board = JSON.parse((await callRoute(route, 'GET', `${API_PREFIX}/board`)).body) as {
      board: { dow: { wip: Record<string, number> } };
    };
    assert.equal(board.board.dow.wip['in-progress'], 2, 'the stored definition is untouched');
  } finally {
    box.restore();
  }
});

test('refused (400): the human may not store a Definition of Workflow that is not one', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;
    const post = (dow: unknown) =>
      callRoute(route, 'POST', `${API_PREFIX}/mutate`, JSON.stringify({ op: 'set-dow', dow }), { 'x-kanban-actor': 'human' });

    assert.equal((await post({ ...DOW, wip: { 'in-progress': 'x', review: 1 } })).status, 400);
    assert.equal((await post({ ...DOW, dor: null })).status, 400);
    assert.equal((await post({ ...DOW, dor: [] })).status, 400);
    assert.equal((await post('wibble')).status, 400);
  } finally {
    box.restore();
  }
});

test('the human may tighten a WIP limit, and the fields not mentioned survive', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;

    const applied = await callRoute(
      route,
      'POST',
      `${API_PREFIX}/mutate`,
      JSON.stringify({ op: 'set-dow', dow: { wip: { 'in-progress': 1, review: 1 } } }),
      { 'x-kanban-actor': 'human' }
    );
    assert.equal(applied.status, 200);
    const payload = JSON.parse(applied.body) as { result: { wip: Record<string, number>; dor: string[] } };
    assert.equal(payload.result.wip['in-progress'], 1);
    assert.deepEqual(payload.result.dor, DOW.dor);
  } finally {
    box.restore();
  }
});

test('refused (422): an agent may not import a pre-Kanban board', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;

    // `import-todo` writes rows that deliberately bypass every gate, so it is a migration tool.
    const refused = await callRoute(
      route,
      'POST',
      `${API_PREFIX}/mutate`,
      JSON.stringify({ op: 'import-todo', text: '| T-500 | a smuggled row | done | — | — | — | — |' }),
      { 'x-kanban-actor': 'agent:sess-9' }
    );
    assert.equal(refused.status, 422);
    assert.equal((JSON.parse(refused.body) as { code: string }).code, 'human-only');

    const listed = JSON.parse((await callRoute(route, 'GET', `${API_PREFIX}/board`)).body) as { board: { tasks: unknown[] } };
    assert.equal(listed.board.tasks.length, 0, 'nothing was smuggled in');
  } finally {
    box.restore();
  }
});

// ------------------------------------------------------------------ CORS and the preflight

test('a browser preflight from the local GUI is answered, because it is sent before a plain GET', async () => {
  // The panel sends `x-kanban-actor` and a JSON content type, so the browser sends OPTIONS first —
  // even for a GET. This route answered that with its own `404 no route for OPTIONS /board`, the
  // preflight failed, and the panel reported `Failed to fetch` while `curl` to the same URL returned
  // 200. A working server and an unreachable one, decided by whether a browser was asking.
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;

    const call = await callRoute(route, 'OPTIONS', `${API_PREFIX}/board`, undefined, {
      origin: 'http://127.0.0.1:19387',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-kanban-actor',
    });
    assert.equal(call.status, 204);
    assert.equal(call.headers['access-control-allow-origin'], 'http://127.0.0.1:19387');
    assert.match(call.headers['access-control-allow-methods'] ?? '', /GET/);
    assert.match(call.headers['access-control-allow-headers'] ?? '', /x-kanban-actor/);
    assert.equal(call.headers['vary'], 'Origin', 'the answer depends on the request origin');
    assert.equal(call.body, '');
  } finally {
    box.restore();
  }
});

test('a foreign page gets no CORS grant — the route is unauthenticated, so this is the whole fence', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;

    // The plugin prefix route sits outside the app's auth fence (curl reaches it with no token), so
    // an unauthenticated mutate is a real cross-site write. The allowlist is loopback-only, not `*`.
    const preflight = await callRoute(route, 'OPTIONS', `${API_PREFIX}/board`, undefined, {
      origin: 'https://evil.example',
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], undefined, 'no grant, so the browser blocks it');

    const read = await callRoute(route, 'GET', `${API_PREFIX}/health`, undefined, { origin: 'https://evil.example' });
    assert.equal(read.status, 200, 'a non-browser caller is unaffected');
    assert.equal(read.headers['access-control-allow-origin'], undefined);
  } finally {
    box.restore();
  }
});

test('an ordinary read from the local GUI carries the grant', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;
    for (const origin of ['http://127.0.0.1:19387', 'http://localhost:19387', 'http://[::1]:19387']) {
      const call = await callRoute(route, 'GET', `${API_PREFIX}/health`, undefined, { origin });
      assert.equal(call.status, 200);
      assert.equal(call.headers['access-control-allow-origin'], origin, `${origin} is the app's own GUI`);
    }
  } finally {
    box.restore();
  }
});

test('the origin allowlist is loopback-only and rejects everything else', () => {
  for (const allowed of ['http://127.0.0.1:19387', 'http://localhost:19387', 'https://localhost', 'http://[::1]:19387']) {
    assert.equal(isAllowedOrigin(allowed), true, allowed);
  }
  for (const refused of [
    undefined,
    '',
    'https://evil.example',
    'https://127.0.0.1.evil.example',
    'file://',
    'null',
    'not a url',
    'http://192.168.1.5:19387',
  ]) {
    assert.equal(isAllowedOrigin(refused), false, String(refused));
  }
});

test('the desktop shell scheme is allowed, because that is where the panel actually runs', async () => {
  // The panel's document reports `dsh-app://app` — a custom Electron scheme, not http. So every
  // request it makes to this loopback route is cross-origin, and `Failed to fetch` was this allowlist
  // refusing the origin while `curl`, which sends no Origin, was served happily.
  assert.equal(isAllowedOrigin('dsh-app://app'), true);
  assert.equal(isAllowedOrigin('dsh-app://'), true, 'the scheme is the app itself whatever its host');

  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;

    const preflight = await callRoute(route, 'OPTIONS', `${API_PREFIX}/board`, undefined, {
      origin: 'dsh-app://app',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-kanban-actor',
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'dsh-app://app');

    const read = await callRoute(route, 'GET', `${API_PREFIX}/board`, undefined, { origin: 'dsh-app://app' });
    assert.equal(read.status, 200);
    assert.equal(read.headers['access-control-allow-origin'], 'dsh-app://app');
  } finally {
    box.restore();
  }
});

test('health reports the origins it has seen, so a blocked request is diagnosable from curl', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(INJECTED, {});
    await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;

    await callRoute(route, 'GET', `${API_PREFIX}/board`, undefined, { origin: 'dsh-app://app' });
    await callRoute(route, 'GET', `${API_PREFIX}/board`, undefined, { origin: 'https://evil.example' });

    const health = JSON.parse((await callRoute(route, 'GET', `${API_PREFIX}/health`)).body) as {
      recentOrigins: readonly { origin: string; allowed: boolean; method: string; path: string }[];
    };
    const app = health.recentOrigins.find((entry) => entry.origin === 'dsh-app://app');
    const evil = health.recentOrigins.find((entry) => entry.origin === 'https://evil.example');
    assert.equal(app?.allowed, true);
    assert.equal(evil?.allowed, false);
    assert.equal(evil?.path, `${API_PREFIX}/board`);
    assert.equal(health.recentOrigins.length <= 8, true, 'bounded, so it cannot grow without limit');
  } finally {
    box.restore();
  }
});

// ------------------------------------------------------------------ reload without a restart

test('reload restarts this entry through the Loader, and answers before it tears itself down', async () => {
  // Dhira's constraint: an app restart makes every other session wait its turn, so a host-half fix
  // must be applicable in place. The installed EntryTree exposes entries as a generator *method*,
  // and an Entry restarts through its fiber, not through a stop/start pair it does not have.
  const calls: string[] = [];
  const scheduled: (() => void)[] = [];
  const entry = {
    id: 'include:kanban',
    options: { id: 'kanban', name: 'dsh-kanban' },
    fiber: {
      restart: () => {
        calls.push('restart');
      },
    },
  };
  const loader = {
    *entries() {
      yield entry;
    },
  };
  const ctx = { get: (serviceName: string) => (serviceName === 'loader' ? loader : undefined) } as unknown as DshHostContext;

  const outcome = reloadPlugin(ctx, 'kanban', (work) => scheduled.push(work), 0);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.api, 'entry(include:kanban).fiber.restart()');
  assert.deepEqual(calls, [], 'nothing runs inline — the caller still has to be answered');
  for (const work of scheduled) work();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['restart'], 'and the entry is disposed and reloaded after the answer');
});

test('reload reports exactly why it could not, rather than failing silently', () => {
  const noLoader = { get: () => undefined } as unknown as DshHostContext;
  assert.equal(reloadPlugin(noLoader, 'kanban').ok, false);
  assert.match(reloadPlugin(noLoader, 'kanban').message, /no Loader/);

  const wrongEntry = { get: () => ({ entries: () => [{ options: { id: 'include:other' } }] }) } as unknown as DshHostContext;
  const outcome = reloadPlugin(wrongEntry, 'kanban');
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.entries, ['include:other'], 'and names what it did find');
  assert.match(outcome.api, /function -> array, 1 entry\(ies\)/, 'and the shape it read');

  const noMethods = { get: () => ({ entries: () => [{ options: { id: 'kanban' } }] }) } as unknown as DshHostContext;
  assert.equal(reloadPlugin(noMethods, 'kanban').ok, false);
  assert.match(reloadPlugin(noMethods, 'kanban').message, /neither a running fiber nor loader\.update/);

  const viaUpdate: string[] = [];
  const updatable = {
    get: () => ({
      entries: () => [{ options: { id: 'kanban' } }],
      update: (id: string, options?: unknown) => {
        viaUpdate.push(`${id}:${JSON.stringify(options)}`);
      },
    }),
  } as unknown as DshHostContext;
  const scheduled: (() => void)[] = [];
  const updated = reloadPlugin(updatable, 'kanban', (work) => scheduled.push(work), 0);
  assert.equal(updated.ok, true);
  assert.equal(updated.api, 'loader.update(kanban)');
  for (const work of scheduled) work();
  assert.deepEqual(viaUpdate, ['kanban:{}'], 'an entry with no running fiber is started through loader.update');
});

test('POST /reload is the human\'s, and says which API it used', async () => {
  const box = sandbox();
  try {
    const calls: string[] = [];
    const host = fakeHost(INJECTED, {
      loader: {
        *entries() {
          yield {
            id: 'include:kanban',
            options: { id: 'kanban', name: 'dsh-kanban' },
            fiber: { restart: () => calls.push('restart') },
          };
        },
      },
    });
    await boot(host, box.home);
    const route = host.routes[0] as DshWebRoute;

    // An agent may not restart the plugin under other sessions.
    const refused = await callRoute(route, 'POST', `${API_PREFIX}/reload`, '{}', { 'x-kanban-actor': 'agent:sess-9' });
    assert.equal(refused.status, 422);
    assert.equal((JSON.parse(refused.body) as { code: string }).code, 'human-only');

    const allowed = await callRoute(route, 'POST', `${API_PREFIX}/reload`, '{}', { 'x-kanban-actor': 'human' });
    assert.equal(allowed.status, 200, allowed.body);
    const payload = JSON.parse(allowed.body) as { ok: boolean; api: string };
    assert.equal(payload.ok, true);
    assert.equal(payload.api, 'entry(include:kanban).fiber.restart()');
    assert.deepEqual(calls, [], 'the answer is written before the plugin tears itself down');

    // And the scheduled work does happen, once the answer is out.
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(calls, ['restart']);
  } finally {
    box.restore();
  }
});

test('the Loader entry collection is read in every shape it takes, and an odd one is described', () => {
  // Live evidence: `loader.entries` was a function, because `EntryTree.entries()` is a generator
  // method. It must be called; the other shapes stay supported, and an unexpected one is *described*
  // rather than silently read as an empty collection.
  const entry = (id: string) => ({
    options: { id },
    fiber: { restart: () => {} },
  });
  const scheduled: (() => void)[] = [];
  const run = (entries: unknown) =>
    reloadPlugin({ get: () => ({ entries }) } as unknown as DshHostContext, 'kanban', (work) => scheduled.push(work), 0);

  assert.equal(run([entry('include:kanban')]).ok, true, 'an array');
  assert.equal(run(new Map([['kanban', entry('include:kanban')]])).ok, true, 'a Map');
  assert.equal(run({ kanban: entry('include:kanban') }).ok, true, 'a keyed object');
  assert.equal(
    run(function* () {
      yield entry('include:kanban');
    }).ok,
    true,
    'the generator method EntryTree actually has'
  );
  assert.equal(run(() => [entry('include:kanban')]).ok, true, 'a function returning an array');

  const odd = run({ notEntries: () => {} } as unknown);
  assert.equal(odd.ok, false);
  assert.match(odd.api, /loader\.entries \(object, 1 key\(s\)\)/, 'the failure names the shape it saw');

  const unrecognised = run('kanban');
  assert.equal(unrecognised.ok, false);
  assert.match(unrecognised.api, /loader\.entries \(string\)/, 'a primitive is described, not ignored');

  const oddFunction = run(() => 42);
  assert.equal(oddFunction.ok, false);
  assert.match(oddFunction.api, /loader\.entries \(function returning number\)/, 'so is a function returning a non-collection');

  const absent = run(undefined);
  assert.equal(absent.ok, false);
  assert.match(absent.api, /absent/);
});
