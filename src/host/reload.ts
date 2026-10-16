/**
 * Reload this plugin's host half **without restarting the app**.
 *
 * Dhira's constraint, verbatim: *"please do not make me always restart the apps, there are other
 * session workings, if we restart I need to wait other sessions to completed first."* That is a
 * product requirement, not a preference. A host-half fix that costs every running session its place
 * in the queue is a fix that arrives late or not at all.
 *
 * The Loader owns this plugin's entry (`include:kanban`, patch `kanban`), and Cordis reloads an entry
 * by stopping and starting it. So the plugin asks the Loader to do exactly that, and reports which
 * API it used — because the Loader is a Cordis built-in rather than a Service, its shape is not in
 * any inspect catalog, and guessing silently is how this project has lost days.
 *
 * Two properties matter:
 *
 * - **It is scheduled, never inline.** The caller must get its answer *before* this plugin is torn
 *   down, or the response dies with the code that was meant to send it.
 * - **Every unknown is reported.** If there is no Loader, no matching entry, or no method this code
 *   recognises, the caller is told which, so a failed reload is a sentence rather than a mystery.
 */
import type { DshHostContext } from '../types/dsh.js';

/** The little of the Cordis Loader this needs, kept structural so a shape change is visible. */
interface LoaderEntryLike {
  readonly id?: string;
  readonly options?: { readonly id?: string; readonly name?: string };
  start?: (config?: unknown) => unknown;
  stop?: () => unknown;
  update?: (config?: unknown) => unknown;
}

interface LoaderLike {
  readonly entries?: readonly LoaderEntryLike[];
  update?: (id: string, config?: unknown) => unknown;
}

export interface ReloadOutcome {
  readonly ok: boolean;
  /** Which API path was taken, for the log and the answer. */
  readonly api: string;
  readonly message: string;
  /** The entry ids the Loader knows, when one could not be matched. */
  readonly entries?: readonly string[];
}

function entryIdOf(entry: LoaderEntryLike): string {
  return entry.options?.id ?? entry.options?.name ?? entry.id ?? '(unnamed)';
}

/** Does this entry look like ours? The patch id is `kanban`; the loader may key it `include:kanban`. */
function isOurs(entry: LoaderEntryLike, pluginName: string): boolean {
  const id = entryIdOf(entry);
  const name = entry.options?.name ?? '';
  return id === pluginName || id.endsWith(`:${pluginName}`) || name === `dsh-${pluginName}` || name === pluginName;
}

/**
 * Ask the Loader to restart this plugin's entry. The work is scheduled, so the caller is answered
 * first; `delayMs` exists so a test can run it without waiting.
 */
export function reloadPlugin(
  ctx: DshHostContext,
  pluginName: string,
  schedule: (work: () => void, delayMs: number) => void = (work, delayMs) => {
    setTimeout(work, delayMs);
  },
  delayMs = 250
): ReloadOutcome {
  let loader: LoaderLike | undefined;
  try {
    loader = ctx.get('loader') as LoaderLike | undefined;
  } catch (error) {
    return { ok: false, api: 'ctx.get(loader)', message: error instanceof Error ? error.message : String(error) };
  }
  if (loader === undefined) {
    return { ok: false, api: 'none', message: 'no Loader on this context; reload the app instead' };
  }

  const entries = loader.entries ?? [];
  const entry = entries.find((candidate) => isOurs(candidate, pluginName));
  if (entry === undefined) {
    return {
      ok: false,
      api: 'loader.entries',
      message: `no Loader entry matched ${pluginName}`,
      entries: entries.map(entryIdOf),
    };
  }

  if (typeof entry.stop === 'function' && typeof entry.start === 'function') {
    schedule(() => {
      void Promise.resolve(entry.stop?.()).then(() => entry.start?.());
    }, delayMs);
    return { ok: true, api: `entry(${entryIdOf(entry)}).stop/start`, message: 'reloading after this answer' };
  }

  if (typeof loader.update === 'function') {
    const id = entryIdOf(entry);
    schedule(() => {
      void loader.update?.(id);
    }, delayMs);
    return { ok: true, api: `loader.update(${id})`, message: 're-applying after this answer' };
  }

  return {
    ok: false,
    api: 'unsupported',
    message: `the entry ${entryIdOf(entry)} exposes neither stop/start nor a loader.update`,
  };
}
