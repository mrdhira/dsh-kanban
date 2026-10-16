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
:root { --kb-lane-width: 236px; --kb-measure: 62ch; --kb-radius-control: 7px; --kb-radius-card: 8px; --kb-radius-panel: 10px; }
.kb-page { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 10px; padding: 14px 16px 18px;
  font: 13px/1.5 inherit; color: var(--dsw-alias-label-primary, inherit); }
.kb-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; line-height: 1.4; }
.kb-title { font-size: 18px; font-weight: 600; margin: 0; line-height: 1.25; }
.kb-sub { color: var(--dsw-alias-label-secondary, rgba(128,128,128,0.9));
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.kb-spacer { flex: 1 1 auto; }
.kb-btn { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); background: transparent; color: inherit;
  border-radius: var(--kb-radius-control, 7px); padding: 3px 9px; cursor: pointer; font: inherit; line-height: 1.4; transition: background-color 140ms ease-out, border-color 140ms ease-out, transform 140ms ease-out; }
.kb-btn:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12)); }
.kb-btn:active { transform: translateY(1px); }
/* Pressed is a tint plus weight, never a colour on its own.
   The app resolves --dsw-alias-brand-primary to a near-white neutral in dark, so a pressed
   *background* of it painted body-white while the unselected button read stronger. The heavier
   weight is the cue that survives both themes and a greyscale screenshot. */
.kb-btn[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12));
  border-color: var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, rgba(128,128,128,0.5))); font-weight: 600; }
.kb-btn:disabled { opacity: 0.5; cursor: default; }
.kb-btn:disabled:hover { background: transparent; }
.kb-btn:disabled:active { transform: none; }
.kb-chip { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 999px; padding: 1px 8px; font-size: 12px; line-height: 1.5; }
.kb-chip-kb { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.1)); }
.kb-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
/* One action group per concern, so a reversible move never sits unlabelled beside Drop. */
.kb-group { display: flex; flex-direction: column; gap: 3px; }
.kb-group-danger { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); padding-top: 7px; }
.kb-notice { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); border-radius: var(--kb-radius-control, 7px);
  padding: 7px 11px; display: flex; gap: 10px; align-items: baseline; }
.kb-notice-refusal { border-color: var(--dsw-alias-state-error-primary, #d64545); }
.kb-notice-info { border-color: var(--dsw-alias-brand-primary, #4c8bf5); }
.kb-notice-error { border-color: var(--dsw-alias-state-error-primary, #d64545); }
.kb-notice-missing { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-secondary, inherit); }
.kb-lanes { display: flex; gap: 10px; overflow-x: auto; align-items: flex-start; flex: 1 1 auto; min-height: 140px; padding-bottom: 6px; }
.kb-lane { flex: 0 0 var(--kb-lane-width, 236px); display: flex; flex-direction: column; gap: 7px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28));
  border-radius: var(--kb-radius-panel, 10px); padding: 9px; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.04)); min-height: 110px; }
/* The drop target cannot rely on the brand token: in dark it resolves to a near-white neutral, so
   the ring vanished into the body. A raised tint plus a dashed secondary-label ring reads in both. */
.kb-lane-over { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12)); outline: 2px dashed var(--dsw-alias-label-secondary, currentColor); outline-offset: -3px; }
/* An empty lane is a rail, not a 236px void -- it still takes a drop, and it opens while a drag is
   live so the target is hittable exactly when it matters. */
.kb-lane-empty { flex: 0 0 46px; padding: 9px 5px; align-items: center; }
.kb-lane-empty .kb-lane-head { flex-direction: column; gap: 3px; }
.kb-lane-empty .kb-lane-name { writing-mode: vertical-rl; }
.kb-lane-empty .kb-cards { width: 100%; min-height: 48px; }
.kb-lane-empty .kb-empty { display: none; }
.kb-lane-awake { flex: 0 0 var(--kb-lane-width, 236px); padding: 9px; align-items: stretch; }
.kb-lane-awake .kb-lane-head { flex-direction: row; }
.kb-lane-awake .kb-lane-name { writing-mode: horizontal-tb; }
.kb-lane-awake .kb-empty { display: block; }
.kb-lane-head { display: flex; align-items: center; gap: 7px; line-height: 1.4; }
.kb-lane-name { font-weight: 600; }
.kb-lane-count { color: var(--dsw-alias-label-secondary, inherit); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.kb-lane-over-limit .kb-lane-count { color: var(--dsw-alias-state-error-primary, #d64545); }
.kb-cards { display: flex; flex-direction: column; gap: 7px; min-height: 36px; }
.kb-card { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.32)); border-radius: var(--kb-radius-card, 8px); padding: 7px 9px;
  background: var(--dsw-alias-bg-base, transparent); cursor: grab; display: flex; flex-direction: column; gap: 5px; }
.kb-card:hover { border-color: var(--dsw-alias-brand-primary, #4c8bf5); }
/* The expedite/blocked signal is a 1px state-coloured border, never a thick side stripe: the
   state itself is already named in the card's own content (class chip, blocked chip, priority). */
.kb-card-expedite { border-color: var(--dsw-alias-state-error-primary, #d64545); }
.kb-card-blocked { border-color: var(--dsw-alias-state-warn-primary, #d68945); }
/* Four items in a 236px lane: this row must never wrap, and no item may break mid-token -- a split
   "T-005" is exactly what a too-narrow row looks like. The words that used to sit here moved to the
   chip row below, where they wrap without breaking anything. */
.kb-card-top { display: flex; gap: 7px; align-items: baseline; flex-wrap: nowrap; }
.kb-card-top > * { white-space: nowrap; }
/* A done card and a review card are the same shape and hairline otherwise; the success tone is
   carried by a drawn mark, not by an edge. The fallback is the ordinary label colour, so a missing
   token degrades to "marked" rather than to nothing. */
.kb-mark { align-self: center; flex: 0 0 auto; color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary, inherit)); }
.kb-card-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-secondary, rgba(128,128,128,0.9)); font-size: 12px; }
.kb-card-title { flex: 1 1 auto; }
.kb-card-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
.kb-pri { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.kb-pri-p0 { color: var(--dsw-alias-state-error-primary, #d64545); }
.kb-age-stale { color: var(--dsw-alias-state-error-primary, #d64545); font-weight: 600; }
/* Capped in pixels, not as a share of the page: 46% of a one-card board took the lanes' half of
   the panel to open a single card. The lanes keep their own floor above; the drawer scrolls. */
.kb-drawer { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); border-radius: var(--kb-radius-panel, 10px); padding: 12px 14px;
  display: flex; flex-direction: column; gap: 9px; max-height: 260px; overflow: auto; }
.kb-drawer-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; line-height: 1.4; }
.kb-checks { display: flex; flex-direction: column; gap: 3px; }
.kb-check { display: flex; gap: 8px; align-items: center; cursor: pointer; }
.kb-check-glyph { flex: 0 0 auto; }
/* Long prose (the acceptance line) reads at a sane measure instead of running the drawer's width. */
.kb-prose { max-width: var(--kb-measure, 62ch); text-wrap: pretty; }
.kb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-word; }
.kb-input { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); background: transparent; color: inherit;
  border-radius: var(--kb-radius-control, 7px); padding: 3px 8px; font: inherit; min-width: 140px; transition: background-color 140ms ease-out, border-color 140ms ease-out; }
/* A select is a value picker, not a text box: it does not need the search field's width. */
select.kb-input { min-width: 0; padding-right: 4px; }
input[type="number"].kb-input { min-width: 76px; }
.kb-input::placeholder { color: var(--dsw-alias-label-secondary, rgba(128,128,128,0.9)); }
.kb-input:hover { border-color: var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, rgba(128,128,128,0.5))); }
.kb-metrics { display: flex; gap: 14px; flex-wrap: wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  font-variant-numeric: tabular-nums; }
/* WIP-against-limit and oldest-against-SLE lead; history and the SLE definition are demoted to
   dimmed, so the strip has one scan order instead of nine equal items. */
.kb-metric-lead { font-weight: 600; }
.kb-metrics b { font-weight: 600; }
.kb-list { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
.kb-dim { color: var(--dsw-alias-label-secondary, inherit); }
.kb-empty { color: var(--dsw-alias-label-secondary, rgba(128,128,128,0.9)); padding: 10px 2px; }
/* One focus ring for every control, so nothing relies on the browser default. The card keeps a
   tighter offset because it sits inside the horizontally scrolled lane. */
.kb-btn:focus-visible, .kb-input:focus-visible, .kb-check:focus-visible, .kb-drawer:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4c8bf5); outline-offset: 2px; }
.kb-card:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4c8bf5); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) {
  .kb-btn, .kb-input { transition: none; }
  .kb-btn:active { transform: none; }
}
/* Measured with scripts/capture-panel.mts against the app's own resolved values (2026-10-16):
   light '#f59e0b' on '#fff' is 2.15:1 and '#dd8629' is 2.79:1 -- **no amber in the app's scale reaches
   AA for small text on white**, so amber must not carry text in the light theme. Red passes both
   (4.50:1 light / 5.55:1 dark) and stays. In light the priority and age keep their meaning from the
   word the card already prints ('P1 - high', '- ageing') and from their weight; in dark the colour is
   restored as a redundant enhancement, where it measures 8.49:1. */
.kb-pri-p1, .kb-age-ageing, .kb-check-missing { color: var(--dsw-alias-label-primary, inherit); }
body[data-ds-dark-theme] .kb-pri-p1,
body[data-ds-dark-theme] .kb-age-ageing,
body[data-ds-dark-theme] 
/* The same split for the de-emphasised tier: tertiary is 8.54:1 in dark but only 3.71:1 in light. */
body[data-ds-dark-theme] .kb-sub,
body[data-ds-dark-theme] .kb-input::placeholder,
body[data-ds-dark-theme] .kb-empty { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, rgba(128,128,128,0.9))); }
`;

/** The id the panel's own stylesheet is injected under, so it is added exactly once. */
export const STYLE_ID = 'dsh-kanban-styles';
