/**
 * The panel's stylesheet, as one string.
 *
 * Inline and injected by the panel rather than shipped as a CSS file, because the client bundle is
 * a single script with no asset pipeline: there is nowhere to put a `.css` file that the module
 * loader would fetch, and a `<link>` to a path that does not exist fails silently.
 *
 * Every colour comes from a theme token with a literal fallback, so the board follows the app's
 * light/dark theme instead of fighting it, and nothing here hardcodes a background. The `kb-` prefix
 * keeps it from colliding with the app's own rules.
 */
export const STYLES = `
.kb-page { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 10px; padding: 14px 16px 18px;
  font: 13px/1.5 var(--dsh-font-family, ui-sans-serif, system-ui); color: var(--dsh-color-text, inherit); }
.kb-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.kb-title { font-size: 18px; font-weight: 600; margin: 0; }
.kb-sub { opacity: 0.6; font-family: var(--dsh-font-mono, ui-monospace, monospace); }
.kb-spacer { flex: 1 1 auto; }
.kb-btn { border: 1px solid var(--dsh-color-border, rgba(128,128,128,0.35)); background: transparent; color: inherit;
  border-radius: 7px; padding: 3px 9px; cursor: pointer; font: inherit; line-height: 1.4; }
.kb-btn:hover { background: var(--dsh-color-surface-hover, rgba(128,128,128,0.12)); }
.kb-btn[aria-pressed="true"] { border-color: var(--dsh-color-accent, #4c8bf5); color: var(--dsh-color-accent, #4c8bf5); }
.kb-btn:disabled { opacity: 0.5; cursor: default; }
.kb-chip { border: 1px solid var(--dsh-color-border, rgba(128,128,128,0.3)); border-radius: 999px; padding: 1px 8px; font-size: 12px; }
.kb-chip-kb { background: var(--dsh-color-surface-hover, rgba(128,128,128,0.1)); }
.kb-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.kb-notice { border: 1px solid var(--dsh-color-border, rgba(128,128,128,0.35)); border-left-width: 3px; border-radius: 7px;
  padding: 7px 11px; display: flex; gap: 10px; align-items: baseline; }
.kb-notice-refusal { border-left-color: var(--dsh-color-danger, #d64545); }
.kb-notice-info { border-left-color: var(--dsh-color-accent, #4c8bf5); }
.kb-notice-error { border-left-color: var(--dsh-color-danger, #d64545); }
.kb-notice-missing { font-family: var(--dsh-font-mono, ui-monospace, monospace); opacity: 0.8; }
.kb-lanes { display: flex; gap: 10px; overflow-x: auto; align-items: flex-start; flex: 1 1 auto; min-height: 120px; padding-bottom: 6px; }
.kb-lane { flex: 0 0 236px; display: flex; flex-direction: column; gap: 7px; border: 1px solid var(--dsh-color-border, rgba(128,128,128,0.28));
  border-radius: 10px; padding: 9px; background: var(--dsh-color-surface, rgba(128,128,128,0.04)); min-height: 90px; }
.kb-lane-over { outline: 2px dashed var(--dsh-color-accent, #4c8bf5); outline-offset: -3px; }
.kb-lane-head { display: flex; align-items: baseline; gap: 7px; }
.kb-lane-name { font-weight: 600; }
.kb-lane-count { opacity: 0.65; font-family: var(--dsh-font-mono, ui-monospace, monospace); }
.kb-lane-over-limit .kb-lane-count { color: var(--dsh-color-danger, #d64545); opacity: 1; }
.kb-cards { display: flex; flex-direction: column; gap: 7px; min-height: 36px; }
.kb-card { border: 1px solid var(--dsh-color-border, rgba(128,128,128,0.32)); border-radius: 8px; padding: 7px 9px;
  background: var(--dsh-color-background, transparent); cursor: grab; display: flex; flex-direction: column; gap: 5px; }
.kb-card:hover { border-color: var(--dsh-color-accent, #4c8bf5); }
.kb-card:focus-visible { outline: 2px solid var(--dsh-color-accent, #4c8bf5); outline-offset: 1px; }
.kb-card-expedite { border-left: 3px solid var(--dsh-color-danger, #d64545); }
.kb-card-blocked { border-left: 3px solid var(--dsh-color-warning, #d68945); }
.kb-card-top { display: flex; gap: 7px; align-items: baseline; }
.kb-card-id { font-family: var(--dsh-font-mono, ui-monospace, monospace); opacity: 0.7; font-size: 12px; }
.kb-card-title { flex: 1 1 auto; }
.kb-card-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 12px; opacity: 0.85; }
.kb-pri { font-weight: 600; font-family: var(--dsh-font-mono, ui-monospace, monospace); }
.kb-pri-p0 { color: var(--dsh-color-danger, #d64545); }
.kb-pri-p1 { color: var(--dsh-color-warning, #d68945); }
.kb-age-ageing { color: var(--dsh-color-warning, #d68945); }
.kb-age-stale { color: var(--dsh-color-danger, #d64545); font-weight: 600; }
.kb-drawer { border: 1px solid var(--dsh-color-border, rgba(128,128,128,0.35)); border-radius: 10px; padding: 12px 14px;
  display: flex; flex-direction: column; gap: 9px; max-height: 46%; overflow: auto; }
.kb-drawer-head { display: flex; gap: 10px; align-items: baseline; }
.kb-checks { display: flex; flex-direction: column; gap: 3px; }
.kb-check { display: flex; gap: 8px; align-items: center; cursor: pointer; }
.kb-check-missing { color: var(--dsh-color-warning, #d68945); }
.kb-mono { font-family: var(--dsh-font-mono, ui-monospace, monospace); word-break: break-word; }
.kb-input { border: 1px solid var(--dsh-color-border, rgba(128,128,128,0.35)); background: transparent; color: inherit;
  border-radius: 7px; padding: 3px 8px; font: inherit; min-width: 140px; }
.kb-metrics { display: flex; gap: 14px; flex-wrap: wrap; font-family: var(--dsh-font-mono, ui-monospace, monospace); font-size: 12px; }
.kb-metrics b { font-weight: 600; }
.kb-list { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
.kb-dim { opacity: 0.65; }
.kb-empty { opacity: 0.6; padding: 10px 2px; }
`;

/** The id the panel's own stylesheet is injected under, so it is added exactly once. */
export const STYLE_ID = 'dsh-kanban-styles';
