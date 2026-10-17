/**
 * Reload this plugin's host half **without restarting the app**.
 *
 * Dhira's constraint, verbatim: *"please do not make me always restart the apps, there are other
 * session workings, if we restart I need to wait other sessions to completed first."* That is a
 * product requirement, not a preference. A host-half fix that costs every running session its place
 * in the queue is a fix that arrives late or not at all.
 *
 * The Loader owns this plugin's entry (patch `kanban`, module `dsh-kanban`). This code was written
 * against the installed Loader's source, not against a guess:
 *
 * - `Loader extends EntryTree`, and `EntryTree.entries()` is a **generator method**, so the property
 *   named `entries` is the function, not the collection. Call it and walk what it yields (nested
 *   subtrees included). The first live route answered `loader.entries (function, 0 key(s))` because
 *   it inspected the property instead of calling it.
 * - an `Entry` names its module in `options.name`, and `entry.id` is its nested id (`a:b`), which is
 *   what `loader.resolve()` and `loader.update()` take.
 * - an `Entry` has **no** `stop`/`start`. The real restart is `entry.fiber.restart()` — Cordis's
 *   documented "dispose and immediately reload this plugin with its current config." When an entry
 *   has no running fiber, the fallback is `loader.update(id, {})`, which starts it.
 *
 * Two properties matter:
 *
 * - **It is scheduled, never inline.** The caller must get its answer *before* this plugin is torn
 *   down, or the response dies with the code that was meant to send it.
 * - **Every unknown is reported.** If there is no Loader, no matching entry, or no method this code
 *   recognises, the caller is told which, so a failed reload is a sentence rather than a mystery.
 */
import type { DshHostContext } from '../types/dsh.js';

/** The little of a Cordis `Entry` this needs, kept structural so a shape change is visible. */
interface LoaderEntryLike {
  /** `Entry.id` — the nested id (`include:kanban`) that `loader.update` resolves. */
  readonly id?: string;
  readonly options?: { readonly id?: string; readonly name?: string };
  /** `Entry.fiber` — the running plugin fiber, which owns `restart()`. */
  readonly fiber?: { restart?: () => unknown };
}

interface LoaderLike {
  /** `EntryTree.entries` is a method on the installed Loader; older fakes used a property. */
  readonly entries?: unknown;
  update?: (id: string, options?: unknown) => unknown;
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
  return entry.id ?? entry.options?.id ?? entry.options?.name ?? '(unnamed)';
}

/** Does this entry look like ours? The patch id is `kanban`; the module is `dsh-kanban`. */
function isOurs(entry: LoaderEntryLike, pluginName: string): boolean {
  const name = entry.options?.name ?? '';
  if (name === pluginName || name === `dsh-${pluginName}`) return true;
  if (name.endsWith(`/${pluginName}`) || name.endsWith(`/dsh-${pluginName}`)) return true;
  const id = entryIdOf(entry);
  return id === pluginName || id.endsWith(`:${pluginName}`);
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

  const collection = entryCollection(loader);
  const entry = collection.entries.find((candidate) => isOurs(candidate, pluginName));
  if (entry === undefined) {
    return {
      ok: false,
      api: `loader.entries (${collection.shape})`,
      message: `no Loader entry matched ${pluginName}`,
      entries: collection.entries.map(entryIdOf),
    };
  }

  const id = entryIdOf(entry);
  if (entry.fiber !== undefined && typeof entry.fiber.restart === 'function') {
    schedule(() => {
      void Promise.resolve(entry.fiber?.restart?.());
    }, delayMs);
    return { ok: true, api: `entry(${id}).fiber.restart()`, message: 'reloading after this answer' };
  }

  if (typeof loader.update === 'function') {
    schedule(() => {
      void Promise.resolve(loader?.update?.(id, {}));
    }, delayMs);
    return { ok: true, api: `loader.update(${id})`, message: 're-applying after this answer' };
  }

  return {
    ok: false,
    api: 'unsupported',
    message: `the entry ${id} exposes neither a running fiber nor loader.update`,
  };
}

/** What a Loader's `entries` turned out to be, and the entries it yielded. */
interface EntryCollection {
  readonly entries: readonly LoaderEntryLike[];
  /** What the property actually was, for the failure message. */
  readonly shape: string;
}

function isIterable(value: unknown): value is Iterable<LoaderEntryLike> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function'
  );
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * The Loader's entry collection, whatever shape it is in.
 *
 * The installed `EntryTree.entries()` is a generator **method**, so a function must be called and
 * its iterable consumed. Arrays, `Map`s and keyed objects stay supported because tests and older
 * wrappers use them. Anything else is *described* — never silently treated as empty — because the
 * failure message is what made this bug diagnosable.
 */
function entryCollection(loader: LoaderLike): EntryCollection {
  const raw = loader.entries;

  if (Array.isArray(raw)) {
    return { entries: raw as readonly LoaderEntryLike[], shape: `array, ${raw.length} entry(ies)` };
  }

  if (raw instanceof Map) {
    const entries = [...raw.values()] as readonly LoaderEntryLike[];
    return { entries, shape: `Map, ${entries.length} entry(ies)` };
  }

  if (typeof raw === 'function') {
    try {
      const produced = (raw as () => unknown).call(loader);
      if (produced instanceof Map) {
        const entries = [...produced.values()] as readonly LoaderEntryLike[];
        return { entries, shape: `function -> Map, ${entries.length} entry(ies)` };
      }
      if (Array.isArray(produced)) {
        return {
          entries: produced as readonly LoaderEntryLike[],
          shape: `function -> array, ${produced.length} entry(ies)`,
        };
      }
      if (isIterable(produced)) {
        const entries = [...produced];
        return { entries, shape: `function -> iterable, ${entries.length} entry(ies)` };
      }
      return { entries: [], shape: `function returning ${kindOf(produced)}` };
    } catch (error) {
      return {
        entries: [],
        shape: `function that threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (raw !== null && typeof raw === 'object') {
    const entries = Object.values(raw as Record<string, LoaderEntryLike>);
    return { entries, shape: `object, ${entries.length} key(s)` };
  }

  return { entries: [], shape: raw === undefined ? 'absent' : kindOf(raw) };
}
