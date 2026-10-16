/**
 * The nine tools, called the way the registry calls them.
 *
 * The tools are thin wrappers over the repository, which is why they were nearly skipped — but
 * "thin" is exactly where a wrong argument name, a missing `required`, or a `parameters` key the
 * registry cannot project goes unnoticed until a model calls it and gets `UNKNOWN_TOOL` or a
 * schema rejection. So every tool is invoked here with a realistic payload and a run context that
 * carries an agent session, because the actor is the one thing a tool must never take from its
 * arguments: if a model could pass `actor: "human"` it could set its own priorities.
 *
 * Ordered by the surface: the definitions, then the read path, then the write path, then the
 * refusals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DOW,
  createTask,
  getTask,
  listEvents,
  listTasks,
  openBoard,
  readDow,
  setCheck,
  type Board,
} from '../lib/v1/store/index.js';
import { PolicyViolation, InvalidError } from '../lib/v1/store/errors.js';
import { TOOL_NAMES, createTools } from '../lib/v1/host/tools.js';
import type { DshJson, DshToolDefinition, DshToolRunContext } from '../lib/v1/types/dsh.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');

function tools(board: Board): DshToolDefinition[] {
  return createTools({
    board: () => board,
    config: () => ({ dbPath: ':memory:', mirrorPath: '/tmp/x.md', mirror: false, pollMs: 5000, importTodoMd: false }),
    mirror: () => {},
  });
}

function byName(list: readonly DshToolDefinition[], name: string): DshToolDefinition {
  const found = list.find((tool) => tool.name === name);
  assert.ok(found !== undefined, `no tool named ${name}`);
  return found;
}

/** A run context with an agent session, exactly as the registry builds one. */
const asAgent = (id = 'sess-1'): DshToolRunContext => ({
  agent: { id, session: { append: () => {} } },
});

/** Call a tool and return its JSON value. */
async function call(list: readonly DshToolDefinition[], name: string, args: unknown, exec: DshToolRunContext = asAgent()): Promise<DshJson> {
  return byName(list, name).execute(args, exec);
}

/** A refined card, ready to be pulled. */
function refine(board: Board, id: string): void {
  for (const check of DEFAULT_DOW.dor) setCheck(board, id, 'dor', check, true, { actor: { kind: 'human', id: 'dhira' }, now: NOW });
}

// ------------------------------------------------------------------ the definitions

test('every documented tool exists, and only those', () => {
  const list = tools(openBoard(':memory:')).map((tool) => tool.name);
  assert.deepEqual([...list].sort(), [...TOOL_NAMES].sort());
});

test('every tool carries a description, a parameters object and a render', () => {
  for (const tool of tools(openBoard(':memory:'))) {
    assert.ok(tool.name.startsWith('kanban_'), `${tool.name} is not namespaced`);
    assert.ok(tool.description.length > 20, `${tool.name} has no usable description`);
    assert.equal(typeof tool.parameters, 'object');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.execute, 'function');
    const rendered = tool.output.render({}, { summary: 'ok' } as unknown as DshJson);
    assert.equal(rendered[0]?.type, 'text');
    assert.match(rendered[0]?.text ?? '', /ok/);
  }
});

test('every parameter carries a type', () => {
  for (const tool of tools(openBoard(':memory:'))) {
    const { properties } = tool.parameters as { properties: Record<string, Record<string, unknown>> };
    for (const [name, spec] of Object.entries(properties)) {
      assert.equal(typeof spec.type, 'string', `${tool.name}.${name} has no type`);
    }
  }
});

// ------------------------------------------------------------------ the read path

test('kanban_list reports the board and the WIP position', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  await call(list, 'kanban_create', { title: 'first card' });
  const value = (await call(list, 'kanban_list', {})) as { count: number; cards: string };
  assert.equal(value.count, 1);
  assert.match(value.cards, /T-001/);
  assert.match(value.cards, /WIP 0\/2/);
  board.close();
});

test('kanban_list filters by state', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  await call(list, 'kanban_create', { title: 'a' });
  await call(list, 'kanban_create', { title: 'b' });
  refine(board, 'T-002');
  await call(list, 'kanban_move', { id: 'T-002', toState: 'ready' });
  const onlyReady = (await call(list, 'kanban_list', { state: ['ready'] })) as { count: number };
  assert.equal(onlyReady.count, 1);
  board.close();
});

test('kanban_get returns the card, its checklists and its history', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  await call(list, 'kanban_create', { title: 'first card', acceptance: 'it works' });
  const value = (await call(list, 'kanban_get', { id: 'T-001' })) as { card: string };
  assert.match(value.card, /first card/);
  assert.match(value.card, /DoR: missing/);
  assert.match(value.card, /history:.*created/s);
  board.close();
});

test('kanban_metrics reports the four metrics and the SLE', async () => {
  const board = openBoard(':memory:');
  const value = (await call(tools(board), 'kanban_metrics', {})) as { summary: string };
  assert.match(value.summary, /WIP 0/);
  assert.match(value.summary, /Throughput 0 in 7 days/);
  assert.match(value.summary, /Cycle time/);
  assert.match(value.summary, /SLE 85% ≤ 3d \(guess/);
  board.close();
});

test('kanban_board reads the Definition of Workflow', async () => {
  const board = openBoard(':memory:');
  const value = (await call(tools(board), 'kanban_board', { action: 'dow' })) as { summary: string };
  assert.match(value.summary, /WIP control: in-progress 2, review 1/);
  assert.match(value.summary, /DoR: outcome, acceptance, write-scope, estimate/);
  assert.match(value.summary, /DoD: evidence, tests-or-na, docs-or-lesson, links-resolve, no-unverified-claims/);
  board.close();
});

// ------------------------------------------------------------------ the write path

test('kanban_create starts in the backlog and is attributed to the session', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  const value = (await call(list, 'kanban_create', { title: 'from an agent', project: 'dsh' }, asAgent('sess-42'))) as {
    id: string;
  };
  assert.equal(value.id, 'T-001');
  const card = getTask(board, 'T-001');
  assert.equal(card?.state, 'backlog');
  assert.equal(card?.createdBy, 'agent:sess-42');
  assert.equal(card?.project, 'dsh');
  board.close();
});

test('kanban_create applies a template, and drops the priority a template carries', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);

  // `bugfix` carries `p1-high`, so an agent taking that template would be setting a priority by
  // another name. The field is dropped and **said out loud**; the rest of the template still lands.
  const created = (await call(list, 'kanban_create', { title: 'something broke', template: 'bugfix' })) as {
    id: string;
    card: string;
  };
  const card = getTask(board, created.id);
  assert.equal(card?.priority, 'p2-normal', 'an agent never sets a priority, template or not');
  assert.deepEqual(card?.tags, ['bug'], 'the rest of the template still applies');
  assert.match(created.card, /priority=p1-high dropped/);

  // The human's own create keeps the template's priority.
  const human = createTask(
    board,
    { title: 'something broke too', priority: 'p1-high', tags: ['bug'] },
    { actor: { kind: 'human', id: 'dhira' }, now: NOW }
  );
  assert.equal(human.priority, 'p1-high');
  board.close();
});

test('refused: an explicit priority argument from an agent is refused, not dropped', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  await assert.rejects(
    () => call(list, 'kanban_create', { title: 'urgent thing', priority: 'p0-critical' }),
    (error: unknown) => error instanceof PolicyViolation && error.policyCode === 'human-only'
  );
  assert.equal(listTasks(board, { limit: 10 }).total, 0, 'nothing was created');
  board.close();
});

test('kanban_update edits prose, and `check` ticks a checklist item', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  await call(list, 'kanban_create', { title: 'first' });
  await call(list, 'kanban_update', { id: 'T-001', action: 'edit', outcome: 'the board works' });
  assert.equal(getTask(board, 'T-001')?.outcome, 'the board works');

  const checked = (await call(list, 'kanban_update', { id: 'T-001', action: 'check', gate: 'dor', checkId: 'outcome' })) as {
    card: string;
  };
  assert.match(checked.card, /outcome ticked/);
  assert.deepEqual(Object.keys(getTask(board, 'T-001')?.dor ?? {}), ['outcome']);
  board.close();
});

test('kanban_update comments, blocks and unblocks', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  await call(list, 'kanban_create', { title: 'first' });
  await call(list, 'kanban_update', { id: 'T-001', action: 'comment', body: 'proposing p1' });
  const blocked = (await call(list, 'kanban_update', { id: 'T-001', action: 'block', reason: 'vendor' })) as { card: string };
  assert.match(blocked.card, /blocked: vendor/);
  assert.equal(getTask(board, 'T-001')?.blockedReason, 'vendor');
  await call(list, 'kanban_update', { id: 'T-001', action: 'unblock' });
  assert.equal(getTask(board, 'T-001')?.blockedReason, null);
  board.close();
});

test('kanban_move enforces the Definition of Ready, then the WIP limit', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  await call(list, 'kanban_create', { title: 'one' });
  await call(list, 'kanban_create', { title: 'two' });
  await call(list, 'kanban_create', { title: 'three' });

  await assert.rejects(
    () => call(list, 'kanban_move', { id: 'T-001', toState: 'ready' }),
    (error: unknown) => error instanceof PolicyViolation && error.policyCode === 'dor-incomplete'
  );

  for (const id of ['T-001', 'T-002', 'T-003']) {
    refine(board, id);
    await call(list, 'kanban_move', { id, toState: 'ready' });
  }
  await call(list, 'kanban_move', { id: 'T-001', toState: 'in-progress' });
  await call(list, 'kanban_move', { id: 'T-002', toState: 'in-progress' });
  await assert.rejects(
    () => call(list, 'kanban_move', { id: 'T-003', toState: 'in-progress' }),
    (error: unknown) => error instanceof PolicyViolation && error.policyCode === 'wip-limit'
  );
  board.close();
});

test('kanban_sprint creates, starts and lists a sprint inside the timebox', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  const created = (await call(list, 'kanban_sprint', {
    action: 'create',
    name: 'Sprint 1',
    goal: 'the board works',
    start: '2026-10-01',
    end: '2026-11-01',
  })) as { summary: string };
  assert.match(created.summary, /S-001 created/);
  await call(list, 'kanban_sprint', { action: 'start', id: 'S-001' });
  const listed = (await call(list, 'kanban_sprint', { action: 'list' })) as { summary: string };
  assert.match(listed.summary, /active/);
  board.close();
});

test('kanban_delete drops with a reason, and refuses without one', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  await call(list, 'kanban_create', { title: 'first' });
  await assert.rejects(() => call(list, 'kanban_delete', { id: 'T-001' }), PolicyViolation);
  const dropped = (await call(list, 'kanban_delete', { id: 'T-001', reason: 'superseded' })) as { card: string };
  assert.match(dropped.card, /dropped: superseded/);
  board.close();
});

test('kanban_update with an unknown action falls back to edit rather than doing something unexpected', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  await call(list, 'kanban_create', { title: 'first' });
  await call(list, 'kanban_update', { id: 'T-001', action: 'wibble', outcome: 'still edited' });
  assert.equal(getTask(board, 'T-001')?.outcome, 'still edited');
  board.close();
});

// ------------------------------------------------------------------ refusals

test('refused: an agent may not set a priority through a tool', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  await call(list, 'kanban_create', { title: 'first' });
  await assert.rejects(
    () => call(list, 'kanban_update', { id: 'T-001', action: 'edit', priority: 'p0-critical' }),
    (error: unknown) => error instanceof PolicyViolation && error.policyCode === 'human-only'
  );
  assert.equal(getTask(board, 'T-001')?.priority, 'p2-normal');
  board.close();
});

test('refused: an agent may not purge a card', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  await call(list, 'kanban_create', { title: 'first' });
  await assert.rejects(() => call(list, 'kanban_delete', { id: 'T-001', mode: 'purge' }), InvalidError);
  assert.notEqual(getTask(board, 'T-001'), undefined);
  board.close();
});

test('the human sets priorities through the panel or the CLI, never through a tool', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  await call(list, 'kanban_create', { title: 'first' });

  // A tool run always carries an agent session, so on this surface the refusal is unconditional —
  // there is no argument an agent can pass to become the human. The human's own surfaces
  // (`x-kanban-actor: human` on the route, and `bin/kanban.mjs`) do allow it, and `cli.test.ts`
  // proves that end to end.
  await assert.rejects(
    () => call(list, 'kanban_update', { id: 'T-001', action: 'edit', priority: 'p0-critical' }),
    (error: unknown) => error instanceof PolicyViolation && error.policyCode === 'human-only'
  );
  assert.equal(getTask(board, 'T-001')?.priority, 'p2-normal');
  board.close();
});

test('an unattributed call is recorded as the plugin, not as the human', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  // No run context at all: the fallback actor must not be privileged.
  await call(list, 'kanban_create', { title: 'first' }, {});
  assert.equal(getTask(board, 'T-001')?.createdBy, 'plugin:kanban');
  await assert.rejects(() => call(list, 'kanban_update', { id: 'T-001', action: 'edit', priority: 'p0-critical' }, {}), PolicyViolation);
  board.close();
});

test('refused: unknown ids and missing required arguments', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  await assert.rejects(() => call(list, 'kanban_get', { id: 'T-404' }), /no card/);
  await assert.rejects(() => call(list, 'kanban_get', {}), /needs an id/);
  await assert.rejects(() => call(list, 'kanban_create', {}), InvalidError);
  await assert.rejects(() => call(list, 'kanban_move', { id: 'T-001' }), /needs an id and a toState/);
  await assert.rejects(() => call(list, 'kanban_update', { action: 'edit' }), /needs an id/);
  await assert.rejects(() => call(list, 'kanban_sprint', { action: 'start' }), /needs an id for start/);
  board.close();
});

test('refused: a stale revision through a tool cannot overwrite a newer write', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  await call(list, 'kanban_create', { title: 'first' });
  await call(list, 'kanban_update', { id: 'T-001', action: 'edit', outcome: 'once' });
  await assert.rejects(
    () => call(list, 'kanban_update', { id: 'T-001', action: 'edit', outcome: 'stale', expectedRev: 1 }),
    /changed since it was read/
  );
  assert.equal(getTask(board, 'T-001')?.outcome, 'once');
  board.close();
});

test('the tools never let an argument decide the actor', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  // A model that passes `actor` is ignored: the session is the identity.
  await call(list, 'kanban_create', { title: 'first', actor: 'human' });
  const created = listEvents(board, { taskId: 'T-001' })[0];
  assert.equal(created?.actor, 'agent:sess-1');

  // And the priority gate still holds with that argument present.
  await assert.rejects(
    () => call(list, 'kanban_update', { id: 'T-001', action: 'edit', priority: 'p0-critical', actor: 'human' }),
    PolicyViolation
  );
  board.close();
});

test('kanban_board can report the views and templates it seeded', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  const views = (await call(list, 'kanban_board', { action: 'views' })) as { summary: string };
  assert.match(views.summary, /board/);
  assert.match(views.summary, /ageing/);
  const templates = (await call(list, 'kanban_board', { action: 'templates' })) as { summary: string };
  assert.match(templates.summary, /bugfix/);
  board.close();
});

test('kanban_board does not offer the migration, and refuses it if asked anyway', async () => {
  const board = openBoard(':memory:');
  const list = tools(board);
  // The migration writes rows that bypass every gate, so it is not an agent's action at all — it
  // is `bin/kanban.mjs migrate`, or the route with a human actor. An action that always refused
  // would be a trap in the schema, so it is gone from the enum; the handler still ignores it.
  const action = (byName(list, 'kanban_board').parameters as { properties: { action: { enum: string[] } } }).properties.action;
  assert.equal(action.enum.includes('import-todo'), false);
  await call(list, 'kanban_board', { action: 'import-todo', text: '| T-101 | a row | done | — | — | — | — |' });
  assert.equal(listTasks(board, { limit: 10 }).total, 0, 'nothing was imported through a tool');
  board.close();
});

test('every tool output schema is real JSON Schema, which is the dialect the registry validates', () => {
  // Nine tools were rejected live with
  //   `unsupported JSON schema: schema.properties.count.required is not supported on type "integer"`
  // because `parameters` and `output.schema` are **different dialects**: `parameters` takes a
  // per-property `required: true` (as the shipped todo tool does), while `output.schema` is real
  // JSON Schema, where `required` is an array of names at the object level. Nothing in the suite
  // could see that; this test is what now can.
  for (const tool of tools(openBoard(':memory:'))) {
    const schema = tool.output.schema as {
      readonly required?: unknown;
      readonly properties?: Record<string, { readonly required?: unknown }>;
    };
    assert.equal(Array.isArray(schema.required), true, `${tool.name}.output.schema needs a required ARRAY`);
    for (const [property, spec] of Object.entries(schema.properties ?? {})) {
      assert.equal(
        spec.required,
        undefined,
        `${tool.name}.output.schema.properties.${property}.required is not supported — use the array`
      );
    }
    for (const name of schema.required as string[]) {
      assert.equal(typeof name, 'string', `${tool.name}: required entries must be strings`);
      assert.ok(schema.properties?.[name] !== undefined, `${tool.name}: required names ${name}, which is not a property`);
    }
  }
});

test('every tool parameters schema is object-rooted JSON Schema, which is what the model is sent', () => {
  // A raw `ctx.tools.register` does not compile `parameters` the way `defineTool` does: the
  // registry projects it to the provider verbatim. The per-property dialect reached the provider
  // as a schema with no root type, and every request failed with
  //   `schema must be a JSON Schema of 'type: "object"', got 'type: null'`.
  for (const tool of tools(openBoard(':memory:'))) {
    const schema = tool.parameters as {
      readonly type?: unknown;
      readonly required?: unknown;
      readonly properties?: Record<string, { readonly required?: unknown }>;
    };
    assert.equal(schema.type, 'object', `${tool.name}.parameters needs type "object" at the root`);
    assert.equal(typeof schema.properties, 'object', `${tool.name}.parameters needs properties`);
    for (const [property, spec] of Object.entries(schema.properties ?? {})) {
      assert.equal(spec.required, undefined, `${tool.name}.parameters.properties.${property}.required — use the array`);
    }
    for (const name of (schema.required ?? []) as string[]) {
      assert.ok(schema.properties?.[name] !== undefined, `${tool.name}: required names ${name}, which is not a property`);
    }
  }
  const move = byName(tools(openBoard(':memory:')), 'kanban_move').parameters as { required?: string[] };
  assert.ok(move.required?.includes('toState'), 'a per-property required: true lands in the root array');
});
