/**
 * The store's public surface.
 *
 * Everything the host half, the CLI and the tests use comes through here, which is what makes the
 * store independently testable: it imports `node:sqlite`, `node:fs`, `node:path` and `node:os`, and
 * nothing from DSH at all. A profile plugin cannot resolve `@deepseek-ai/*`, so this half has no
 * choice about being self-contained — but that constraint is also why the store can be tested by
 * Node's own runner with no build step in the loop.
 */
export * from './types.js';
export * from './errors.js';
export * from './schema.js';
export * from './db.js';
export * from './policy.js';
export * from './metrics.js';
export * from './repo.js';
export * from './mirror.js';
export * from './migrate-todo.js';
