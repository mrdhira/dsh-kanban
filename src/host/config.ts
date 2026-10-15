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

export const DEFAULT_CONFIG: KanbanConfig = {
  dbPath: defaultBoardPath(),
  mirrorPath: defaultMirrorPath(),
  mirror: true,
  pollMs: 5000,
  importTodoMd: true,
};

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

  return {
    config: {
      dbPath: string('dbPath', DEFAULT_CONFIG.dbPath),
      mirrorPath: string('mirrorPath', DEFAULT_CONFIG.mirrorPath),
      mirror: boolean('mirror', DEFAULT_CONFIG.mirror),
      pollMs: integer('pollMs', DEFAULT_CONFIG.pollMs, 500, 120_000),
      importTodoMd: boolean('importTodoMd', DEFAULT_CONFIG.importTodoMd),
    },
    warnings,
  };
}
