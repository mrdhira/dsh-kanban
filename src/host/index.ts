/**
 * The host half's entry point — deliberately thin, because it must survive its own failure.
 *
 * A Cordis plugin that throws inside `apply` is **abdicated**: the framework marks the entry
 * inactive and the UI simply does not appear. That is the single most expensive failure mode we
 * have hit (an entry reported "registered" and rendered nothing for hours), and the answer is not
 * to be careful — it is to make the failure produce evidence.
 *
 * So this file imports almost nothing. It records what it can observe *before* touching the store,
 * writes the probe record, and only then dynamically imports the real wiring. If `node:sqlite` is
 * missing, or the store cannot open, the probe still lands on disk with the reason:
 * `$DSH_HOME/logs/kanban/probe.json`.
 *
 * It declares exactly two hard injections and no more. That is a correction, not a preference: the
 * first live load registered the route, opened the board and imported the board's history — and
 * then failed **every** tool and the skill with `cannot get property "tools" without inject`.
 * Cordis gates *property* access on the declared `inject` list, while `ctx.get('name')` is not
 * gated at all. So the two services the plugin cannot work without are declared, and everything
 * optional is looked up and reported rather than demanded.
 */
import { createRequire } from 'node:module';
import { baseRecord, writeProbe, type ProbeRecord } from './probe.js';
import type { DshHostContext } from '../types/dsh.js';

export const name = 'kanban';

/**
 * Without these the plugin loads, opens its board, and then offers no tools and no skill — the
 * quietest possible failure. Both are present in this composition, confirmed by the same probe.
 */
export const inject: readonly string[] = ['tools', 'skills'];

/** Services whose presence changes what the plugin can do, recorded in the probe. */
const REPORTED_SERVICES: readonly string[] = ['webServer', 'tools', 'skills', 'timer', 'fs', 'storageDomain', 'sessionProjections'];

function probeSqlite(): ProbeRecord['sqlite'] {
  try {
    const sqlite = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync?: unknown };
    const available = typeof sqlite.DatabaseSync === 'function';
    return { available, error: available ? null : 'node:sqlite loaded but exposes no DatabaseSync' };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function apply(ctx: DshHostContext, config?: unknown): void {
  const services: Record<string, boolean> = {};
  for (const key of REPORTED_SERVICES) {
    try {
      services[key] = ctx.get(key) !== undefined;
    } catch {
      services[key] = false;
    }
  }

  const record: ProbeRecord = { ...baseRecord(__BUILD_ID__, services), status: 'starting', sqlite: probeSqlite() };
  writeProbe(record);

  void import('./start.js').then(
    (module) => {
      try {
        writeProbe(module.start(ctx, record, config));
      } catch (error) {
        writeProbe({
          ...record,
          status: 'failed',
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      }
    },
    (error: unknown) => {
      writeProbe({
        ...record,
        status: 'import-failed',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  );
}
