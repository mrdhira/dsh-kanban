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
 * It declares three hard injections. That is a correction twice over, and the two halves are the
 * whole lesson:
 *
 * 1. **`inject` gates property access.** The first live load registered the route, opened the board,
 *    imported its history — and failed every tool and the skill with `cannot get property "tools"
 *    without inject`. `ctx.get('name')` is not gated; `ctx.name` is.
 * 2. **`inject` also makes Cordis wait.** The fix declared `['tools','skills']` and left `webServer`
 *    to `ctx.get` because it seemed optional. On the next fresh start the route never registered —
 *    `ctx.get('webServer')` answered `undefined`, because the composition mounts the web server
 *    *after* this plugin — even though the same build had registered it perfectly when hot-added to
 *    a running app where everything was already mounted. Declaring it makes Cordis wait for it.
 */
import { createRequire } from 'node:module';
import { baseRecord, writeProbe, type ProbeRecord } from './probe.js';
import type { DshHostContext } from '../types/dsh.js';

export const name = 'kanban';

/**
 * The three services the plugin cannot work without: two it calls, one it must wait for.
 *
 * This is a **web GUI** plugin by definition (`dsh.client.platform: web`) — a composition with no
 * web server has nowhere to put the panel either.
 */
export const inject: readonly string[] = ['tools', 'skills', 'webServer'];

/** Services looked up rather than injected: none is required, so none is waited for. */
const OPTIONAL_SERVICES: readonly string[] = ['timer', 'fs', 'storageDomain', 'sessionProjections'];

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
  const visible: Record<string, boolean> = {};
  // Recorded for the *optional* services only. The injected ones are guaranteed present — Cordis
  // waited for them — so asking `ctx.get` about them would report a lie on a composition-ordered
  // start, which is exactly the misleading evidence this field used to produce.
  for (const key of OPTIONAL_SERVICES) {
    try {
      visible[key] = ctx.get(key) !== undefined;
    } catch {
      visible[key] = false;
    }
  }

  const record: ProbeRecord = {
    ...baseRecord(__BUILD_ID__, { injected: [...inject], visible }),
    status: 'starting',
    sqlite: probeSqlite(),
  };
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
