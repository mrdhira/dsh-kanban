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
 *
 * No backticks below: this is one template literal, so a code span in a comment ends the string and
 * the build fails. That happened once, and the suite went green against a stale bundle for a while.
 * A test counts the delimiters. Stylesheet text uses 'quotes' for emphasis.
 */
export const STYLES = `
/* Three role literals, each declared once, because the same fallback had drifted into four alphas for
   one role (border-l1: 0.28/0.3/0.32/0.35), two for another (bg-layer-2) and two for a third
   (label-secondary). These are **fallbacks for an absent token**, not a palette: with the app's theme
   present none of them is painted. A literal used more than once lives here, so the next rule that
   needs it cannot invent a fifth alpha. */
:root { --kb-lane-width: 236px; --kb-measure: 62ch; --kb-radius-control: 7px; --kb-radius-card: 8px; --kb-radius-panel: 10px;
  --kb-control-height: 26px;
  --kb-border-l1: rgba(128,128,128,0.35); --kb-bg-layer-2: rgba(128,128,128,0.12); --kb-label-secondary: rgba(128,128,128,0.9); }
/* The base type, as three declarations and never as the 'font' shorthand.
   It was written 'font: 13px/1.5 inherit', which is **invalid CSS**: a family component in the
   'font' shorthand must be a family (or a system keyword), and 'inherit' is neither -- so the whole
   declaration was dropped and the panel painted at the app body's 16px. Measured: every one of the
   84 probe states read 'font-size: 16px' with 'bodySize: 16px'. The family is deliberately left
   alone: the panel declares none and inherits the app's face, which is the documented position. */
.kb-page { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 10px; padding: 14px 16px 18px;
  font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary, inherit); }
/* The craft floor's "browser surfaces": the parts this panel never drew still carry its design. The app
   provides a scrollbar ladder and a document-selection fill; both are the app's own tokens, each with a
   literal fallback, so they follow the theme exactly as the rest of the sheet does. 'caret-color' is the
   third: in a text field the caret is the only thing telling you where typing lands, and leaving it to
   the browser makes it the one mark on the panel that belongs to no design system. */
.kb-page { caret-color: var(--dsw-alias-label-primary, inherit); }
.kb-page ::selection { background: var(--dsw-alias-bg-document-selection, rgba(128,128,128,0.25)); }
/* The scrollbar ladder, with the track the app itself declares. l1 is the thumb and l2 the track --
   the doc's reading, now the code's -- but **both tokens resolve to the app's neutral-200 in light**
   (#e5e5e5), so an opaque track painted the thumb at 1.00:1 and the scrollbar read as a gap. The app
   answers that by writing scrollbar-color as "thumb, transparent", and its own -webkit track rule is
   "background: 0 0". The panel now writes both halves the same way, so the thumb is measured against
   the surface it actually sits on (the lane or the drawer) instead of against a same-valued fill:
   1.26:1 in light (the ladder's -hover step is 1.17:1), and 1.43:1 in dark. The thumb's own
   fallback is --kb-label-secondary, this sheet's "visible de-emphasised mark", so a missing ladder
   still produces a visible thumb (5.80:1 light) rather than a track-coloured one. */
.kb-lanes, .kb-drawer { scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l1, var(--kb-label-secondary)) transparent; }
.kb-lanes::-webkit-scrollbar, .kb-drawer::-webkit-scrollbar { width: 10px; height: 10px; }
.kb-lanes::-webkit-scrollbar-thumb, .kb-drawer::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l1, var(--kb-label-secondary)); border-radius: 999px; }
.kb-lanes::-webkit-scrollbar-thumb:hover, .kb-drawer::-webkit-scrollbar-thumb:hover {
  background: var(--dsw-alias-scrollbar-hover-l1, var(--kb-label-secondary)); }
.kb-lanes::-webkit-scrollbar-track, .kb-drawer::-webkit-scrollbar-track {
  background: transparent; }
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
  border-radius: var(--kb-radius-control, 7px); padding: 3px 8px; cursor: pointer; font: inherit; line-height: 1.4;
  /* One control height for one control row. Measured, the button's border box was 30.39px and an
     input's was 26.00px in the same bar (210 control-height findings over 7 distinct rows): the
     inline-flex disclosure's 9px caret sets a taller line box than the text, and the old
     'min-height: 24px' was a *floor* that never capped the natural box, so it passed while the
     controls disagreed. 'box-sizing: border-box' plus one height makes the button, the input and
     the select the same 26px; 'font: inherit' keeps the type. */
  box-sizing: border-box; height: var(--kb-control-height, 26px); min-height: var(--kb-control-height, 26px);
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
/* De-emphasis is a *colour* here, never an element opacity. An element opacity of 0.5 on the whole
   control took its label to 3.51:1 in light -- a failure, because the label is text -- and its 1px
   border with it. The label token is the ladder the system already has, and its 5.80:1 light /
   12.11:1 dark on the card is what a control that is present but inert should measure. The resting
   border stays; hover, the press nudge and any pressed fill are still cancelled, so it does not move
   or light up. */
.kb-btn:disabled { color: var(--dsw-alias-label-secondary, var(--kb-label-secondary)); cursor: default; }
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
/* A staged drop: a drag (or a keyboard move) landed on Dropped, the reason it cannot carry is the only
   thing missing, and this group is where it is written. The tint is the app's raised tier -- the same
   device a hovered control and a lane a card is over use -- never a colour, so it survives both themes
   and a greyscale screenshot, and the staged text inside it is what actually says why. */
.kb-group-danger.kb-staged { background: var(--dsw-alias-bg-layer-2, var(--kb-bg-layer-2)); border-radius: var(--kb-radius-control, 7px); padding: 7px; }
/* A disclosure's toggle names what it reveals, and its 'aria-expanded' attribute is its state. It is
   the smallest control on the panel by *type* (12px) and shares the one 26px control height above, so
   the smallest thing to read is not the hardest thing to hit and a bar holding one is not a row of
   two heights. Its inset is the same 8px as the button's and the input's, so one bar has one edge. */
.kb-more { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; font-size: 12px; }
/* The caret is the open state without colour: right on closed, down on open. Drawn, one stroke,
   'currentColor' -- the same glyph family as the drawn tick and the sidebar icon. */
.kb-more-caret { flex: 0 0 auto; transition: transform 140ms ease-out; }
.kb-more[aria-expanded="true"] .kb-more-caret { transform: rotate(90deg); }
/* The revealed half of a drawer's disclosure, set off from the row it opens from. */
.kb-fold { display: flex; flex-direction: column; gap: 9px; border-top: 1px solid var(--dsw-alias-border-l1, var(--kb-border-l1)); padding-top: 7px; }
/* The notice is centre-aligned, not baseline-aligned, and its message takes the row's free width.
   Baseline on a *two-line* message put a one-line button against the first line's ink and left the
   block top-heavy (measured: top spread 4.19px, bottom 4.20px on every notice state); centre is what
   align-items=center means and it is stable however many lines the message wraps to.
   The message's flex-grow, together with the '.kb-spacer' the strip renders before its button, is
   what puts Dismiss at the content edge instead of 486.09px short of it -- the strip's only control
   sat at 45% of the row because the sentence did not stretch. The spacer is the row's own edge
   device (see .kb-head); the grow covers the error notice, whose message is a bare text node and so
   has no span for the spacer to stand beside. */
.kb-notice { border: 1px solid var(--dsw-alias-border-l1, var(--kb-border-l1)); border-radius: var(--kb-radius-control, 7px);
  padding: 7px 11px; display: flex; gap: 10px; align-items: center; }
.kb-notice > span:first-child { flex: 1 1 auto; }
.kb-notice-refusal { border-color: var(--dsw-alias-state-error-primary, #d64545); }
.kb-notice-info { border-color: var(--dsw-alias-brand-primary, #4c8bf5); }
.kb-notice-error { border-color: var(--dsw-alias-state-error-primary, #d64545); }
.kb-notice-missing { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-secondary, var(--kb-label-secondary)); }
.kb-lanes { display: flex; gap: 10px; overflow-x: auto; align-items: flex-start; flex: 1 1 auto; min-height: 140px; padding-bottom: 6px; }
/* Pending is a state the panel draws, not a sentence it prints. 'aria-busy' is the state; the dimming
   is the sighted half of it, and it is not colour-only -- it is weight of presence, and the header
   says 'connecting...' in words.
   The dimming is a token colour, **not** an element opacity: an element opacity of 0.6 on the row took
   the ids, the lane counts, the card titles and the comments to 2.53:1 light / 3.59:1 dark, so the board
   failed AA during any write or the first load -- the moment a reader is most likely to be reading it.
   The members that set their own colour (a red over-limit count, a P0 code, the drawn mark) keep it,
   which is the point: a warning that could not be seen because a write was in flight is not one. */
.kb-lanes-busy, .kb-lanes-loading { color: var(--dsw-alias-label-secondary, var(--kb-label-secondary)); }
/* The loading tell. A lane's own skeleton line is drawn for each lane the board is about to fill, so a
   pending board reads as pending at every width instead of as six empty lanes that might be the
   answer. It carries no text; the header's 'connecting...' is the announced half. */
.kb-skeleton { height: 34px; border-radius: var(--kb-radius-card, 8px); border: 1px dashed var(--dsw-alias-border-l1, var(--kb-border-l1)); }
/* The lane's basis, with 'min-width: 0' so the basis actually wins.
   'flex: 0 0 236px' is a *flex base size*, not a cap: a flex item's automatic minimum size
   ('min-width: auto', i.e. its min-content width) still wins, so one unbreakable token in one card
   title -- an ordinary 23-character session id, or the 64-character digest the probe's fixture
   carries -- set the lane's min-content to 603.03px and the lane rendered 603.03px wide against its
   own declared 236px (66 findings, every state, theme and width). 'min-width: 0' lets the declared
   basis hold; the card's own '.kb-card-title' then breaks the token inside the 196px content box
   instead of pushing the lane out. */
.kb-lane { flex: 0 0 var(--kb-lane-width, 236px); min-width: 0; display: flex; flex-direction: column; gap: 7px; border: 1px solid var(--dsw-alias-border-l1, var(--kb-border-l1));
  border-radius: var(--kb-radius-panel, 10px); padding: 9px; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.04)); min-height: 110px; }
/* The drop target cannot rely on the brand token: in dark it resolves to a near-white neutral, so
   the ring vanished into the body. A raised tint plus a dashed secondary-label ring reads in both. */
.kb-lane-over { background: var(--dsw-alias-bg-layer-2, var(--kb-bg-layer-2)); outline: 2px dashed var(--dsw-alias-label-secondary, currentColor); outline-offset: -3px; }
/* An empty lane is a narrow slot, not a 236px void -- it still takes a drop, and it opens while a drag
   is live so the target is hittable exactly when it matters. It keeps its name on **one horizontal
   line**: a rotated word reads as a sliver rather than a column, and at the old 46px no name fitted across,
   so the collapse narrows the lane instead of turning the label on its side.
   The dashed edge is the panel's existing "not settled" vocabulary (.kb-skeleton, .kb-lane-over), and
   nothing depends on a fill: in light, bg-layer-1, bg-layer-2 and bg-base all resolve to the same
   colour, so a tint would be a no-op in one theme while carrying the whole meaning in the other.
   Both slot rules are now deltas only: the 9px padding is the lane's, so neither restates it, and
   '.kb-lane-awake' no longer restates 'writing-mode: horizontal-tb' -- nothing in this sheet ever
   sets a non-initial writing mode for it to undo. One orientation, stated once, for the slot and for
   the awake lane: the header is a row in both, which is what keeps a drag from flipping it. */
.kb-lane-empty { flex: 0 0 auto; align-items: stretch; border-style: dashed; }
.kb-lane-empty .kb-lane-head { flex-direction: row; }
.kb-lane-empty .kb-cards { width: 100%; min-height: 48px; }
.kb-lane-empty .kb-empty { display: none; }
.kb-lane-awake { flex: 0 0 var(--kb-lane-width, 236px); align-items: stretch; }
.kb-lane-awake .kb-lane-head { flex-direction: row; }
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
.kb-card-dropped { color: var(--dsw-alias-label-secondary, var(--kb-label-secondary)); }
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
   token degrades to "marked" rather than to nothing.
   **The mark is two-tone, and that is what makes it meet 3:1.** The app's success token (a medium
   green, #22c55e) is the same value in *both* themes, and the most a 1.5px stroke of it can composite
   to on the light card's white is 2.28:1 -- a drawn mark below the graphical floor, which no stroke
   width can repair because the ceiling is the colour itself (a fully-covered pixel is still 2.28:1).
   So the frame carries the success hue, where it is redundant with the shape and the word "Done", and
   the tick inside it is drawn in the ordinary foreground: 18.90:1 light / 17.45:1 dark on the card,
   15.03:1 on the dark lane. No new colour was invented and no edge was thickened; the two tokens the
   sheet already had are assigned to the two parts each can actually carry. The rule is scoped to
   the card's own mark, so a checklist row's glyph (which shares the class on its path) is untouched:
   its tick still inherits currentColor, which is what its dark-theme amber/unticked treatment and
   its aria-pressed state were built around. */
.kb-mark { align-self: center; flex: 0 0 auto; color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary, inherit)); }
.kb-mark .kb-mark-tick { color: var(--dsw-alias-label-primary, inherit); }
.kb-card-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-secondary, var(--kb-label-secondary)); font-size: 12px; }
/* The title is the one text block inside a 196px content box, and it must not be able to set the
   lane's min-content: an unbreakable token (a session id, a payload digest) would otherwise push
   the card -- and, before '.kb-lane''s 'min-width: 0', the whole lane -- wider than the sheet says.
   'overflow-wrap: break-word' breaks a token only when it cannot fit on a line of its own, so
   ordinary prose is untouched. */
.kb-card-title { flex: 1 1 auto; text-wrap: pretty; overflow-wrap: break-word; min-width: 0; }
.kb-card-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 12px; color: var(--dsw-alias-label-secondary, var(--kb-label-secondary)); }
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
  border-radius: var(--kb-radius-control, 7px); padding: 3px 8px; font: inherit; line-height: 1.4; min-width: 140px;
  box-sizing: border-box; height: var(--kb-control-height, 26px); min-height: var(--kb-control-height, 26px);
  transition: background-color 140ms ease-out, border-color 140ms ease-out; }
/* A select is a value picker, not a text box: it does not need the search field's width. */
select.kb-input { min-width: 0; padding-right: 4px; }
input[type="number"].kb-input { min-width: 76px; }
/* One label treatment, and only for section labels: 12px monospace in the secondary tone with a
   little tracking. Before this, a section label, an in-row field label and a value were all one
   'kb-dim' span, so 'detail', 'priority' and the select beside it were the same kind of mark. The
   12px mono shape belongs to the drawer's sections (detail, move, card, comment, the two gates,
   history); an in-row label takes 'kb-inline-label' below and stays in the inherited face. */
.kb-label { color: var(--dsw-alias-label-secondary, var(--kb-label-secondary));
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; letter-spacing: 0.04em; }
/* An in-row label names the control beside it ('priority', 'class', 'position', 'except'). It is a
   lighter tier than a section label on purpose: the inherited face at the body's 13px, in the
   secondary tone, so a value never reads as a heading, a heading never reads as a field name, and
   the row it labels keeps the 3.25px top/bottom spread a 26px control beside 13px text produces,
   rather than the 4.00px a 12px label added. */
.kb-inline-label { color: var(--dsw-alias-label-secondary, var(--kb-label-secondary)); font-size: 13px; line-height: 1.5; }
/* Section boundaries are ruled, not spaced. The drawer's only cue used to be 9px between groups
   against 3px inside one, and the human read the result as "no firm lines separating one component
   from another". Every drawer section takes the sheet's own hairline; the 7px below it is the
   spacing the sheet already uses under a fold's rule, so nothing grew a bigger gap instead. */
.kb-drawer > .kb-group, .kb-drawer > .kb-checks { border-top: 1px solid var(--dsw-alias-border-l1, var(--kb-border-l1)); padding-top: 7px; }
/* The drawer form rows take the drawer's width. Measured before this rule, the comment field was
   140px in a 927px row and every drawer bar's last control stopped 486-756px short of the row's right
   content edge (88 findings over 6 states): a form at 15% of its container does not read as narrow-
   on-purpose, it reads as broken. Only the drawer's own rows are affected -- the page toolbar and the
   metrics strip keep their spacer-led layout -- and a select's 'padding-right: 4px' keeps its arrow
   clear of the new edge. */
.kb-drawer .kb-bar > input.kb-input,
.kb-drawer .kb-bar > select.kb-input { flex: 1 1 auto; }
/* The new-card row is a disclosure's revealed half, not the toolbar: its field takes the row's
   width and 'Add' sits at its content edge, so a form that appears only while used reads as a form
   rather than as one small control in a large empty bar. Scoped to this row; the toolbar and the
   drawer's own rows keep their existing layout. */
.kb-new-card > input.kb-input { flex: 1 1 auto; }
/* A placeholder is text, and the browser's own placeholder styling dims it for you: Chrome applies
   roughly 0.54 of the element's opacity on top of whatever colour the author set, so the passing
   label-secondary above arrived as 2.27:1 in light (and 3.35-4.33:1 in dark). Setting "opacity: 1"
   here means the colour the token gives is the colour that paints -- only the deliberate dark-theme
   label-tertiary rule below changes it, and that one passes at 8.54:1 in the scope it is written for.
   The -webkit- spelling is listed for the same reason the scrollbar's two halves are: a UA
   pseudo-element needs the value restated where it has a rule of its own. */
.kb-input::placeholder, .kb-input::-webkit-input-placeholder { color: var(--dsw-alias-label-secondary, var(--kb-label-secondary)); opacity: 1; }
.kb-input:hover { border-color: var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, rgba(128,128,128,0.5))); }
/* Baseline, not the initial 'normal'. Measured on the real browser, the 26px control boxes stretched
   the row and the 12px metric text sat at the top of its box: baselineSpread was 3.59px in every
   state, theme and width (72 measured rows). Baseline puts the lead's numbers, the disclosure's
   label and the revealed facts on one ink line however tall their boxes are. */
.kb-metrics { display: flex; gap: 14px; flex-wrap: wrap; align-items: baseline; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  font-variant-numeric: tabular-nums;
  /* The strip's own height is reserved while it has no facts to print. The component renders the
     empty box during the first read instead of nothing, because an absent child is what moved the
     board: measured, the lane row started 34.00px higher while loading and settled when the payload
     landed. The reserved height is the strip's own one-line box at the shared control height (26px
     -- the disclosure inside it is the tallest thing on the line), so the space the loaded strip
     takes is the space the loading page already holds. A second wrapped line would still move it,
     which is the honest limit of reserving a box rather than knowing its content; the alternative --
     reordering the page so the strip's absence cannot move the lanes -- would put the metrics below
     the board, which is not the scan order this panel's signature component is built on. */
  min-height: var(--kb-control-height, 26px);
  /* flex-wrap decides where a *whole item* goes, not what happens inside one: a long sle.source token
     (the basis is the host's own string) ran past the narrowest panel, because neither a lead nor the
     revealed kb-dim fact had anywhere to break. One declaration covers every span in the strip, and a
     token longer than the column now breaks instead of overflowing. */
  word-break: break-word; }
/* WIP-against-limit and oldest-against-SLE lead; history and the SLE definition are demoted to
   dimmed, so the strip has one scan order instead of nine equal items. */
.kb-metric-lead { font-weight: 600; }
.kb-metrics b { font-weight: 600; }
.kb-list { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
.kb-dim { color: var(--dsw-alias-label-secondary, inherit); }
/* The one visually-hidden utility, and the only thing on the panel that is styled to be unseen. The
   board's announcer is a live region that must be *mounted* -- a region inserted together with its
   first message is one many screen readers never announce -- but it is not content: as a '.kb-dim'
   span it sat in the page's 10px gap as a permanent empty box and then as a stray
   "moving T-004 to review" line. Clipping it to a 1px box keeps it in the accessibility tree (so it
   still announces) while removing it from layout. It is deliberately **not** 'display: none' or
   'visibility: hidden': those remove the node from the accessibility tree too, and a silent live
   region announces nothing. */
.kb-vh { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
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
