/**
 * The probe record: what this plugin found when it loaded, written where it can be read from
 * outside the app.
 *
 * This exists because the three P0 questions (`tasks/T-013-dsh-kanban/probes.md`) can only be
 * answered *inside* the host process, and the host process is an Electron main process with no
 * console anyone can read. A plugin that fails to load leaves no trace — the framework abdicates a
 * throwing entry in silence, which is how a "registered and healthy" entry once rendered nothing
 * for hours. So the record is written **before** anything can throw, and rewritten with the
 * outcome afterwards.
 *
 * It is written with `node:fs` and `JSON.stringify`, no store import, no dynamic import: the one
 * moment this file must work is the moment something else did not.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dshHome } from '../store/db.js';

/** `$DSH_HOME/logs/kanban/probe.json` — machine output, disposable, never a source of truth. */
export function probePath(): string {
  return join(dshHome(), 'logs', 'kanban', 'probe.json');
}

export interface ProbeRecord {
  readonly status: 'starting' | 'ok' | 'failed' | 'import-failed';
  readonly at: string;
  readonly buildId: string;
  readonly plugin: string;
  readonly node: string;
  readonly electron: string | null;
  readonly sqlite: { readonly available: boolean; readonly error: string | null };
  /**
   * Two different questions, kept apart because conflating them cost a day.
   *
   * `injected` is what Cordis waited for before calling `apply` — guaranteed present. `visible` is
   * what `ctx.get` can see for the *optional* services. A single map used to mix the two, and on a
   * composition-ordered start it reported `webServer: false` beside a route that had every reason
   * to register.
   */
  readonly services: {
    readonly injected: readonly string[];
    readonly visible: Readonly<Record<string, boolean>>;
  };
  readonly route: { readonly attempted: boolean; readonly path: string; readonly registered: boolean; readonly error: string | null };
  readonly tools: readonly string[];
  readonly skill: string | null;
  readonly board: { readonly path: string; readonly opened: boolean; readonly error: string | null; readonly rev?: number; readonly tasks?: number };
  readonly warnings: readonly string[];
  readonly error?: string;
}

/** Write the record, creating its directory. Never throws: a probe that throws is worse than none. */
export function writeProbe(record: ProbeRecord): void {
  try {
    const path = probePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch {
    // Nothing useful left to do: the probe's job is to report, not to fail the plugin.
  }
}

/** The fields known before any plugin code runs. */
export function baseRecord(
  buildId: string,
  services: ProbeRecord['services']
): Omit<ProbeRecord, 'status'> {
  const versions = process.versions as Record<string, string | undefined>;
  return {
    at: new Date().toISOString(),
    buildId,
    plugin: 'dsh-kanban',
    node: versions.node ?? 'unknown',
    electron: versions.electron ?? null,
    sqlite: { available: false, error: null },
    services,
    route: { attempted: false, path: '/api/kanban', registered: false, error: null },
    tools: [],
    skill: null,
    board: { path: '', opened: false, error: null },
    warnings: [],
  };
}
