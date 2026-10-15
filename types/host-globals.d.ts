/**
 * The host half's ambient build facts.
 *
 * `__BUILD_ID__` is replaced textually by `build.mjs`'s `define`. It is declared here rather
 * than in `types/dsh.d.ts` because that file is a module, and a global declaration in a module
 * is not visible to the files that need it. This file is included only by the host project, so
 * it can never collide with the browser half's own globals.
 */
declare const __BUILD_ID__: string;
