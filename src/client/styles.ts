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
/* Three role literals, each declared once, because the same fallback had drifted into four alphas for
   one role (border-l1: 0.28/0.3/0.32/0.35), two for another (bg-layer-2) and two for a third
   (label-secondary). These are **fallbacks for an absent token**, not a palette: with the app's theme
   present none of them is painted. A literal used more than once lives here, so the next rule that
   needs it cannot invent a fifth alpha. */
:root { --kb-lane-width: 236px; --kb-measure: 62ch; --kb-radius-control: 7px; --kb-radius-card: 8px; --kb-radius-panel: 10px;
  --kb-border-l1: rgba(128,128,128,0.35); --kb-bg-layer-2: rgba(128,128,128,0.12); --kb-label-secondary: rgba(128,128,128,0.9); }
.kb-page { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 10px; padding: 14px 16px 18px;
  font: 13px/1.5 inherit; color: var(--dsw-alias-label-primary, inherit); }
/* The craft floor's "browser surfaces": the parts this panel never drew still carry its design. The app
   provides a scrollbar ladder and a document-selection fill; both are the app's own tokens, each with a
   literal fallback, so they follow the theme exactly as the rest of the sheet does. 'caret-color' is the
   third: in a text field the caret is the only thing telling you where typing lands, and leaving it to
   the browser makes it the one mark on the panel that belongs to no design system. */
.kb-page { caret-color: var(--dsw-alias-label-primary, inherit); }
.kb-page ::selection { background: var(--dsw-alias-bg-document-selection, rgba(128,128,128,0.25)); }
.kb-lanes, .kb-drawer { scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l1, var(--kb-label-secondary)) var(--dsw-alias-scrollbar-bg-l2, transparent); }
.kb-lanes::-webkit-scrollbar, .kb-drawer::-webkit-scrollbar { width: 10px; height: 10px; }
.kb-lanes::-webkit-scrollbar-thumb, .kb-drawer::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l1, var(--kb-label-secondary)); border-radius: 999px; }
.kb-lanes::-webkit-scrollbar-thumb:hover, .kb-drawer::-webkit-scrollbar-thumb:hover {
  background: var(--dsw-alias-scrollbar-hover-l1, var(--kb-label-secondary)); }
.kb-lanes::-webkit-scrollbar-track, .kb-drawer::-webkit-scrollbar-track {
  background: var(--dsw-alias-scrollbar-bg-l2, transparent); }
.kb-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; line-height: 1.4; }
.kb-title { font-size: 18px; font-weight: 600; margin: 0; line-height: 1.25; }
.kb-sub { color: var(--dsw-alias-label-secondary, var(--kb-label-secondary));
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.kb-spacer { flex: 1 1 auto; }
/* One authored motion moment, stated deliberately rather than inherited by accident: 140ms ease-out
   answering a *state* change (hover, press, reveal, a lane a card is over), never an entrance. No
   element animates into existence, there is no keyframe and no loop, and the whole block is cancelled
   under 'prefers-reduced-motion: reduce' below -- no transition here is load-bearing. */
.kb-btn { border: 1px solid var(--dsw-alias-border-l1, var(--kb-border-l1)); background: transparent; color: inherit;
  border-radius: var(--kb-radius-control, 7px); padding: 3px 9px; cursor: pointer; font: inherit; line-height: 1.4;
  /* A comfortable pointer target for every control, not only the ones that happen to be tall enough:
     3px + 13px x 1.4 + 3px + 2px of border lands at 24px. The visual weight is unchanged. */
  min-height: 24px;
  transition: background-color 140ms ease-out, border-color 140ms ease-out, transform 140ms ease-out; }
.kb-btn:hover { background: var(--dsw-alias-bg-layer-2, var(--kb-bg-layer-2)); }
.kb-btn:active { transform: translateY(1px); }
/* Pressed and open are the same *kind* of thing -- a control that selects or reveals -- so they now
   take one treatment: the tint, the stronger hairline and the weight. The difference that survives
   without colour is the caret on a disclosure, which points where the revealed half will appear and
   flips when it is open; a reader who cannot see the tint is not left with a hover lookalike. */
.kb-btn[aria-pressed="true"], .kb-more[aria-expanded="true"] { background: var(--dsw-alias-bg-layer-2, var(--kb-bg-layer-2));
  border-color: var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, rgba(128,128,128,0.5))); font-weight: 600; }
/* A disabled button may not keep a pressed look: the one button that is both (a ticked checklist row
   that a mutation has put out of action) must read as inert, not as chosen. */
.kb-btn[aria-pressed="true"]:disabled { background: transparent; border-color: var(--dsw-alias-border-l1, var(--kb-border-l1)); }
.kb-btn:disabled { opacity: 0.5; cursor: default; }
.kb-btn:disabled:hover { background: transparent; }
.kb-btn:disabled:active { transform: none; }
.kb-chip { border: 1px solid var(--dsw-alias-border-l1, var(--kb-border-l1)); border-radius: 999px; padding: 1px 8px; font-size: 12px; line-height: 1.5; }
.kb-chip-kb { background: var(--dsw-alias-bg-layer-2, var(--kb-bg-layer-2)); }
/* The one chip that is a warning rather than a fact: the words were always there, and this gives them
   the weight the lane count's red already has, so an over-limit lane reads as one signal twice-told
   (a colour and a word) instead of a coloured count beside a chip that looked like every other chip. */
.kb-chip-warn { color: var(--dsw-alias-state-error-primary, #d64545); font-weight: 600; }
.kb-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
/* One action group per concern, so a reversible move never sits unlabelled beside Drop. */
.kb-group { display: flex; flex-direction: column; gap: 3px; }
.kb-group-danger { border-top: 1px solid var(--dsw-alias-border-l1, var(--kb-border-l1)); padding-top: 7px; }
/* A disclosure's toggle names what it reveals, and its 'aria-expanded' attribute is its state. It is
   the smallest control on the panel by *type* (12px), but no longer by target: the shared 24px floor
   above applies here too, so the smallest thing to read is not the hardest thing to hit. */
.kb-more { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; font-size: 12px; }
/* The caret is the open state without colour: right on closed, down on open. Drawn, one stroke,
   'currentColor' -- the same glyph family as the drawn tick and the sidebar icon. */
.kb-more-caret { flex: 0 0 auto; transition: transform 140ms ease-out; }
.kb-more[aria-expanded="true"] .kb-more-caret { transform: rotate(90deg); }
/* The revealed half of a drawer's disclosure, set off from the row it opens from. */
.kb-fold { display: flex; flex-direction: column; gap: 9px; border-top: 1px solid var(--dsw-alias-border-l1, var(--kb-border-l1)); padding-top: 7px; }
.kb-notice { border: 1px solid var(--dsw-alias-border-l1, var(--kb-border-l1)); border-radius: var(--kb-radius-control, 7px);
  padding: 7px 11px; display: flex; gap: 10px; align-items: baseline; }
.kb-notice-refusal { border-color: var(--dsw-alias-state-error-primary, #d64545); }
.kb-notice-info { border-color: var(--dsw-alias-brand-primary, #4c8bf5); }
.kb-notice-error { border-color: var(--dsw-alias-state-error-primary, #d64545); }
.kb-notice-missing { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-secondary, var(--kb-label-secondary)); }
.kb-lanes { display: flex; gap: 10px; overflow-x: auto; align-items: flex-start; flex: 1 1 auto; min-height: 140px; padding-bottom: 6px; }
/* Pending is a state the panel draws, not a sentence it prints. 'aria-busy' is the state; the dimming
   is the sighted half of it, and it is not colour-only -- it is weight of presence, and the header
   says 'connecting...' in words. */
.kb-lanes-busy, .kb-lanes-loading { opacity: 0.6; }
/* The loading tell. A lane's own skeleton line is drawn for each lane the board is about to fill, so a
   pending board reads as pending at every width instead of as five empty lanes that might be the
   answer. It carries no text; the header's 'connecting...' is the announced half. */
.kb-skeleton { height: 34px; border-radius: var(--kb-radius-card, 8px); border: 1px dashed var(--dsw-alias-border-l1, var(--kb-border-l1)); }
.kb-lane { flex: 0 0 var(--kb-lane-width, 236px); display: flex; flex-direction: column; gap: 7px; border: 1px solid var(--dsw-alias-border-l1, var(--kb-border-l1));
  border-radius: var(--kb-radius-panel, 10px); padding: 9px; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.04)); min-height: 110px; }
/* The drop target cannot rely on the brand token: in dark it resolves to a near-white neutral, so
   the ring vanished into the body. A raised tint plus a dashed secondary-label ring reads in both. */
.kb-lane-over { background: var(--dsw-alias-bg-layer-2, var(--kb-bg-layer-2)); outline: 2px dashed var(--dsw-alias-label-secondary, currentColor); outline-offset: -3px; }
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
.kb-lane-count { color: var(--dsw-alias-label-secondary, var(--kb-label-secondary)); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
/* Over-limit is one signal told twice: the count goes red (and heavier, so it survives a greyscale
   read) and the chip beside it says "over limit" in words. Neither half is colour alone, and the two
   now read as one warning rather than a coloured number beside an ordinary chip. */
.kb-lane-over-limit .kb-lane-count { color: var(--dsw-alias-state-error-primary, #d64545); font-weight: 600; }
.kb-cards { display: flex; flex-direction: column; gap: 7px; min-height: 36px; }
.kb-card { border: 1px solid var(--dsw-alias-border-l1, var(--kb-border-l1)); border-radius: var(--kb-radius-card, 8px); padding: 7px 9px;
  background: var(--dsw-alias-bg-base, transparent); cursor: grab; display: flex; flex-direction: column; gap: 5px;
  transition: border-color 140ms ease-out; }
.kb-card:hover { border-color: var(--dsw-alias-brand-primary, #4c8bf5); }
/* A dropped card is not an expedite one: nothing is wrong and nothing is waiting. It keeps its shape
   and its hairline and takes the dim tier, because the only thing it says is "out of play". */
.kb-card-dropped { color: var(--dsw-alias-label-secondary, inherit); }
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
.kb-card-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-secondary, var(--kb-label-secondary)); font-size: 12px; }
.kb-card-title { flex: 1 1 auto; }
.kb-card-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
.kb-pri { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.kb-pri-p0 { color: var(--dsw-alias-state-error-primary, #d64545); }
/* Every member of the two template-generated families now has a rule, so no class is emitted to style
   nothing. 'fresh' and 'P2-P4' are stated as the resting tier rather than left to inheritance, which is
   what makes the family checkable instead of a matter of restraint; the coloured exceptions read as
   they did. */
.kb-pri-p1, .kb-pri-p2, .kb-pri-p3, .kb-pri-p4 { color: var(--dsw-alias-label-primary, inherit); }
.kb-age-stale { color: var(--dsw-alias-state-error-primary, #d64545); font-weight: 600; }
.kb-age-ageing { color: var(--dsw-alias-label-primary, inherit); }
.kb-age-fresh { color: var(--dsw-alias-label-secondary, var(--kb-label-secondary)); }
/* Capped in pixels, not as a share of the page: 46% of a one-card board took the lanes' half of
   the panel to open a single card. The lanes keep their own floor above; the drawer scrolls. The caps
   are genuine one-offs -- each governs one surface's own geometry and is used once -- so none became a
   variable: a '--kb-*' name with a single consumer is an abstraction, not a scale. */
.kb-drawer { border: 1px solid var(--dsw-alias-border-l1, var(--kb-border-l1)); border-radius: var(--kb-radius-panel, 10px); padding: 12px 14px;
  display: flex; flex-direction: column; gap: 9px; max-height: 260px; overflow: auto; }
/* The drawer is focused programmatically, and a script-driven 'focus()' need not paint ':focus-visible'
   in every browser. When the panel itself moved the keyboard there -- 'Enter' on a card rather than a
   click -- it says so in the DOM and gets the ring the browser may not have drawn. That attribute is
   the whole claim, so the pointer path stays visually quiet. */
.kb-drawer[data-open="keyboard"]:focus { outline: 2px solid var(--dsw-alias-brand-primary, #4c8bf5); outline-offset: 2px; }
.kb-drawer-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; line-height: 1.4; }
.kb-checks { display: flex; flex-direction: column; gap: 3px; }
.kb-check { display: flex; gap: 8px; align-items: center; cursor: pointer; }
.kb-check-glyph { flex: 0 0 auto; }
/* Long prose (the acceptance line) reads at a sane measure instead of running the drawer's width. */
.kb-prose { max-width: var(--kb-measure, 62ch); text-wrap: pretty; }
.kb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-word; }
.kb-input { border: 1px solid var(--dsw-alias-border-l1, var(--kb-border-l1)); background: transparent; color: inherit;
  border-radius: var(--kb-radius-control, 7px); padding: 3px 8px; font: inherit; min-width: 140px; transition: background-color 140ms ease-out, border-color 140ms ease-out; }
/* A select is a value picker, not a text box: it does not need the search field's width. */
select.kb-input { min-width: 0; padding-right: 4px; }
input[type="number"].kb-input { min-width: 76px; }
.kb-input::placeholder { color: var(--dsw-alias-label-secondary, var(--kb-label-secondary)); }
.kb-input:hover { border-color: var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, rgba(128,128,128,0.5))); }
.kb-metrics { display: flex; gap: 14px; flex-wrap: wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  font-variant-numeric: tabular-nums; }
/* WIP-against-limit and oldest-against-SLE lead; history and the SLE definition are demoted to
   dimmed, so the strip has one scan order instead of nine equal items. */
.kb-metric-lead { font-weight: 600; }
.kb-metrics b { font-weight: 600; }
.kb-list { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
.kb-dim { color: var(--dsw-alias-label-secondary, inherit); }
.kb-empty { color: var(--dsw-alias-label-secondary, var(--kb-label-secondary)); padding: 10px 2px; }
/* One focus ring for every control, so nothing relies on the browser default. The card keeps a
   tighter offset because it sits inside the horizontally scrolled lane. A disabled button is not
   focusable in the first place; the exclusion states that rather than relying on it. */
.kb-btn:focus-visible:not(:disabled), .kb-input:focus-visible, .kb-check:focus-visible, .kb-drawer:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4c8bf5); outline-offset: 2px; }
.kb-card:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4c8bf5); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) {
  .kb-btn, .kb-input, .kb-card { transition: none; }
  .kb-more-caret { transition: none; }
  .kb-btn:active { transform: none; }
  .kb-more[aria-expanded="true"] .kb-more-caret { transform: rotate(90deg); }
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
body[data-ds-dark-theme] .kb-check-missing { color: var(--dsw-alias-state-warn-primary, #d68945); }

/* The same split for the de-emphasised tier: tertiary is 8.54:1 in dark but only 3.71:1 in light.
   A comment must never sit inside a selector list: a dangling selector before one makes the whole
   rule a descendant chain that matches nothing, which is exactly how this block shipped dead. */
body[data-ds-dark-theme] .kb-sub,
body[data-ds-dark-theme] .kb-input::placeholder,
body[data-ds-dark-theme] .kb-empty { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, var(--kb-label-secondary))); }
`;

/** The id the panel's own stylesheet is injected under, so it is added exactly once. */
export const STYLE_ID = 'dsh-kanban-styles';
