---
name: dsh-kanban Board
description: A dense, flat, border-only Kanban panel that wears the DSH desktop app's own theme tokens instead of a palette of its own.
colors:
  # Values are the exact strings the stylesheet resolves with, referenced verbatim so no generated
  # screen hardcodes a colour the app owns. The literal after each comma is the declared fallback.
  brand-primary: "var(--dsw-alias-brand-primary, #4c8bf5)"
  state-error: "var(--dsw-alias-state-error-primary, #d64545)"
  state-warn: "var(--dsw-alias-state-warn-primary, #d68945)"
  label-primary: "var(--dsw-alias-label-primary, inherit)"
  border-l1: "var(--dsw-alias-border-l1, rgba(128,128,128,0.32))"
  bg-base: "var(--dsw-alias-bg-base, transparent)"
  bg-layer-1: "var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.04))"
  bg-layer-2: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12))"
typography:
  display:
    fontFamily: "inherit"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "inherit"
    fontSize: "13px"
    lineHeight: 1.5
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    lineHeight: 1.5
rounded:
  control: "7px"
  card: "8px"
  panel: "10px"
  pill: "999px"
spacing:
  tight: "3px"
  card-gap: "5px"
  rhythm: "7px"
  control: "8px"
  panel: "9px"
  section: "10px"
  drawer: "12px"
  gutter: "14px"
  page: "16px"
components:
  button:
    backgroundColor: "transparent"
    textColor: "{colors.label-primary}"
    rounded: "{rounded.control}"
    padding: "3px 9px"
    typography: "{typography.body}"
  button-hover:
    backgroundColor: "{colors.bg-layer-2}"
  button-pressed:
    textColor: "{colors.brand-primary}"
  card:
    backgroundColor: "{colors.bg-base}"
    textColor: "{colors.label-primary}"
    rounded: "{rounded.card}"
    padding: "7px 9px"
  lane:
    backgroundColor: "{colors.bg-layer-1}"
    rounded: "{rounded.panel}"
    padding: "9px"
    width: "236px"
  chip:
    rounded: "{rounded.pill}"
    padding: "1px 8px"
    typography: "{typography.label}"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.label-primary}"
    rounded: "{rounded.control}"
    padding: "3px 8px"
  notice:
    rounded: "{rounded.control}"
    padding: "7px 11px"
  drawer:
    rounded: "{rounded.panel}"
    padding: "12px 14px"
---

# Design System: dsh-kanban Board

## Overview

**Creative North Star: [not chosen in this session — the human naming question could not be put, see Open Questions]**

The panel is a guest, not a host. It renders inside the DSH desktop app's left sidebar as the
**Kanban** entry, under the heading **Board**, and it declares no palette, no font family and no page
background of its own: every colour resolves through one of the app's `--dsw-*` theme tokens, so light
and dark arrive for free and a theme change needs no edit here. PRODUCT.md makes this binding —
"carrying its own palette is not on offer" — and the code obeys it down to the fallbacks, which exist
only so a missing token degrades rather than breaks. Density is the aesthetic: 13px body text, a 7px
working rhythm, five fixed 236px lanes that scroll sideways rather than compress, and a card whose
whole summary is three short rows.

The surface is flat and border-only. There is no `box-shadow` anywhere in the stylesheet, no
gradient, no transition and no keyframe; depth is carried by a 1px hairline, a radius, and two tiers
of grey tint (a lane sits on `bg-layer-1`, a card on `bg-base`, a hover on `bg-layer-2`). Colour is
rationed to the point of austerity: the neutrals do nearly all the work, brand blue appears only
where something is interactive or is being dropped on, and red and amber carry meaning — refusal,
exception, ageing, blockage — rather than emphasis. De-emphasis is done with `opacity`, never with a
second foreground colour.

Typography is not a decision this panel makes: it inherits the app's face and authors only a scale
(18/13/12px) plus one rule — monospace marks identity and measurement, not "technical" flavour. Card
ids, lane counts, priority badges, flow metrics, history rows and the `rev · cards` sub-line are
monospace; titles, labels and buttons are not. Copy is plain and specific: controls name their action
("Dismiss", "Refresh", "Add", "Drop", "Unblock"), refusals name the missing thing
(`missing: outcome, acceptance`) instead of blaming the input.

Every value in this document is read from `src/client/styles.ts` and `src/client/components.ts`; the
one externally-derived fact, the set of theme tokens the app actually provides, is checked by
`test/client.dom.test.ts`. Nothing here is proposed, and nothing is filled in where the code is
silent — those places are listed under Open Questions.

**Key Characteristics:**
- Zero shadows, zero motion, zero media queries; depth and grouping come from 1px borders, radius and tint.
- Eight of the app's fourteen theme tokens are consumed; six are provided and unused.
- One accent (brand), two meaning colours (error red, warn amber), everything else neutral.
- Fixed 236px lanes in a horizontally scrolling row; the board never reflows to fit.
- Monospace is reserved for identity, machine vocabulary and measurement.
- De-emphasis is an opacity ladder (0.5–0.85), not a secondary text token.
- The drawer is inline and scrollable, never a modal; every card action has a keyboard path.

## Colors

A borrowed, border-driven palette: greyscale structure inherited from the app, with exactly three
coloured tokens carrying all of the meaning.

### Primary
- **Interactive accent — brand primary** (`var(--dsw-alias-brand-primary, #4c8bf5)`): the only accent. It marks a pressed button's border and text, a hovered card's border, a focused card's 2px outline, a lane that a card is currently over (2px dashed outline, inset 3px), and the left edge of an informational notice. It is never used for headings, backgrounds or decoration.

### Secondary
- **Refusal red — state error** (`var(--dsw-alias-state-error-primary, #d64545)`): the refusal and exception colour, in four unrelated places that all mean "stopped": the 3px left border of a refusal or error notice, the 3px left border of an `expedite` card, a lane count that has passed its WIP limit, and the `P0` badge plus a card whose age has passed `1.5 × SLE`.
- **Ageing amber — state warn** (`var(--dsw-alias-state-warn-primary, #d68945)`): the "needs attention, not stopped" colour: the 3px left border of a blocked card, the `P1` badge, a card whose age has passed the SLE but not `1.5 ×` it, and an unticked Definition of Ready / Definition of Done row.

### Neutral
- **Foreground — label primary** (`var(--dsw-alias-label-primary, inherit)`): the page's text colour, set once on `.kb-page` and inherited by everything; controls and inputs re-state `color: inherit` rather than naming a token.
- **Hairline — border l1** (`var(--dsw-alias-border-l1, rgba(128,128,128,0.32))`): every border in the panel — buttons, chips, inputs, notices, lanes, cards, drawer. It is the system's primary structural device, which is why its fallback literal drifts between rules (see Open Questions).
- **Card surface — bg base** (`var(--dsw-alias-bg-base, transparent)`): a card's background. Transparent by fallback, so a card is delineated by its hairline first and its tint second.
- **Lane surface — bg layer 1** (`var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.04))`): the lane's background — the only large tinted area on the board, and the reason a card reads as raised without a shadow.
- **Raised tint — bg layer 2** (`var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12))`): button hover, and the `.kb-chip-kb` chip that marks sprint membership and the active sprint.
- The page itself paints no background: `.kb-page`, `.kb-notice`, `.kb-drawer`, `.kb-btn` and `.kb-input` are all transparent, so the host's panel fill shows through.

### Named Rules
**The Borrowed Palette Rule.** The panel owns no colour. Every value resolves to a `--dsw-*` token; the literal after the comma is a fallback for a missing token, never a colour to design with. A new screen that needs a colour needs a token the app already provides.

**The Rationed Accent Rule.** Brand blue appears in exactly five places — a pressed button's border and text, a hovered card's border, a focused card's ring, a lane being dropped on, and an info notice's left edge — and nowhere else. A coloured heading, background block or decorative border has no precedent here.

**The Meaning-Only Red Rule.** Red and amber are semantic, not decorative. Red means refused, excepted, P0 or stale; amber means blocked, P1, ageing or incomplete. Neither is available for emphasis.

**The Opacity Ladder Rule.** De-emphasis is `opacity`: 0.5 disabled, 0.6 sub-line and empty state, 0.65 dim text and lane count, 0.7 card id, 0.8 the missing-checks list, 0.85 card meta, 1.0 when a lane is over limit. The app provides `--dsw-alias-label-secondary` and this panel does not use it.

## Typography

**Display Font:** inherited from the host app — the panel declares no `font-family` for prose
**Body Font:** inherited from the host app (13px base set on `.kb-page`)
**Label/Mono Font:** `ui-monospace, SFMono-Regular, Menlo, monospace` (declared inline, seven times)

**Character:** deliberately faceless. The panel takes the app's letterforms so it reads as part of the same product, and spends its only typographic voice on a single distinction: proportional for prose, monospace for anything that is an identifier, a count, a machine value or a measurement.

### Hierarchy
- **Display** (600, 18px, 1.5): the board heading — the store's board title, defaulting to "Board". One per panel, `margin: 0`.
- **Body** (400, 13px, 1.5, inherited family): everything else — card titles, button labels, field values, checklist labels, notice text. Line length is governed by the panel's narrow column, not by a `ch` measure.
- **Label** (400, 12px): monospace where it marks data — card ids, lane counts, priority badges, flow metrics, the sprint chip, history rows, the `missing:` list, the `rev N · M cards` and `host …` sub-lines — and the same 12px in the inherited face for chips, the card meta row and the drawer's list rows.

### Named Rules
**The Monospace Is Data Rule.** Monospace marks an identifier or a measurement — card id, lane count, priority badge, metrics, history, the `rev · cards` line, the `missing:` vocabulary — never "technical" flavour, never a title, never body copy.

**The One Heading Rule.** The panel has exactly one heading, at 18px/600. Section labels inside the drawer are 12px dim spans (`Definition of Ready`, `history`), not headings — the scale has no second display step.

## Layout

A single flex column filling the panel: `.kb-page` is `display: flex; flex-direction: column; height: 100%; min-height: 0`, with a 10px gap between the header, the toolbar, any notices, the metrics strip, the lanes, the sprint bar and the drawer, and `14px 16px 18px` of padding.

**The board is the horizontal axis.** `.kb-lanes` is a `display: flex` row with `overflow-x: auto`, `align-items: flex-start`, `flex: 1 1 auto`, `gap: 10px`, `padding-bottom: 6px` and `min-height: 120px`. Each `.kb-lane` is `flex: 0 0 236px` — it can neither grow nor shrink — so the board always scrolls sideways instead of reflowing. At the ~1000px sidebar column PRODUCT.md records, five 236px lanes plus four 10px gaps plus 32px of page padding cannot fit; horizontal scrolling is the normal state, not a fallback. (That arithmetic is derived from the observed values and the recorded column width; it is not itself a token.)

**Five lanes, six states.** `BOARD_STATES` filters `dropped` out of the drawn columns, so the board renders Backlog, Ready, In Progress, Review and Done. `dropped` has no lane; a dropped card is removed from the board entirely rather than shown in a sixth column.

**Vertical structure inside a lane:** a header row (name at 600, count in monospace, and an "over limit" pill when the state has a cap), then the card list at `min-height: 36px`. Lane count text is `M` for uncapped states and `M/N` for Ready (`readyCap`, default 5), In Progress (WIP 2) and Review (WIP 1); a count past its limit turns red and is forced back to full opacity, overriding the 0.65 dim. An empty lane says "nothing here" at 60% opacity and 10px/2px padding.

**Narrowness is absorbed by wrapping, not by breakpoints.** There are no `@media`, `@container` or `@supports` rules in the stylesheet. The header, the toolbar, the card meta row and the metrics strip all set `flex-wrap: wrap`; everything else is fixed or scrolls.

**The drawer** is the last child, inline below the board: `max-height: 46%` of the page with its own `overflow: auto`, so opening a card never pushes the lanes off screen and never overlays them. Its inner rows are 12px lists with a 3px gap and a 9px row gap.

**Spacing rhythm.** Spacing is literal pixels, not variables. It clusters: **3px** for list and checklist gaps and the 3px accent borders; **5–6px** inside a card; **7px** as the working rhythm (card gaps, lane gaps, card padding, and — as a radius — buttons, inputs, notices); **8px** for the toolbar gap and chip/input padding; **9px** for lane padding, drawer row gaps and button inline padding; **10px** for section gaps, panel radii and the notice gap; **12px–14px** for drawer padding, metrics gaps and 12px type; **14/16/18px** for page padding.

## Elevation & Depth

**This system has no shadows.** `box-shadow` appears zero times in the stylesheet. Depth is tonal and linear: a 1px hairline on every surface, a radius that steps with the surface's importance (7px control → 8px card → 10px lane and drawer), and a two-step tint — the lane carries `bg-layer-1`, the card carries `bg-base` (transparent by fallback, so often nothing), the hovered control carries `bg-layer-2`. The panel paints no page background at all, so the app's own panel fill is the ground.

Two outline treatments stand in for elevation-as-feedback, and both are reserved: a lane that a card is over gets a 2px **dashed** brand outline inset 3px (unmistakably a drop affordance, not a raised surface), and a focused card gets a 2px **solid** brand outline offset 1px.

**There is no motion.** No `transition`, `animation` or `@keyframes` exists anywhere in `src/`, and no `prefers-reduced-motion` query is needed because nothing animates: hover, drag-over, the optimistic move, the refusal and the rollback all land in a single frame. The stylesheet is also silent on browser surfaces the craft floor asks about — selection, caret and scrollbar colours are the host's defaults, and no custom scrollbar is authored for the sideways board or the drawer.

### Named Rules
**The No-Shadow Rule.** Surfaces are flat at rest and flat under the pointer. Depth comes from a hairline, a radius and a grey step, never from `box-shadow`; a raised look is bought with `bg-layer-2`, not blur.

**The Instant-State Rule.** Every state change is applied in one frame. The stylesheet declares no transition, animation or keyframe, and a load-bearing transition would contradict PRODUCT.md's confirmed reduced-motion commitment.

## Shapes

The form language is **rectilinear and lightly rounded** — one radius scale applied by surface role, and nothing else. Controls (buttons, inputs, notices) take 7px; cards take 8px; lanes and the drawer take 10px; chips are fully pill-shaped at 999px. The sidebar icon rounds its three bars with `rx: 1.2` in a 20-unit viewBox, matching the family.

Every shape is closed by a 1px hairline in `border-l1`. There is no border-radius mixing, no clipping (`overflow` is only ever `auto`, for the lane row and drawer body), no irregular silhouette and no geometric mask. The one deliberate break in the hairline is a **3px coloured left border**, used twice on cards (red for `expedite`, amber for blocked) and on notices (red for refusal and error, blue for info) — it is the panel's only non-uniform edge, and it is how a card's exception is visible from across the board.

The card's own geometry is a three-row stack: an identity row (id, priority, age) on baseline, a title row that takes the remaining width, and a wrapping meta row of pills. Nothing is clipped; a long title wraps rather than truncating.

## Components

The vocabulary is one stylesheet of `kb-`-prefixed classes and plain `React.createElement` calls. Every `kb-` class is defined exactly once in `styles.ts`, and every defined class has a consumer. The reverse does not hold: two class families are generated by string template and only some of their members are styled — `kb-age-{fresh|ageing|stale}` defines `ageing` and `stale` only, and `kb-pri-{p0..p4}` defines `p0` and `p1` only. The unstyled members are not broken; they simply inherit the foreground colour (see Open Questions).

### Buttons
- **Shape:** 7px radius, 1px `border-l1` border, transparent background, `padding: 3px 9px`, `font: inherit`, `line-height: 1.4`, `cursor: pointer`.
- **Primary:** there is no button hierarchy. One `.kb-btn` serves header actions, view filters, drawer moves, Block/Unblock, Drop, Comment, Dismiss, Close and the checklist rows — the same quiet outline in every case, distinguished only by its label.
- **Hover:** `background: bg-layer-2` and nothing else — no border, colour, shadow or transform change.
- **Pressed:** `[aria-pressed="true"]` turns border *and* text brand blue. It is authored for exactly one consumer: a ticked checklist row, which composes `kb-check kb-btn`. The `aria-pressed` attribute is set nowhere else.
- **Disabled:** `opacity: 0.5; cursor: default`. Used by "Add" with an empty title, "Drop" with an empty reason, and "Comment" with an empty body — the button that would create nothing is present but inert.
- **Focus:** no authored focus style; the browser's default focus ring is what a keyboard user sees.

### Chips
- **Style:** pill (999px), 1px `border-l1` border, transparent background, `padding: 1px 8px`, 12px.
- **State:** purely informational — a chip is never selectable, never a filter, and carries no pressed or active variant. On a card they show class of service (when not `standard`), `blocked`, assignee, project and sprint. In a lane header they say "over limit". The `.kb-chip-kb` variant adds `bg-layer-2` and marks sprint membership and the active sprint.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** `bg-base` (transparent by fallback) on the lane's `bg-layer-1`, so the card reads through its hairline and the lane's tint.
- **Shadow Strategy:** none — see Elevation & Depth.
- **Border:** 1px `border-l1`, plus a 3px left border in red for `expedite` and amber for blocked. A card can carry both classes; the blocked rule is declared second, so on a card that is both, amber wins.
- **Priority badge:** `P0`–`P4` in 600-weight monospace, built by slicing the priority to two characters. Only `P0` (red) and `P1` (amber) have rules; `P2`, `P3` and `P4` have no colour rule and render in the inherited foreground, so only the top two priorities are coloured.
- **Age badge:** `3d` / `0.5d` / `—`, banded against the SLE — amber past the SLE, red and bold past `1.5 ×` it, and the `fresh` band (including a card that has never started) has no rule and inherits the foreground.
- **Internal Padding:** `7px 9px`, with a 5px gap between the three rows and 7px/6px gaps inside them.
- **States:** hover promotes the **border** to brand blue; `:focus-visible` draws a 2px brand outline at offset 1px; `cursor: grab` at rest. No `:active` or dragging cursor is declared. A card is `draggable`, `tabIndex: 0`, `role="button"`, labelled `"{id} {title}, {state}, {priority}"`, and carries `data-card="{id}"`.
- **Order inside a column** is expedite, then hand-set position, then priority rank, then id — position is the truth and priority is a badge.

### Inputs / Fields
- **Style:** 1px `border-l1` border, transparent background, `color: inherit`, 7px radius, `padding: 3px 8px`, `font: inherit`, `min-width: 140px`. Types in use: `search` for the card filter, `text` for new-card title, drop reason and comment.
- **Focus:** no authored focus style — the browser default applies.
- **Error / Disabled:** no error state and no disabled state is styled; validation is expressed by leaving the paired button disabled until the field has content. Placeholders are lowercase and trailing-ellipsised: `search cards…`, `new card…`, `comment…`, `reason to drop…`.

### Navigation (the toolbar and view switcher)
- **Style:** a `flex-wrap: wrap` row at an 8px gap, holding the search field, one button per saved view (title-attribute tooltip carrying the view's description), an "All" button that clears the filter, a spacer, then the new-card field and its "Add" button.
- **State:** all of these are the same `.kb-btn`; the active view is **not** visually marked, because none of them sets `aria-pressed`. The classes for a pressed button exist and are unused here.
- The header row above it carries the heading, a monospace `rev N · M cards` sub-line, a spacer, a monospace `host {origin} · {source}` sub-line, and Refresh.
- There is no navigation chrome beyond this: no tabs, no breadcrumb, no modal, no tooltip component (tooltips are the native `title` attribute), and no mobile treatment — the panel is a desktop sidebar surface.

### Signature Component: the Card's Dual Path
A card is not a list row. It is a `role="button"` that carries three independent interactions on one surface: pointer drag with a drop index computed from the pointer's Y against each card's midpoint, `Alt+←/→` to move it one lane along the board order (announcing "T06 moved to review" or "T06 is already at the edge of the board"), and `Enter` or a click to open the drawer. All three land in the same store call, so the keyboard path passes the same gates as the drag — a refusal reads the same either way. Cards are sorted with `expedite` first so the one exception to WIP control is visible without opening anything.

### Signature Component: the Sidebar Icon
An inline SVG, `viewBox="0 0 20 20"`, `fill: none`, `stroke: currentColor`, `aria-hidden`, `strokeWidth` 1.4 at rest and 1.8 when the row is active. Three rounded bars of decreasing height (`rx: 1.2`) at x = 2.5 / 8.1 / 13.7, y = 3, heights 14 / 10 / 7 — a board seen down its lanes. It takes `{ size, active }` from the sidebar row and defaults to 20px when `size` is not a number. The entry is labelled **Kanban**.

## Do's and Don'ts

### Do:
- **Do** style every colour through a `--dsw-*` token with a literal fallback, exactly as `styles.ts` does — the app's theme is the palette, and it must work in both modes without an edit.
- **Do** use `border-l1` hairlines, radius (7/8/10/999px) and the three background tiers to separate surfaces; that is the whole depth vocabulary.
- **Do** keep lanes at `flex: 0 0 236px` inside an `overflow-x: auto` row and let the board scroll sideways.
- **Do** de-emphasise with `opacity` (0.5 disabled, 0.6 sub/empty, 0.65 dim, 0.7 id, 0.8 missing, 0.85 meta).
- **Do** use monospace for card ids, lane counts, priority badges (`P0`…`P4`), flow metrics, history rows and the `rev · cards` line.
- **Do** reserve brand blue for interaction (pressed, hovered border, focus ring, drag-over lane, info) and red/amber for meaning (refusal/exception/P0/stale, and blocked/P1/ageing/missing).
- **Do** keep the card drawer inline, below the board, at `max-height: 46%` with its own scroll.
- **Do** keep the 3px left border as the only means of flagging an exception on a card, and label every refusal with the specific thing that is missing.
- **Do** keep a keyboard path for every pointer action, and announce state changes through the single `aria-live` region.

### Don't:
- **Don't** introduce a colour that is not one of the app's `--dsw-*` tokens. Invented `--dsw-*`/`--dsh-*` names resolve to nothing and fall back silently; the panel shipped ten of them once and was off-theme in both modes.
- **Don't** hardcode a hex, `rgba()` or `oklch()` value as a design colour — the literals in `styles.ts` are fallbacks for absent tokens.
- **Don't** add `box-shadow`, a gradient, a glass/blur treatment or a coloured `border-left` wider than 3px.
- **Don't** add a transition, animation or keyframe to a state change, and never make one load-bearing.
- **Don't** paint a page background — `.kb-page`, notices, the drawer, buttons and inputs stay transparent so the host panel shows through.
- **Don't** give the board a sixth lane for `dropped`, or any other lane beyond the five `BOARD_STATES`.
- **Don't** use red or amber for emphasis, size or decoration.
- **Don't** introduce a second text colour where the opacity ladder will do.
- **Don't** make the drawer, the drop-reason prompt or any board action a modal dialog — dropping needs a written reason, so it is an inline field whose button stays disabled until there is one.
- **Don't** use monospace for prose, titles or button labels.

## Open Questions & Unresolved Gaps

Recorded deliberately, in place of values. `/impeccable document` was run non-interactively, so
Step 3's qualitative round never reached the human; nothing below has been guessed to fill the space.

1. **The Creative North Star is unchosen, and the descriptive colour names are unwritten.** The procedure's Step 3 requires the human to pick a named metaphor for the system and to name its key colours in prose ("Deep Muted Teal-Navy", not "blue-800"). The `ask_user_question` call was refused by the harness — human interaction is unavailable while this agent is owned by another live agent — so Overview carries a placeholder and each colour is identified by its token role. The craft-floor and overview-voice questions the procedure also asks for — mood adjectives, aesthetic philosophy, an anti-reference, and the component philosophy in one phrase — are unanswered for the same reason. Elevation and component philosophy were confirmed from the code instead (no shadows; one outline button), but the human never ratified those readings.
2. **The app's live token *values* are not recorded here.** The frontmatter carries each token reference verbatim plus the fallback literal the stylesheet declares, because the actual value belongs to the host app and changes with its theme. Two attempts to read them from the running app (`cordis_inspect_query platform=client provider=Theme method=listTokens`) timed out after 10s, and the served GUI requires authentication, so the light/dark hexes are unknown from inside this repository. The token *names* are not guesswork: `test/client.dom.test.ts` pins the app's fourteen-token set against a live Theme query dated 2026-10-16.
3. **`--dsw-specific-sidebar-fill` is named as binding and never used.** PRODUCT.md's Brand Commitments list it alongside `--dsw-alias-*` as a token the panel must use, and it is one of the app's fourteen. No rule in `src/client/styles.ts` references it. Whether some element (the page, the lane row, the drawer) is meant to carry the sidebar fill is unresolved.
4. **Two provided tokens are unused, one of them deliberately.** `--dsw-alias-label-secondary` is provided and unused because de-emphasis is done with opacity; `--dsw-alias-state-success-primary` is provided and unused, so a `done` card looks exactly like a `review` card and nothing marks completion in colour. Whether the opacity ladder is a decision or drift, and whether `done` should be coloured, are both unrecorded.
5. **Focus is authored for cards only.** `.kb-card:focus-visible` draws a 2px brand outline, but `.kb-btn`, `.kb-input` and `.kb-check` declare no focus style and rely on the browser default ring. PRODUCT.md commits to "visible focus on every interactive control" — whether the default ring satisfies that is unresolved.
6. **Other unauthored interactive states.** There is no `:active` for any control, no dragging cursor on a card (only `cursor: grab`), and no `:disabled` colour change beyond `opacity: 0.5` on buttons. The craft floor's states checklist (hover, disabled, loading, error, empty) is only partly authored: empty and disabled have treatments, error is a `.kb-notice-error` string rather than a styled state, and there is no dedicated loading treatment — while the first payload is null the header sub-line simply reads `connecting…` at 60% opacity.
7. **Over-limit is signalled in two places, and only one is coloured.** An over-limit lane gets a red full-opacity count, and a plain uncoloured "over limit" chip in the lane header; the lane's own border and background do not change. Whether the chip should also carry the error colour is unrecorded.
8. **The active view is invisible.** The toolbar renders one `.kb-btn` per saved view plus "All", and each sets the filter, but none sets `aria-pressed`, so the `[aria-pressed="true"]` brand treatment — authored and used by the checklist rows — never marks the current view. How a human is meant to see which view is active is unresolved.
9. **`dropped` cards are unreachable from the panel.** `dropped` has no lane (by design, per `model.ts`), it is absent from the drawer's move-target list, and `byStateThenColumn` in `model.ts` is exported but never called — there is no list view to reach it through. A dropped card therefore disappears from the panel while remaining in the store and the metrics. Whether that is intended is unrecorded.
10. **The `border-l1` fallback literal is inconsistent across rules** — `rgba(128,128,128,0.28)` on lanes, `0.3` on chips, `0.32` on cards, `0.35` on buttons, notices, inputs and the drawer. The frontmatter records the card's 0.32 as the representative value. Which alpha is intended, or whether the drift is deliberate (lighter structure for larger surfaces), is unresolved.
11. **The mono and the check glyphs sit against the craft floor.** `.kb-check` renders its tick state as the Unicode glyphs `☐`/`☑` rather than a drawn icon, and monospace is used for the drawer's history rows as well as for pure measurement. The craft floor refuses Unicode standing in for an icon system. Both are the incumbent behaviour and are recorded as fact, not as defects — no change is proposed here.
12. **The sidebar icon's real rendered size is unknown.** `createKanbanIcon` defaults to 20px when `size` is not a number, but the value the app's `sidebar.panellist` row actually passes is not recorded in this repository.
13. **Two dynamically-generated class members have no rule.** `kb-age-{band}` styles `ageing` and `stale` but not `fresh`, and `kb-pri-{p0..p4}` styles `p0` and `p1` but not `p2`, `p3` or `p4`. The effect is coherent — only exceptions and the top two priorities are coloured, everything else inherits the foreground — but whether that restraint is intended or an omission is unrecorded.
