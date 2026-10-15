/**
 * The DSH contracts this plugin relies on — **observed, not published**.
 *
 * Every shape below was read off a live surface (the Cordis inspector, or the running app's own
 * bundle) and is written down here rather than imported, because a profile plugin cannot resolve
 * `@deepseek-ai/*` at runtime: `dsh-session-metrics/src/host/zod.ts` exists only because
 * `schemastery` "is not resolvable from a profile directory". Vendoring the contract is what lets
 * the plugin pin **no** dependency at all.
 *
 * It lives in `src/` rather than a sibling `types/` directory for one concrete reason: the
 * declaration build emits it to `lib/v1/types/dsh.d.ts`, and every `import type { … } from
 * '../types/dsh.js'` then resolves from both `src/**` and `lib/v1/**` without a copy step and
 * without a path escaping the package root. A vendored contract that cannot be found from the
 * built output is a contract the tests cannot check against.
 *
 * A DSH update can move any of this. When it does, the failure is loud — a missing method throws
 * in `apply()` and the framework abdicates the half — and the fix starts in
 * `~/.dsh/tasks/lesson.md`, not in a silent patch.
 */

/** One slot contribution's registration options. */
export interface DshSlotRegistration {
  readonly name: string;
  readonly id?: string;
  readonly key?: string;
  readonly order?: number;
  readonly label?: string | (() => string);
  readonly inject?: () => Record<string, unknown>;
}

/** The `slots` service, as this plugin uses it. */
export interface DshSlotsService {
  inject(slotName: string, run: () => unknown): unknown;
  register(spec: DshSlotRegistration, component: unknown): unknown;
}

/** The restricted client context a browser half is applied with. */
export interface DshClientContext {
  readonly slots: DshSlotsService;
  readonly sessions?: unknown;
  readonly workspaces?: unknown;
  get(name: string): unknown;
}

/** A disposer returned by a registration. */
export type DshDisposable = () => void;

/** The `tools` host service, limited to the one call the host half makes. */
export interface DshToolsService {
  register(definition: DshToolDefinition): DshDisposable;
}

/** One block of tool content, as `output.render` returns it. */
export interface DshContentBlock {
  readonly type: 'text';
  readonly text: string;
}

/**
 * A JSON value, as the tool registry moves it.
 *
 * The registry requires a tool's `execute` to return JSON: a value it cannot serialise into the
 * session log would be a tool result the model never sees. Spelling the type out is what makes
 * that a compile error instead of a surprise at runtime.
 */
export type DshJson = null | boolean | number | string | DshJson[] | { [key: string]: DshJson };

/** The run context a tool's `execute` receives. */
export interface DshToolRunContext {
  readonly agent?: { readonly id: string; readonly session: { append(type: string, data: unknown): void } };
  readonly signal?: AbortSignal;
}

/**
 * A tool definition, in the shape `ctx.tools.register` accepts.
 *
 * `@deepseek-ai/dsh-tool-todo` wraps the same object in `defineTool`, which is a thin identity
 * helper; we pass the literal because that package is not resolvable here. P-B observes whether
 * the literal is accepted.
 */
export interface DshToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: Record<string, unknown>;
    render(args: unknown, value: DshJson): DshContentBlock[];
  };
  execute(args: unknown, exec: DshToolRunContext): Promise<DshJson>;
  isConcurrencySafe?(args: unknown): boolean;
  presentCall?(args: unknown): { card: 'generic'; title: string; kind?: string; rawInput?: unknown };
}

/** The `skills` host service, limited to the one call the host half makes. */
export interface DshSkillsService {
  register(skill: {
    readonly name: string;
    readonly description: string;
    readonly whenToUse?: string;
    readonly content: string;
    readonly invocation?: { readonly modelInvocable: boolean; readonly userInvocable: boolean };
  }): DshDisposable;
}

/** One registered HTTP route, exactly as `dsh-client-connection` registers its own. */
export interface DshWebRoute {
  readonly kind: 'exact' | 'prefix';
  readonly path: string;
  handler(req: DshIncomingMessage, res: DshServerResponse): void | Promise<void>;
}

/** The `webServer` host service, limited to the two calls the host half makes. */
export interface DshWebServerService {
  register(route: DshWebRoute): DshDisposable;
  tapIndex(transform: (html: string) => string): DshDisposable;
}

/** The `node:http` request, structurally typed so this file needs no `node:http` import. */
export interface DshIncomingMessage {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (chunk?: Uint8Array) => void): unknown;
}

/** The `node:http` response, structurally typed for the same reason. */
export interface DshServerResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(body?: string): unknown;
}

/** The host context a half is applied with — the Cordis service locator. */
export interface DshHostContext {
  get(name: string): unknown;
  effect(callback: () => DshDisposable, label?: string): DshDisposable;
  readonly tools: DshToolsService;
  readonly skills: DshSkillsService;
}
