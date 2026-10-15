/**
 * The browser half's ambient globals.
 *
 * A DSH client module is a plain script: the loader calls the factory with its own CommonJS
 * `require`, and `build.mjs`'s banner creates the `module` the factory returns. This file is
 * included only by the browser project, which sets `types: []` so no Node global can leak in.
 */
declare const require: (name: string) => unknown;
declare const module: { exports: unknown };
declare const __BUILD_ID__: string;
