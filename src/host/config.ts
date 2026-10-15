/**
 * The row config, read defensively.
 *
 * This plugin exports no `Config` schema. It cannot: `schemastery` is not resolvable from a profile
 * directory, and the alternative — hand-writing a schema stand-in the way
 * `dsh-session-metrics/src/host/zod.ts` had to — is a cost with no benefit until the board needs a
 * settings page. So every field is optional here and has a default, and a bad value is reported
 * rather than fatal: a board that refuses to open because one dev setting was misspelled would be
 * worse than a board that opens at its default path and says so.
 */
import { defaultBoardPath, defaultMirrorPath } from '../store/index.js';

export interface KanbanConfig {
  readonly dbPath: string;
  readonly mirrorPath: string;
  readonly mirror: boolean;
  readonly pollMs: number;
  readonly importTodoMd: boolean;
}

/**
 * The defaults, resolved **per call**.
 *
 * Not a module-level constant, and that is the whole point: `defaultBoardPath()` reads `DSH_HOME`,
 * so an object built at import time freezes the paths to whatever the home was then. In the app that
 * happens to be harmless — one process, one home, set before the plugin loads — and everywhere else
 * it is a silent misdirection: the panel reports one board while the store writes another. The
 * module-load version of this cost an afternoon of debugging a test that failed for a reason that
 * had nothing to do with the code under test.
 *
 * The lesson generalises: **a default derived from the environment must be derived when it is used.**
 */
export function defaultConfig(): KanbanConfig {
  return {
    dbPath: defaultBoardPath(),
    mirrorPath: defaultMirrorPath(),
    mirror: true,
    pollMs: 5000,
    importTodoMd: true,
  };
}

export interface ConfigReport {
  readonly config: KanbanConfig;
  readonly warnings: readonly string[];
}

/** Read the config out of whatever the Loader passed, keeping only what parses. */
export function readConfig(raw: unknown): ConfigReport {
  const warnings: string[] = [];
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const string = (key: keyof KanbanConfig, fallback: string): string => {
    const value = source[key];
    if (value === undefined) return fallback;
    if (typeof value === 'string' && value.trim().length > 0) return value;
    warnings.push(`${String(key)} must be a non-empty string; using ${JSON.stringify(fallback)}`);
    return fallback;
  };

  const boolean = (key: keyof KanbanConfig, fallback: boolean): boolean => {
    const value = source[key];
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    warnings.push(`${String(key)} must be true or false; using ${String(fallback)}`);
    return fallback;
  };

  const integer = (key: keyof KanbanConfig, fallback: number, min: number, max: number): number => {
    const value = source[key];
    if (value === undefined) return fallback;
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
    warnings.push(`${String(key)} must be an integer between ${min} and ${max}; using ${String(fallback)}`);
    return fallback;
  };

  // Resolved once, at the moment the config is read — not at module load. See `defaultConfig`.
  const defaults = defaultConfig();

  return {
    config: {
      dbPath: string('dbPath', defaults.dbPath),
      mirrorPath: string('mirrorPath', defaults.mirrorPath),
      mirror: boolean('mirror', defaults.mirror),
      pollMs: integer('pollMs', defaults.pollMs, 500, 120_000),
      importTodoMd: boolean('importTodoMd', defaults.importTodoMd),
    },
    warnings,
  };
}
