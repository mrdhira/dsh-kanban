/**
 * Headless visual capture of the kanban panel — both themes, two widths, one PNG each.
 *
 * Why this exists: every visual review so far came from a human screenshot, and every one of them was
 * dark. The light theme had never been looked at, and the running app has no
 * `--remote-debugging-port` and must not be restarted. So instead of screenshotting the app, this
 * renders the panel's **real DOM and real CSS** off-screen.
 *
 * How it stays honest:
 *
 * - the markup comes from `test/harness.ts` — the same `loadBundle()` / `boardPayload()` / `mount(...)`
 *   path `test/client.dom.test.ts` uses: the real bundle, the real transport, the real store, with
 *   only `fetch` faked. Nothing here re-implements the harness or hand-writes a mock;
 * - the stylesheet is the panel's own `STYLES` string read out of the built bundle (the harness does
 *   not export it, so the template literal is scanned directly);
 * - the `--dsw-*` tokens are the app's own declarations, extracted from the shipped `app.asar` and
 *   resolved `var()` chain by chain, so the capture does not depend on the app being alive;
 * - the token block carries the **same selector as the app's own block** (`body` for light,
 *   `body[data-ds-dark-theme]` for dark) and the dark page sets that marker on `<body>` exactly as
 *   the app does. A block keyed on something else, with no marker present, made every panel rule
 *   scoped to the app's dark marker inert in the capture; the `[scoped]` probe below now asserts the
 *   dark rules resolve to the dark tokens in the dark page and not in the light one.
 *
 * Two things it deliberately does **not** model, so nobody reads more into a PNG than is there:
 *
 * - the markup is `innerHTML`, so a `<select>` serialises its first option rather than the value it
 *   is bound to — read a select's state from the code, not from the capture;
 * - the panel is rendered on its own: the app shell's column layout is not reproduced, so the PNG
 *   shows the panel's own geometry and not where the shell would put it.
 *
 * Run (through the guard, as every node run must be):
 *   node ~/.dsh/scripts/guard/guard.mjs --limit-mb 2560 -- \
 *     node --max-old-space-size=384 \
 *     ~/.dsh/profiles/desktop/plugins/dsh-kanban/scripts/capture-panel.mts
 *
 * The cap is 2560 MB, not 1024 MB, for a measured reason rather than a convenience one: this script's
 * own Node half peaks at ~130 MB RSS, but the headless Chrome it spawns needs ~1.35 GB of process tree
 * on macOS just to start (measured: 1639 MB with default flags, 1352 MB with the `--disable-*` flags
 * below). That floor is Chrome's, not a leak here — a 1024 MB cap kills the tree before a single
 * screenshot is written, and no Chrome flag tried (including `--single-process`, which never renders)
 * brings it under. The cap still protects the run: a genuine leak would blow far past 2.5 GB. A full
 * run — the `[scoped]` probe and four screenshots — measured 1887 MB peak, since each Chrome is
 * sequential and the guard reports the tree's high-water mark rather than the sum.
 *
 * Nothing is cached and nothing is snapshotted: the bundle, the harness and the asar are read fresh,
 * so the script can be re-run after any client change.
 */
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, mkdirSync, readSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boardPayload, flush, freshStore, loadBundle, mount, respondWithBoard } from '../test/harness.ts';

// ------------------------------------------------------------------ paths

const HERE = new URL('..', import.meta.url);
const BUNDLE_PATH = fileURLToPath(new URL('lib/v1/client.js', HERE));
const ASAR_PATH = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = '/Users/dhirawigata/.dsh/logs/kanban';
const TEMP_DIR = join(tmpdir(), `dsh-kanban-capture-${process.pid}`);

/**
 * Anchor for the app's design-platform CSS string, and the two selectors inside it.
 *
 * A **light** theme is the plain `body` rule; the **dark** theme is the `body[data-ds-dark-theme]`
 * override — confirmed by the values themselves, not by the selector alone: the plain `body` block
 * resolves `--dsw-alias-bg-base` to `#fff` (a near-white background, therefore light) while the
 * `[data-ds-dark-theme]` block resolves it to `#151517`. Both resolutions are printed at run time so
 * the assignment is auditable.
 *
 * The marker is the exported binding name, not a bare `body{--dsw-static-amber-100`: that same prefix
 * appears inside the *earlier* `base_css_default` string too, so a bare marker silently reads the
 * wrong string and every `--dsw-static-*` primitive then looks undefined.
 */
const DESIGN_PLATFORM_MARKER = 'var design_platform_css_default = "';
const LIGHT_SELECTOR = 'body';
const DARK_SELECTOR = 'body[data-ds-dark-theme]';

const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];
const SIZES: ReadonlyArray<{ width: number; height: number }> = [
  { width: 1000, height: 900 },
  { width: 1600, height: 900 },
];

// ------------------------------------------------------------------ the panel's own stylesheet

/**
 * Pull `STYLES` out of the built bundle.
 *
 * The bundle is a plain `window.__ModuleLoader__.load(...)` script, not a module, so `STYLES` cannot
 * be imported. It is assigned a single template literal with no interpolation and no escapes — checked
 * here, and the check throws rather than returning a mangled stylesheet — so scanning is faithful.
 */
function readStyles(): string {
  const source = readFileSync(BUNDLE_PATH, 'utf8');
  const at = source.indexOf('STYLES = `');
  if (at < 0) throw new Error('lib/v1/client.js no longer assigns STYLES a template literal');
  const start = source.indexOf('`', at) + 1;
  const end = source.indexOf('`', start);
  if (end < 0) throw new Error('unterminated STYLES template literal');
  const literal = source.slice(start, end);
  if (literal.includes('${') || literal.includes('\\')) {
    throw new Error('STYLES now contains interpolation or escapes; scan it properly instead of slicing');
  }
  return literal;
}

/** The `--dsw-*` tokens the panel actually references, so only those need resolving. */
function referencedTokens(styles: string): string[] {
  const names = new Set<string>();
  for (const match of styles.matchAll(/var\((--dsw-[a-z0-9-]+)/g)) names.add(match[1] as string);
  return [...names].sort();
}

// ------------------------------------------------------------------ the app's theme tokens

/**
 * Read a window of the asar by offset, in bounded chunks — the file is 116 MB and must never be
 * loaded whole.
 */
function readWindow(fd: number, start: number, length: number): string {
  const size = statSync(ASAR_PATH).size;
  const from = Math.max(0, start);
  const to = Math.min(size, start + length);
  const buffer = Buffer.allocUnsafe(to - from);
  let filled = 0;
  while (filled < to - from) {
    const got = readSync(fd, buffer, filled, to - from - filled, from + filled);
    if (got <= 0) break;
    filled += got;
  }
  return buffer.subarray(0, filled).toString('utf8');
}

/** Locate a marker with a chunked scan, returning its absolute byte offset or -1. */
function findMarker(fd: number, marker: string): number {
  const needle = Buffer.from(marker, 'utf8');
  const size = statSync(ASAR_PATH).size;
  const CHUNK = 4 * 1024 * 1024;
  let position = 0;
  let tail = Buffer.alloc(0);
  while (position < size) {
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK, size - position));
    const got = readSync(fd, buffer, 0, buffer.length, position);
    if (got <= 0) break;
    const haystack = Buffer.concat([tail, buffer.subarray(0, got)]);
    const found = haystack.indexOf(needle);
    if (found >= 0) return position - tail.length + found;
    tail = haystack.subarray(Math.max(0, haystack.length - (needle.length - 1)));
    position += got;
  }
  return -1;
}

/**
 * The index just past a JS string body, honouring backslash escapes.
 *
 * A plain search for `";` is not safe here: a CSS value may legitimately contain a quote, and then the
 * "end" would land inside the string and truncate it. Escapes are handled so an escaped quote does not
 * end the scan.
 */
function findStringEnd(body: string): number {
  for (let index = 0; index < body.length; index += 1) {
    const ch = body[index] as string;
    if (ch === '\\') {
      index += 1;
      continue;
    }
    if (ch === '"') return index;
  }
  throw new Error('unterminated CSS string in the app bundle');
}

/**
 * Split a CSS string into `selector -> declarations`, at any nesting depth.
 *
 * A naive "next `}` ends the rule" scan is wrong here: the design-platform string contains nested
 * `@media` blocks, so the first `}` may close an inner rule, not the outer one. Walking with a depth
 * counter picks up the declarations inside those nested blocks too, which is where the
 * `--dsw-static-*` primitive tier partly lives.
 *
 * A selector may be addressed by **more than one rule** — this build declares `body` twice, once for
 * the `--dsw-static-*` primitives and once for the `--dsw-alias-*` layer on top of them. Duplicates are
 * therefore merged in declaration order (later wins) rather than replacing each other; replacing was a
 * real bug here, and it left every `var(--dsw-static-…)` chain unresolved.
 *
 * Braces inside quoted strings are deliberately **not** special-cased: this build's token values are
 * hex colours, `var()` chains and `color-mix()` calls, none of which contain a brace, while a quote
 * that never closes would make a quote-aware walk run past the end and report a perfectly balanced
 * string as unbalanced.
 */
function parseRules(css: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  let selectorStart = 0;
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf('{', cursor);
    if (open < 0) break;
    let depth = 1;
    let scan = open + 1;
    while (scan < css.length && depth > 0) {
      const ch = css[scan] as string;
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      scan += 1;
    }
    if (depth !== 0) {
      throw new Error(`unbalanced braces in the app CSS string around ${JSON.stringify(css.slice(selectorStart, open + 40))}`);
    }
    const selector = css.slice(selectorStart, open).trim();
    let declarations = rules.get(selector);
    if (declarations === undefined) {
      declarations = new Map<string, string>();
      rules.set(selector, declarations);
    }
    for (const match of css.slice(open + 1, scan - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
      declarations.set(match[1] as string, (match[2] as string).trim());
    }
    selectorStart = scan;
    cursor = scan;
  }
  return rules;
}

/**
 * Extract both theme blocks from the app bundle.
 *
 * Each theme is one quoted CSS string, so a block ends at the first `";` after its marker — brace
 * counting would break the moment a gradient value contained a `}`.
 */
function readThemeTokens(): {
  light: Map<string, string>;
  dark: Map<string, string>;
  offset: { light: number; dark: number };
} {
  const fd = openSync(ASAR_PATH, 'r');
  try {
    const start = findMarker(fd, DESIGN_PLATFORM_MARKER);
    if (start < 0) throw new Error(`the design-platform CSS string (${DESIGN_PLATFORM_MARKER}) is no longer in the asar`);

    // One chunk covers the whole ~19 KB string with room to spare, so the read is bounded and the
    // 116 MB file is never held. The window opens just after the marker's opening quote, which is the
    // last character of the marker.
    const window = readWindow(fd, start + DESIGN_PLATFORM_MARKER.length, 240 * 1024);
    const stringEnd = findStringEnd(window);
    // The string already begins with `body{...}` (the plain, i.e. light, selector), so it is parsed
    // verbatim — prepending a wrapper would turn it into `body{body{...}` and leave one brace unclosed.
    const rules = parseRules(window.slice(0, stringEnd));

    /**
     * A theme's complete token set: the `body` / `body[data-ds-dark-theme]` rule holds the
     * `--dsw-alias-*` layer, but those values point at `--dsw-static-*` primitives. In this build both
     * tiers live in this one CSS string (the string merely *starts* with the light primitives, because
     * the first selector prefix is empty), so the honest merge is every declaration in the string, with
     * the theme's own selector winning on any name defined in both.
     */
    const themeTokens = (selector: string): { all: Map<string, string>; own: Map<string, string> } => {
      const all = new Map<string, string>();
      for (const declarations of rules.values()) {
        for (const [name, value] of declarations) all.set(name, value);
      }
      const own = new Map<string, string>();
      for (const [found, declarations] of rules) {
        if (found !== selector) continue;
        for (const [name, value] of declarations) own.set(name, value);
      }
      if (own.size === 0) throw new Error(`no declarations for selector "${selector}" in the design-platform string`);
      for (const [name, value] of own) all.set(name, value);
      return { all, own };
    };

    const light = themeTokens(LIGHT_SELECTOR);
    const dark = themeTokens(DARK_SELECTOR);
    return {
      light: light.all,
      dark: dark.all,
      offset: { light: start, dark: start },
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolve a token to a concrete CSS value, following `var()` references.
 *
 * Returns `null` rather than a guess when the chain cannot be followed; the caller then gives up on
 * that token so the panel's own literal fallback applies instead.
 */
function resolve(token: string, tokens: Map<string, string>): string | null {
  const seen = new Set<string>();
  let current = tokens.get(token);
  while (current !== undefined) {
    const variable = /^var\((--[\w-]+)(?:\s*,\s*(.+))?\)$/.exec(current.trim());
    if (variable === null) break;
    const next = variable[1] as string;
    if (seen.has(next)) return null;
    seen.add(next);
    const value = tokens.get(next);
    if (value === undefined) return null;
    current = value;
  }
  return current ?? null;
}

// ------------------------------------------------------------------ render + capture

/** The board `test/client.dom.test.ts` renders: one refined backlog card, one ready, two in progress, one done. */
function fixture(): Record<string, unknown> {
  const fullDor = Object.fromEntries(
    ['outcome', 'acceptance', 'write-scope', 'estimate'].map((id) => [id, { at: '2026-10-01T00:00:00.000Z', by: 'human:dhira' }])
  );
  const payload = boardPayload();
  const tasks = (payload.tasks as Record<string, unknown>[]).map((task) =>
    task.id === 'T-001' ? { ...task, dor: fullDor } : task
  );
  // A dropped card, so the `Dropped` view has something to show. The board itself still draws five
  // lanes: this card is in the store and nowhere on the default board, which is the whole reason the
  // view exists.
  const dropped = { ...(tasks[0] as Record<string, unknown>), id: 'T-006', title: 'card T-006', state: 'dropped', droppedReason: 'superseded', position: 0 };
  return { ...payload, tasks: [...tasks, dropped], total: tasks.length + 1 };
}

/**
 * Mount the real panel and return its rendered markup. `respondWithBoard` + `flush` as the DOM test does.
 *
 * `filter` is applied to the store before the first paint, so one run can capture the default board
 * and the `Dropped` view without a second headless Chrome pass. `window.__DSH_TRANSPORT__` is what
 * the bundle reads for the host origin; leaving it unset is fine because the fake `fetch` answers.
 */
async function renderMarkup(filter?: Record<string, unknown>): Promise<string> {
  const loaded = loadBundle();
  respondWithBoard(fixture());
  const store = freshStore(loaded) as { setFilter(next: Record<string, unknown>): void };
  if (filter !== undefined) store.setFilter(filter);
  const view = mount(loaded, loaded.slot('main'), { store });
  await flush();
  const markup = view.container.innerHTML;
  if (markup.trim().length === 0) throw new Error('the panel rendered nothing');
  if (filter !== undefined && !markup.includes('data-lane="dropped"')) {
    throw new Error('the Dropped view rendered without its lane — the filter did not reach the board');
  }
  view.unmount();
  return markup;
}

/**
 * The dark-scoped rules the capture must show working, and the token each must resolve to.
 *
 * These are the rules that shipped dead: they are keyed on `body[data-ds-dark-theme]`, the app's own
 * marker. If the marker is not on `<body>`, or the injected token block outranks them, the computed
 * colour is the light one — which is exactly the failure the PNGs alone did not reveal.
 */
const SCOPED_PROBES: ReadonlyArray<{ selector: string; light: string; dark: string }> = [
  { selector: '.kb-age-ageing', light: '--dsw-alias-label-primary', dark: '--dsw-alias-state-warn-primary' },
  { selector: '.kb-sub', light: '--dsw-alias-label-secondary', dark: '--dsw-alias-label-tertiary' },
];

/** A resolved hex token as the `rgb(r, g, b)` string `getComputedStyle().color` returns. */
function cssColor(value: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex === null) return value.trim();
  const digits = hex[1] as string;
  const full = digits.length === 3 ? digits.replace(/./g, (digit) => digit + digit) : digits;
  const int = Number.parseInt(full, 16);
  return `rgb(${(int >> 16) & 0xff}, ${(int >> 8) & 0xff}, ${int & 0xff})`;
}

function htmlDocument(args: {
  theme: Theme;
  tokens: Map<string, string>;
  styles: string;
  markup: string;
  /** Add the script that reports computed colours, for the cascade probe (not used for a screenshot). */
  probe?: boolean;
}): { html: string; unresolved: string[] } {
  const declarations: string[] = [];
  const unresolved: string[] = [];
  for (const token of referencedTokens(args.styles)) {
    const value = resolve(token, args.tokens);
    if (value === null) unresolved.push(token);
    else declarations.push(`  ${token}: ${value};`);
  }

  // The token block uses the **app's own selector**: `body` for light, `body[data-ds-dark-theme]` for
  // dark, with the dark page carrying that marker on `<body>` exactly as the app does. The first
  // version keyed it on `html[data-dsh-theme]` and never set the marker, so every panel rule scoped
  // to the app's dark marker was inert in the capture — the theme came only from the injected values,
  // and the cascade the app actually has was not modelled at all.
  const tokenSelector = args.theme === 'dark' ? 'body[data-ds-dark-theme]' : 'body';
  const bodyMarker = args.theme === 'dark' ? ' data-ds-dark-theme' : '';
  const probeScript = args.probe
    ? `
<script>
window.addEventListener('DOMContentLoaded', function () {
  var selectors = ${JSON.stringify(SCOPED_PROBES.map((entry) => entry.selector))};
  var out = {};
  for (var i = 0; i < selectors.length; i += 1) {
    var node = document.querySelector(selectors[i]);
    out[selectors[i]] = node === null ? null : getComputedStyle(node).color;
  }
  var pre = document.createElement('pre');
  pre.id = 'dsh-capture-probe';
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
});
</script>`
    : '';

  // `data-dsh-theme` stays on `<html>` as a label for the file; no rule keys on it any more.
  const html = `<!doctype html>
<html data-dsh-theme="${args.theme}">
<head>
<meta charset="utf-8" />
<style>
${tokenSelector} {
${declarations.join('\n')}
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
body { background: var(--dsw-alias-bg-base, #fff); font-family: ui-sans-serif, -apple-system, "Helvetica Neue", Arial, sans-serif; }
#root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
#root > * { flex: 1 1 auto; min-height: 0; }
${args.styles}
</style>
</head>
<body${bodyMarker}>
<div id="root">${args.markup}</div>${probeScript}
</body>
</html>
`;
  return { html, unresolved };
}

/**
 * Screenshot one HTML file with headless Chrome.
 *
 * The extra `--disable-*` flags are not cosmetic: they shave ~300 MB off Chrome's macOS process tree
 * (measured 1639 MB → 1352 MB for a blank page), which matters because the guard caps the whole tree.
 */
function screenshot(file: string, out: string, width: number, height: number): void {
  const result = spawnSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--disable-extensions',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-component-update',
      '--disable-background-networking',
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      '--run-all-compositor-stages-before-draw',
      '--virtual-time-budget=2000',
      `file://${file}`,
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`headless Chrome exited ${String(result.status)}: ${(result.stderr ?? '').split('\n').slice(-3).join(' ')}`);
  }
}

/** A PNG's real pixel dimensions, so a capture that silently rendered at the wrong size cannot pass. */
function pngSize(path: string): { width: number; height: number; bytes: number } {
  const buffer = readFileSync(path);
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path} is not a PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer.length };
}

/**
 * Run the probe page and read the computed colours it reported.
 *
 * `--dump-dom` executes the page's own script and prints the resulting DOM, so this needs no debug
 * port and no second process tree beyond one Chrome invocation. A missing `<pre>` means the script
 * never ran, which is a failure rather than an empty result.
 */
function probeComputed(file: string): Record<string, string | null> {
  const result = spawnSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-component-update',
      '--disable-background-networking',
      '--virtual-time-budget=3000',
      '--dump-dom',
      `file://${file}`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(`the computed-style probe exited ${String(result.status)}: ${(result.stderr ?? '').split('\n').slice(-3).join(' ')}`);
  }
  const match = /<pre id="dsh-capture-probe">([^<]*)<\/pre>/.exec(result.stdout ?? '');
  if (match === null) throw new Error(`the computed-style probe did not run in ${file}`);
  return JSON.parse(match[1] as string) as Record<string, string | null>;
}


async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('this capture assumes the macOS Chrome path');
  statSync(CHROME); // fail loudly and early if Chrome is not where the task says it is

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });

  const styles = readStyles();
  const referenced = referencedTokens(styles);
  const tokens = readThemeTokens();

  // The light/dark assignment is asserted from the values, not from the selector name: a near-white
  // background is the light theme whatever it is called. If the bundle ever swaps them, this throws
  // instead of writing two mislabelled PNGs.
  const lightBase = resolve('--dsw-alias-bg-base', tokens.light);
  const darkBase = resolve('--dsw-alias-bg-base', tokens.dark);
  console.log(`[tokens] design-platform CSS string at byte ${String(tokens.offset.light)} (${String(tokens.light.size)} tokens light, ${String(tokens.dark.size)} dark)`);
  console.log(`[tokens] ${LIGHT_SELECTOR} -> --dsw-alias-bg-base => ${String(lightBase)}`);
  console.log(`[tokens] ${DARK_SELECTOR} -> --dsw-alias-bg-base => ${String(darkBase)}`);
  if (lightBase === null || darkBase === null) throw new Error('could not resolve --dsw-alias-bg-base in both themes');
  const luminance = (value: string): number => {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
    if (hex === null) return Number.NaN;
    const digits = hex[1] as string;
    const full = digits.length === 3 ? digits.replace(/./g, (d) => d + d) : digits;
    const int = Number.parseInt(full, 16);
    return ((int >> 16) & 0xff) + ((int >> 8) & 0xff) + (int & 0xff);
  };
  if (!(luminance(lightBase) > luminance(darkBase))) {
    throw new Error(`light/dark look swapped: ${LIGHT_SELECTOR}=${lightBase} is not lighter than ${DARK_SELECTOR}=${darkBase}`);
  }
  console.log(`[tokens] light vs dark decided by the resolved background: ${lightBase} (near-white, light) vs ${darkBase} (dark).`);
  console.log(`[styles] STYLES read from ${BUNDLE_PATH} (${String(styles.length)} chars); ${String(referenced.length)} --dsw-* tokens referenced`);

  const markup = await renderMarkup();
  console.log(`[render] panel markup: ${String(markup.length)} chars, ${String((markup.match(/data-card=/g) ?? []).length)} cards`);
  // The one view this pass added, rendered for real: the dropped lane, its card, and the toolbar
  // button that reaches it. Captured alongside the board so a visual review can see the new surface
  // in both themes rather than take the DOM suite's word for it.
  const droppedMarkup = await renderMarkup({ state: ['dropped'] });
  console.log(`[render] dropped-view markup: ${String(droppedMarkup.length)} chars`);

  const written: string[] = [];
  const unresolvedReport: string[] = [];

  for (const theme of THEMES) {
    const themeTokens = theme === 'light' ? tokens.light : tokens.dark;
    const document = htmlDocument({ theme, tokens: themeTokens, styles, markup });
    for (const token of document.unresolved) {
      unresolvedReport.push(`${theme}: ${token}`);
    }
    const htmlPath = join(TEMP_DIR, `panel-${theme}.html`);
    writeFileSync(htmlPath, document.html, 'utf8');

    // Prove the marker reached `<body>` and the panel's dark-scoped rules are live: the same document
    // plus a script that reports the computed colour of two rules keyed on the app's dark marker.
    // In light each must resolve to a light token; in dark, to a different dark token. A dead marker
    // or a token block that outranked the panel's own rules makes the two themes agree, and this
    // throws instead of writing a dark PNG that is really light.
    const probePath = join(TEMP_DIR, `panel-${theme}-probe.html`);
    writeFileSync(probePath, htmlDocument({ theme, tokens: themeTokens, styles, markup, probe: true }).html, 'utf8');
    const computed = probeComputed(probePath);
    for (const entry of SCOPED_PROBES) {
      const expected = resolve(theme === 'dark' ? entry.dark : entry.light, themeTokens);
      if (expected === null) throw new Error(`cannot resolve the ${theme} token for ${entry.selector}`);
      const expectedCss = cssColor(expected);
      const actual = computed[entry.selector];
      if (actual !== expectedCss) {
        throw new Error(
          `${theme}: ${entry.selector} computed ${String(actual)}, expected ${expectedCss} from ${theme === 'dark' ? entry.dark : entry.light} — the dark marker is not scoping the capture`
        );
      }
      console.log(`[scoped] ${theme.padEnd(5)} ${entry.selector} -> ${String(actual)} (${theme === 'dark' ? entry.dark : entry.light})`);
    }

    for (const { width, height } of SIZES) {
      const out = join(OUT_DIR, `capture-${theme}-${String(width)}.png`);
      screenshot(htmlPath, out, width, height);
      const png = pngSize(out);
      if (png.bytes < 1500) throw new Error(`${out} is only ${String(png.bytes)} bytes — the capture looks blank`);
      if (png.width !== width || png.height !== height) {
        throw new Error(`${out} is ${String(png.width)}x${String(png.height)}, expected ${String(width)}x${String(height)}`);
      }
      written.push(`capture-${theme}-${String(width)}.png  ${String(png.bytes)} bytes  ${String(png.width)}x${String(png.height)}  ${out}`);
    }

    // One extra shot per theme at the wider size: the `Dropped` view. The narrow size keeps the two
    // board captures it always had, so the pass stays one headless Chrome per file rather than four.
    const droppedDoc = htmlDocument({ theme, tokens: themeTokens, styles, markup: droppedMarkup });
    for (const token of droppedDoc.unresolved) unresolvedReport.push(`dropped ${theme}: ${token}`);
    const droppedPath = join(TEMP_DIR, `panel-${theme}-dropped.html`);
    writeFileSync(droppedPath, droppedDoc.html, 'utf8');
    const droppedOut = join(OUT_DIR, `capture-${theme}-dropped-1600.png`);
    screenshot(droppedPath, droppedOut, 1600, 900);
    const droppedPng = pngSize(droppedOut);
    if (droppedPng.bytes < 1500) throw new Error(`${droppedOut} is only ${String(droppedPng.bytes)} bytes — the capture looks blank`);
    written.push(`capture-${theme}-dropped-1600.png  ${String(droppedPng.bytes)} bytes  ${String(droppedPng.width)}x${String(droppedPng.height)}  ${droppedOut}`);
  }

  console.log(`\n[html] ${TEMP_DIR}/panel-<theme>.html (and panel-<theme>-probe.html for the [scoped] check)`);
  for (const line of written) console.log(`[png ] ${line}`);
  console.log(`\n[summary] ${String(written.length)} PNGs written`);
  for (const line of written) console.log(`  ${line}`);

  if (unresolvedReport.length > 0) {
    console.log('\n[fallback] tokens that could not be resolved (the panel\'s own literal fallback applies):');
    for (const line of unresolvedReport) console.log(`  ${line}`);
  } else {
    console.log(`\n[fallback] all ${String(referenced.length)} referenced tokens resolved from the app bundle; no fallbacks used`);
  }

  // Keep the temp HTML when asked to, otherwise it is regenerated on every run anyway.
  if (process.env.KANBAN_CAPTURE_KEEP_TEMP !== '1') rmSync(TEMP_DIR, { recursive: true, force: true });
}

await main();
