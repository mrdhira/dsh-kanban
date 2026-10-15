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
import { API_PREFIX } from '../lib/v1/host/api.js';
import type { DshHostContext, DshIncomingMessage, DshServerResponse, DshToolDefinition, DshWebRoute } from '../lib/v1/types/dsh.js';

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
 * `get()` answers for anything; a **property** read only works for the names in `declared`, and
 * otherwise throws the way Cordis does. That asymmetry is the whole rule under test.
 */
function fakeHost(declared: readonly string[], services: Record<string, unknown>): FakeHost {
  const tools: DshToolDefinition[] = [];
  const skills: Record<string, unknown>[] = [];
  const routes: DshWebRoute[] = [];
  const effects: string[] = [];
  const indexTaps: ((html: string) => string)[] = [];
  const refused: string[] = [];

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
    get: (serviceName: string) => registry[serviceName],
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

test('the plugin is named kanban and declares the two services it reads as properties', () => {
  assert.equal(name, 'kanban');
  assert.deepEqual([...inject], ['tools', 'skills']);
});

test('refused: reading an undeclared service as a property throws, which is why inject is declared', () => {
  const { ctx } = fakeHost([], {});
  assert.throws(() => (ctx as Record<string, unknown>).tools, /without inject/);
});

// ------------------------------------------------------------------ what actually registers

test('the host half registers exactly the nine documented tools', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(['tools', 'skills'], {});
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
    const host = fakeHost(['tools', 'skills'], {});
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
    const host = fakeHost(['tools', 'skills'], {});
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
    const host = fakeHost(['tools', 'skills'], {});
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

test('a missing webServer is reported rather than fatal, and the tools still register', async () => {
  const box = sandbox();
  try {
    // `webServer` is optional: it is looked up with `ctx.get`, so it never reaches the proxy.
    const host = fakeHost(['tools', 'skills'], {});
    const record = await boot(host, box.home);
    assert.equal(host.tools.length, 9);

    const box2 = sandbox();
    try {
      const withoutServer = fakeHost(['tools', 'skills'], { webServer: undefined });
      const record2 = await boot(withoutServer, box2.home);
      assert.equal(withoutServer.tools.length, 9, 'tools do not depend on the web server');
      assert.equal((record2.route as { registered: boolean }).registered, false);
      assert.match((record2.route as { error: string }).error, /webServer/);
      assert.equal(record2.status, 'ok');
    } finally {
      box2.restore();
    }
  } finally {
    box.restore();
  }
});

test('a bad config is reported as warnings, and the board still opens at its default path', async () => {
  const box = sandbox();
  try {
    const host = fakeHost(['tools', 'skills'], {});
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
    const host = fakeHost(['tools', 'skills'], {});
    const record = await boot(host, box.home);
    assert.equal((record.warnings as string[]).some((warning) => warning.includes('imported 1 row')), true);
    assert.equal((record.board as { tasks: number }).tasks, 1);

    // A second boot **of the same home** must not import again: the rows are already there.
    const again = fakeHost(['tools', 'skills'], {});
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
    const host = fakeHost(['tools', 'skills'], {});
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
    const host = fakeHost(['tools', 'skills'], {});
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
    const host = fakeHost(['tools', 'skills'], {});
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
    const host = fakeHost(['tools', 'skills'], {});
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
    const host = fakeHost(['tools', 'skills'], {});
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
    const host = fakeHost(['tools', 'skills'], {});
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
    const host = fakeHost(['tools', 'skills'], {});
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
    const host = fakeHost(['tools', 'skills'], {});
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
    const host = fakeHost(['tools', 'skills'], {});
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
    const host = fakeHost(['tools', 'skills'], {});
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
    const host = fakeHost(['tools', 'skills'], {});
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
    const host = fakeHost(['tools', 'skills'], {});
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
    const host = fakeHost(['tools', 'skills'], {});
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
