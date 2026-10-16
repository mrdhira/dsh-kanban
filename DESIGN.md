---
name: dsh-kanban Board
description: A dense, flat, hairline-and-tint Kanban panel that wears the DSH desktop app's own theme tokens instead of a palette of its own, leading with two numbers and one primary move.
colors:
  # Each value is the exact string src/client/styles.ts resolves with, verbatim: the token reference
  # plus the declared fallback. Every one of the sixteen names below appears in the stylesheet; there
  # are no other `--dsw-*` references in the client half. The fallback literals a role shares with
  # another rule are declared once in `:root` as `--kb-*` properties (see kb-role-fallbacks); the
  # value recorded here is the one those properties hold. Where a token's fallback is a nested token
  # chain, the innermost literal is what the entry records.
  brand-primary: "var(--dsw-alias-brand-primary, #4c8bf5)"
  state-error: "var(--dsw-alias-state-error-primary, #d64545)"
  state-warn: "var(--dsw-alias-state-warn-primary, #d68945)"
  state-success: "var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary, inherit))"
  label-primary: "var(--dsw-alias-label-primary, inherit)"
  label-secondary: "var(--dsw-alias-label-secondary, rgba(128,128,128,0.9))"
  label-tertiary: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, rgba(128,128,128,0.9)))"
  border-l1: "var(--dsw-alias-border-l1, rgba(128,128,128,0.35))"
  border-l2: "var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, rgba(128,128,128,0.5)))"
  bg-base: "var(--dsw-alias-bg-base, transparent)"
  bg-layer-1: "var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.04))"
  bg-layer-2: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12))"
  scrollbar-bg-l1: "var(--dsw-alias-scrollbar-bg-l1, var(--kb-label-secondary))"
  scrollbar-bg-l2: "var(--dsw-alias-scrollbar-bg-l2, transparent)"
  scrollbar-hover-l1: "var(--dsw-alias-scrollbar-hover-l1, var(--kb-label-secondary))"
  bg-document-selection: "var(--dsw-alias-bg-document-selection, rgba(128,128,128,0.25))"
  kb-role-fallbacks: "--kb-border-l1: rgba(128,128,128,0.35); --kb-bg-layer-2: rgba(128,128,128,0.12); --kb-label-secondary: rgba(128,128,128,0.9)"
typography:
  display:
    fontFamily: "inherit"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.25
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
  control-gap: "3px"
  card-row: "5px"
  meta: "6px"
  rhythm: "7px"
  bar: "8px"
  row: "9px"
  section: "10px"
  drawer: "12px"
  metrics: "14px"
  page: "14px 16px 18px"
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
    backgroundColor: "{colors.bg-layer-2}"
    textColor: "{colors.label-primary}"
    rounded: "{rounded.control}"
  disclosure-toggle:
    backgroundColor: "transparent"
    textColor: "{colors.label-primary}"
    rounded: "{rounded.control}"
    padding: "1px 7px"
    typography: "{typography.label}"
  chip:
    rounded: "{rounded.pill}"
    padding: "1px 8px"
    typography: "{typography.label}"
  card:
    backgroundColor: "{colors.bg-base}"
    textColor: "{colors.label-primary}"
    rounded: "{rounded.card}"
    padding: "7px 9px"
  card-mark:
    textColor: "{colors.state-success}"
  lane:
    backgroundColor: "{colors.bg-layer-1}"
    rounded: "{rounded.panel}"
    padding: "9px"
    width: "236px"
  lane-rail:
    backgroundColor: "{colors.bg-layer-1}"
    rounded: "{rounded.panel}"
    padding: "9px 5px"
    width: "46px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.label-primary}"
    rounded: "{rounded.control}"
    padding: "3px 8px"
  select:
    backgroundColor: "transparent"
    textColor: "{colors.label-primary}"
    rounded: "{rounded.control}"
    padding: "3px 4px 3px 8px"
  notice:
    rounded: "{rounded.control}"
    padding: "7px 11px"
  drawer:
    rounded: "{rounded.panel}"
    padding: "12px 14px"
---

# Design System: dsh-kanban Board

## Overview

**Creative North Star: "A departures board for work: the state of play legible in one glance, and every card's next legal move one interaction away."**

*This metaphor is **proposed by this regeneration and awaits Dhira's confirmation** — it has not been ratified. Everything else in this file is read from the code.*

The panel is a guest, not a host. It renders inside the DSH desktop app's left sidebar as the **Kanban** entry, under the heading **Board**, and it declares no palette, no font family and no page background of its own: every colour resolves through one of the app's `--dsw-*` theme tokens, so light and dark arrive for free and a theme change needs no edit here. PRODUCT.md makes this binding — "carrying its own palette is not on offer" — and the code obeys it down to the fallbacks, which exist only so a missing token degrades rather than breaks. Density is the aesthetic: 13px body text, a 7px working rhythm, five fixed 236px lanes that scroll sideways rather than compress, and a card whose whole summary is three short rows.

The surface is flat, hairline-driven and tonal. There is no `box-shadow` anywhere in the stylesheet, no gradient and no keyframe; depth is a 1px hairline, a radius that steps with the surface's importance, and the app's background tiers (a lane on `bg-layer-1`, a card on `bg-base`, a hover on `bg-layer-2`). What the panel *does* author is response: one 140ms ease-out transition on background, border and transform, a 1px press nudge, and a shared focus ring — all of it switched off under `prefers-reduced-motion`. Colour is rationed to the point of austerity. The token named `brand-primary` resolves, in this app, to the same value as `label-primary` — so "the accent" is the foreground, not a hue, and the blue in the declared fallback never reaches the screen when the token is present. Red, amber and green each carry one meaning and no emphasis.

A distill pass reshaped the surface without removing a capability: the state-filter chip row is gone and the views are the panel's state filtering; creation is a title and `Add`; the metrics strip leads with two numbers and hides its history behind a disclosure; the drawer leads with one move and hides the rest behind `More…`; and the cards carry only what demands a decision. The disclosure is now a **first-class primitive** — a real `<button>` with `aria-expanded`, used twice on the panel (the metrics strip and the `Host` line) and twice more inside the drawer (`More…`, `Exception…`) — and the two-number metrics strip is a **first-class component**, not a row of equal facts.

Typography is not a decision this panel makes: it inherits the app's face and authors only a scale (18/13/12px) plus one rule — monospace marks identity and measurement, not "technical" flavour. Card ids, lane counts, priority codes, flow metrics, history rows, the drawer's `rev · started · finished` line and the `host …` sub-line are monospace; titles, labels and buttons are not. Copy is plain and specific: controls name their action ("Dismiss", "Refresh", "Add", "Drop", "Unblock"), a refusal names the missing thing (`missing: outcome, acceptance`) instead of blaming the input, and every state that colour carries is also spelled out in words, because the light theme cannot carry amber as text.

Every value in this document is read from `src/client/styles.ts` and `src/client/components.ts`. The one externally-derived fact — what the app's tokens *resolve to* — was read again on 2026-10-16 from the installed app's own design-platform stylesheet inside `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`, by scanning the file in bounded chunks (the plain `body` block is light, the `body[data-ds-dark-theme]` block is dark); all sixteen tokens resolved in both scopes, so no value here falls back to a literal. Nothing here is proposed except the North Star line above, and nothing is filled in where the code is silent — those places are listed under Open Questions.

**Key Characteristics:**
- Zero shadows, zero gradients, zero keyframes; depth comes from 1px hairlines, a radius step and the app's tint tiers.
- Sixteen `--dsw-*` tokens carry every colour (12 roles plus the scrollbar ladder and the document-selection fill); `--dsw-alias-brand-primary` resolves to the same value as `--dsw-alias-label-primary`, so the accent is monochrome in practice.
- Three role fallback literals (`--kb-border-l1`, `--kb-bg-layer-2`, `--kb-label-secondary`) are declared once in `:root`, so a role has one alpha instead of the four `border-l1` had drifted into.
- One authored motion moment, stated as such in the sheet: 140ms `ease-out` on `background-color`, `border-color`, `transform` and the disclosure caret, with `prefers-reduced-motion: reduce` switching it off.
- Amber and `--dsw-alias-label-tertiary` are **dark-theme enhancements only**, because both fail AA on the light theme (2.15:1 and 3.71:1 on white).
- A disclosure primitive with `aria-expanded` — a real button, never `<details>` — carrying a drawn caret that flips, so its open state is not colour alone and not a pressed-button lookalike.
- The metrics strip leads with two numbers (`WIP n/limit`, `oldest Xd vs SLE Yd · N past`) and puts the cycle's median, p85 and mean, throughput and the SLE's basis behind `More metrics`.
- Fixed 236px lanes in a horizontally scrolling row; an empty lane is a 46px rail that opens to full width while a drag is live.
- **View row: Board / Ageing / All / Dropped.** `Dropped` renders the one lane the board does not draw, so a dropped card is reachable; the default board is still five lanes and `All` is still the escape.
- The drawer leads with one primary move; Block, Drop, their reasons, `Exception…` and the numeric position sit behind `More…`. A dropped card's primary move is the way back to the first lane.
- Monospace is reserved for identity, machine vocabulary and measurement.
- State is a 1px state-coloured border plus a word — never a thick side stripe, never colour alone.
- Browser surfaces are authored: `::selection`, `caret-color` and the two scrollbars come from the app's own tokens, not from the browser defaults.

## Colors

A borrowed, border-and-tint palette: greyscale structure inherited from the app, with exactly four coloured tokens — one accent and three meaning colours — carrying all of it. Every entry below records the token reference (which the frontmatter also carries, verbatim) and then the value the app's own stylesheet resolves it to in each theme; the reference is the source of truth, the resolution is context.

### Primary
- **Interactive accent — brand primary** (`var(--dsw-alias-brand-primary, #4c8bf5)` → `#0f1115` light / `#f9fafb` dark): the app maps this token onto its first foreground value, so on screen it is a near-black in light and a near-white in dark — the same value `label-primary` resolves to, **not** a hue. It marks a hovered card's border, every focus ring, and an informational notice's border. The `#4c8bf5` after the comma is a declared fallback the panel invented; with the token present it is never painted, and it is not one of the app's blue steps (`--dsw-static-blue-450` is `#4d93f8`).

### Secondary
- **Refusal red — state error** (`var(--dsw-alias-state-error-primary, #d64545)` → `#ec1313` light / `#f25a5a` dark): the "stopped" signal, in five places: the 1px border of a refusal or error notice, the 1px border of an `expedite` card, a lane count that has passed its WIP limit, the `P0` code in a card's top row, and a card whose age has passed `1.5 × SLE`. It measures 4.50:1 on the light surface and 5.55:1 on the dark one (4.77:1 on the dark card), so it is the one state colour allowed to be text in both themes.

### Tertiary
- **Attention amber — state warn** (`var(--dsw-alias-state-warn-primary, #d68945)` → `#f59e0b` in both themes): "needs attention, not stopped" — the 1px border of a blocked card in *both* themes, and, **in dark only**, the `P1` code, the `ageing` age and an unticked checklist row. It never carries **text** outside `body[data-ds-dark-theme]`, because on light it measures 2.15:1 on white; as a 1px border it is not text, and it is not gated.
- **Completion green — state success** (`var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary, inherit))` → `#22c55e` in both themes): one consumer, the drawn tick that marks a `done` card's top row. Its fallback chain ends at the ordinary label colour, so a missing token degrades to "marked" rather than to nothing.

### Neutral
- **Foreground — label primary** (`var(--dsw-alias-label-primary, inherit)` → `#0f1115` light / `#f9fafb` dark): the page's text colour, set once on `.kb-page` and inherited by everything; controls and inputs re-state `color: inherit` rather than naming the token again.
- **De-emphasis — label secondary** (`var(--dsw-alias-label-secondary, rgba(128,128,128,0.9))` → `#61666b` light / `#cfd3d6` dark): the panel's de-emphasis device. It carries the sub-lines, the lane count, card ids, the card meta row, the notice's `missing:` list, `.kb-dim` rows, empty-lane text, every placeholder, and — as `currentColor` — the dashed drop ring.
- **Dimmest tier — label tertiary** (`var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, rgba(128,128,128,0.9)))` → `#81858c` light / `#adb2b8` dark): a dark-theme-only *enhancement* over `label-secondary`, applied to the header sub-lines, placeholders and empty-lane text. It is 8.54:1 in dark but only 3.71:1 on light, so it is named only inside `body[data-ds-dark-theme]`.
- **Hairline — border l1** (`var(--dsw-alias-border-l1, rgba(128,128,128,0.35))` → `#0000000a` light / `#ffffff0f` dark): every resting border in the panel — buttons, disclosure toggles, chips, inputs, notices, lanes, cards, the drawer, and the two dividers that open a `More…` fold and set off the destructive group. It is the system's primary structural device.
- **Stronger hairline — border l2** (`var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, rgba(128,128,128,0.5)))` → `#0000001a` light / `#ffffff1f` dark): a pressed button's border and an input's hover border. Two consumers, both state.
- **Card surface — bg base** (`var(--dsw-alias-bg-base, transparent)` → `#fff` light / `#151517` dark): a card's background. In light it is the same `#fff` the lane carries; the card is separated from the lane by its hairline and radius, not by tone.
- **Lane surface — bg layer 1** (`var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.04))` → `#fff` light / `#232324` dark): the lane's and the rail's background — the only large tinted area on the board, and the reason a card reads as raised without a shadow. In light, the lane is white on the sidebar's own `#f9fafb`.
- **Raised tint — bg layer 2** (`var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12))` → `#fff` light / `#2c2c2e` dark): button hover, a pressed button's fill, a lane a card is over, and the `.kb-chip-kb` chip that marks the active sprint.
- The page itself paints no background: `.kb-page`, `.kb-notice`, `.kb-drawer`, `.kb-btn` and `.kb-input` are all transparent, so the host's panel fill shows through.

### Named Rules
**The Borrowed Palette Rule.** The panel owns no colour. Every value resolves to a `--dsw-*` token; the literal after the comma is a fallback for a missing token, never a colour to design with. A new screen that needs a colour needs a token the app already provides.

**The Accent-Is-The-Foreground Rule.** `brand-primary` and `label-primary` resolve to the same value in this app. Nothing may assume the accent is a hue: a design that leans on "blue" leans on a fallback that is not painted, and a state that must be seen needs weight, a border or a word, not the brand token.

**The AA-Per-Theme Rule.** A colour that fails AA on light may carry text only inside `body[data-ds-dark-theme]`, where it is a redundant enhancement over a default that passes. Amber (`#f59e0b`, 2.15:1 on white) and `label-tertiary` (`#81858c`, 3.71:1) are the two, and the panel's own test refuses any unscoped text use of either.

**The Meaning-Only Rule.** Red means refused, excepted, P0 or stale; amber means blocked, P1, ageing or unticked; green means done. None is available for emphasis, decoration or emphasis-by-size.

## Typography

**Display Font:** inherited from the host app — the panel declares no `font-family` for prose
**Body Font:** inherited from the host app (13px/1.5 base set on `.kb-page`)
**Label/Mono Font:** `ui-monospace, SFMono-Regular, Menlo, monospace` (declared inline, seven times)

**Character:** deliberately faceless. The panel takes the app's letterforms so it reads as part of the same product, and spends its only typographic voice on a single distinction: proportional for prose, monospace for anything that is an identifier, a count, a machine value or a measurement.

### Hierarchy
- **Display** (600, 18px, 1.25): the board heading — the store's board title, defaulting to "Kanban" while the first payload is in flight. One per panel, `margin: 0`.
- **Body** (400, 13px, 1.5, inherited family): everything else — card titles, button labels, field values, checklist labels, notice text, drawer rows (which step down to 12px in `.kb-list`). Line length is governed by the panel's narrow column, except where `.kb-prose` caps a long acceptance line at `62ch` with `text-wrap: pretty`.
- **Label** (400, 12px): monospace where it marks data — card ids, lane counts, priority codes, flow metrics, the sprint chip, history rows, the `missing:` list, and the `rev N · M cards` and `host …` sub-lines — and the same 12px in the inherited face for chips and the card meta row. The metrics strip additionally sets `font-variant-numeric: tabular-nums`, so a changing number does not shift its neighbours.

### Named Rules
**The Monospace Is Data Rule.** Monospace marks an identifier or a measurement — card id, lane count, priority code, metrics, history, the `rev · cards` line, the `missing:` vocabulary — never "technical" flavour, never a title, never body copy.

**The One Heading Rule.** The panel has exactly one heading, at 18px/600. Section labels inside the drawer are 12px dim spans (`detail`, `move`, `block`, `drop`, `Definition of Ready`, `history`), not headings — the scale has no second display step.

## Layout

A single flex column filling the panel: `.kb-page` is `display: flex; flex-direction: column; height: 100%; min-height: 0`, with a 10px gap between the header, the toolbar, any notices, the metrics strip, the lanes, the sprint bar and the drawer, and `14px 16px 18px` of padding.

**The board is the horizontal axis.** `.kb-lanes` is a `display: flex` row with `overflow-x: auto`, `align-items: flex-start`, `flex: 1 1 auto`, `gap: 10px`, `padding-bottom: 6px` and a `min-height: 140px` floor that keeps the drawer from eating the board. Each `.kb-lane` is `flex: 0 0 236px` — it can neither grow nor shrink — so the board always scrolls sideways instead of reflowing. At the ~1000px sidebar column PRODUCT.md records, five 236px lanes plus four 10px gaps plus 32px of page padding cannot fit; horizontal scrolling is the normal state, not a fallback. (That arithmetic is derived from the observed values and the recorded column width; it is not itself a token.)

**Five lanes, six states — and four view controls, not two.** `BOARD_STATES` filters `dropped` out of the drawn columns, so the board renders Backlog, Ready, In Progress, Review and Done. The toolbar's view row is one button per **saved view** (the two a fresh board seeds are `Board`, `backlog → review`, and `Ageing`, `in-progress + review`, each carrying its `description` as a native `title` tooltip) plus an **`All`** button that clears the filter, plus a **`Dropped`** button that names the one state the board will not draw. `All` is the only control that shows `done` cards, so it is the way back out of both views rather than a third peer; `Dropped` is the only control that shows a dropped card, which is what makes dropping reversible from the panel instead of only from the CLI — the card left the board entirely before this pass. Each button whose filter matches the live one carries `aria-pressed="true"` via a canonical `sameFilter` comparison, and the header's sub-line folds the truth about the count into the revision: `rev N · M cards` only when every card the board holds is drawn, and `rev N · showing X of Y cards` whenever what is drawn is fewer — a filter, a `dropped` card with no lane, or a truncated read. The chip row that used to repeat the lane headers here is gone.

**Pending is a state the board row carries.** While the first read is in flight the board still draws its five lanes — from `BOARD_STATES`, the board's own state order, not from any saved view or default DoW — with no card, no invented count and **no cap**: the Definition of Workflow arrives with the payload, so a pending lane prints its name and a bare `0` rather than a `0/N` that could contradict the board it is standing in for. Each lane holds one dashed `.kb-skeleton` line where a card will land, so a pending board reads as pending instead of as an empty one. The row carries `aria-busy` and dims (`kb-lanes-loading`); a write in flight uses the same row and a different class (`kb-lanes-busy`). Nothing here is animated and nothing spins: the words in the header (`connecting…`) and the state on the row are the whole treatment. A board that *answered* with nothing is a different thing, and keeps the `nothing here` line it always had. The one defect left in this area — a poll landing mid-write can clear the busy flag early — is recorded under *Known defects*.

**A filter that *names* `dropped` is the one thing that changes which lanes are drawn.** `filterStates` returns the board's five lanes for every filter except an explicit `state: ['dropped']`, which returns that single lane — so `All` (the empty filter) is untouched, and a saved view that merely *includes* `dropped` among other states still draws the board. A dropped card's drawer leads with `→ Backlog`, the first lane, because its own state is not in the board order and "the next lane" has no answer for it. Nothing else about a dropped card is special: it keeps the card shape and hairline, takes the dim tier in `.kb-card-dropped`, and moves through the same store call as any other card.

**An empty lane is a rail, not a void.** A lane with no cards takes `.kb-lane-empty`: `flex: 0 0 46px`, `padding: 9px 5px`, its header stacked and its name set `writing-mode: vertical-rl`, its card list `width: 100%` with `min-height: 48px`, and its "nothing here" text hidden. Four empty lanes at 236px each would scroll for nothing. The moment a drag begins, `.kb-lane-awake` restores the full 236px, `writing-mode: horizontal-tb` and the empty-state text — a drop target that cannot be hit is not a drop target. A lane also has a `min-height: 110px` of its own.

**Vertical structure inside a lane:** a header row (name at 600, count in monospace, and an "over limit" pill when the state has a cap), then the card list at `min-height: 36px`. Lane count text is `M` for uncapped states and `M/N` for Ready (`readyCap`), In Progress (WIP) and Review (WIP); a count past its limit turns red. An empty lane says "nothing here" in `label-secondary` with 10px/2px padding.

**Narrowness is absorbed by wrapping, not by breakpoints.** There is exactly one media query in the stylesheet and it is motion, not width: `@media (prefers-reduced-motion: reduce)`. There are no `@container` or `@supports` rules. The five containers that wrap are the header (`.kb-head`), every control row (`.kb-bar`, which covers the toolbar, the drawer's groups and the comment row), the card's chip row (`.kb-card-meta`) and the drawer header (`.kb-drawer-head`). Two rows set the opposite: the card's top row is `flex-wrap: nowrap` with `white-space: nowrap` on its children, because four items in a 236px lane must never split a `T-005` mid-token, and the metrics strip is a wrapping row whose own items never break. The notice and the `More…` fold are fixed columns; everything else is fixed or scrolls.

**The drawer** is the last child, inline below the board: `max-height: 260px` with its own `overflow: auto`. The cap is in pixels, not a share of the page — the previous `max-height: 46%` let a single-card board take the lanes' half of the panel to open one card. The lanes keep their own 140px floor above it. Its children are stacked at a 9px gap, and its inner 12px lists sit at a 3px gap.

**Spacing rhythm.** Spacing is literal pixels, not variables. It clusters: **3px** for list and checklist gaps and the control-group gap; **5–6px** inside a card (5px between rows, 6px in the meta row); **7px** as the working rhythm (card gaps, lane gaps, card padding, card top-row gap, the `More…` fold's and the danger group's top padding, and — as a radius — buttons, inputs, notices); **8px** for the toolbar gap and the input/check gaps; **9px** for lane padding, drawer row gaps and the drawer's group gap; **10px** for page section gaps, panel radii, the notice gap and the drawer-header gap; **11–14px** for notice padding, drawer padding and the metrics gap; **14/16/18px** for page padding.

## Elevation & Depth

**This system has no shadows.** `box-shadow` appears zero times in the stylesheet, and so do gradients and keyframes. Depth is tonal and linear: a 1px hairline on every surface, a radius that steps with the surface's importance (7px control → 8px card → 10px lane and drawer), and the app's tint tiers — the lane carries `bg-layer-1`, the card carries `bg-base`, a hovered or pressed control carries `bg-layer-2`. The panel paints no page background at all, so the app's own sidebar fill is the ground.

Two outline treatments stand in for elevation-as-feedback, and both are reserved: a lane that a card is over gets a 2px **dashed** `label-secondary` outline inset 3px on a `bg-layer-2` fill (unmistakably a drop affordance, not a raised surface), and focus gets a 2px **solid** brand outline — 2px offset on buttons, inputs, checklist rows and the drawer, 1px on a card, which sits inside the horizontally scrolled lane.

**Motion is one authored moment, not a scattering of effects.** Buttons transition `background-color`, `border-color` and `transform` over 140ms `ease-out`; inputs transition `background-color` and `border-color`; a button press nudges `translateY(1px)`. There is no entrance animation, no keyframe and no looping effect, and `@media (prefers-reduced-motion: reduce)` sets `transition: none` on both and cancels the press nudge. PRODUCT.md's reduced-motion commitment is honoured by construction: no transition is load-bearing.

A disclosure's reveal is therefore instantaneous, not animated: opening `More metrics`, `Host`, `More…` or `Exception…` shows the revealed half in the same frame, separated from the row it opens from by a `border-l1` top hairline and 7px of padding rather than by motion.

The browser surfaces are **authored**, not inherited: `::selection` takes the app's `--dsw-alias-bg-document-selection`, the caret takes `--dsw-alias-label-primary`, and the board's sideways scroll and the drawer's body scrollbar take the app's `--dsw-alias-scrollbar-bg-l1` / `-bg-l2` / `-hover-l1` ladder, written for both the standard `scrollbar-color`/`scrollbar-width` pair and the `::-webkit-scrollbar-*` set. Each keeps a literal fallback like every other value here. The craft floor calls this the cheapest signal that a page was built rather than assembled, and it was the one surface where the panel had been taking the host's defaults.

### Named Rules
**The No-Shadow Rule.** Surfaces are flat at rest and flat under the pointer. Depth comes from a hairline, a radius and a tint step, never from `box-shadow`; a raised look is bought with `bg-layer-2`, not blur.

**The Response-Not-Entrance Rule.** Motion exists only as a 140ms ease-out answer to state, and every transition is switched off wholesale under `prefers-reduced-motion`. No element animates into existence — including a disclosure's revealed half.

## Shapes

The form language is **rectilinear and lightly rounded** — one radius scale applied by surface role, and nothing else. Controls (buttons, inputs, disclosure toggles, notices) take 7px; cards take 8px; lanes, the rail and the drawer take 10px; chips are fully pill-shaped at 999px. The sidebar icon rounds its three bars with `rx: 1.2` in a 20-unit viewBox, and the two drawn check glyphs use `rx: 2.5` in a 16-unit viewBox — the same family at icon scale.

Every shape is closed by a 1px hairline in `border-l1`. There is no border-radius mixing, no clipping (`overflow` is only ever `auto`, for the lane row and the drawer body), no irregular silhouette and no geometric mask. A disclosure's revealed half is not a box of its own: `.kb-fold` shares the drawer's surface and is set off from the row above it by a full-width 1px hairline — the same device that separates the destructive group from the reversible moves.

**The state edge is 1px, all the way round.** A card that needs to shout is marked by recolouring its whole 1px border — red for `expedite`, amber for blocked — never by a thick one-sided stripe. The state itself is already named in the card's own content (the `expedite` chip, the `blocked` chip, the priority code), so the border is a redundant edge, not the message. Notices follow the same rule: a refusal or error notice recolours its 1px border red, an informational one recolours it to the brand token.

The card's own geometry is a three-row stack: an identity row (an optional drawn completion mark, then id, priority code, age) on a shared baseline that must never wrap, a title row that takes the remaining width, and a wrapping meta row of chips. Nothing is clipped; a long title wraps rather than truncating.

## Components

The vocabulary is one stylesheet of `kb-`-prefixed classes and plain `React.createElement` calls. Every `kb-` class used by `components.ts` is authored by a rule in `styles.ts`, including every member of the three template-generated families (`kb-age-{fresh|ageing|stale}`, `kb-pri-{p0..p4}`, `kb-notice-{refusal|info|error}`) — the members that carry no colour state the resting tier instead of inheriting it. `kb-card-done`, which an earlier revision pushed onto a done card without a rule, is gone from both halves; so is the bare `kb-age` hook, which the walk below found emitted and unstyled. **A test walks every class the components file emits** — the string tokens and template prefixes in its source, expanded over the three families — **against the sheet**, so a hook that styles nothing cannot come back: `P4.11` fails on a re-added `kb-lane-loading` or `kb-age`.

### Buttons
- **Shape:** 7px radius, 1px `border-l1` border, transparent background, `padding: 3px 9px`, `min-height: 24px`, `font: inherit`, `line-height: 1.4`, `cursor: pointer`. The height floor is what makes the smallest control on the panel (the 12px disclosure toggle) a comfortable target without changing its visual weight.
- **Primary:** there is no button hierarchy. One `.kb-btn` serves header actions, view controls, drawer moves, Block/Unblock, Drop, Comment, Dismiss, Close, the exception and set-position actions, and the checklist rows — the same quiet outline in every case, distinguished only by its label.
- **Hover:** `background: bg-layer-2` and nothing else — no border, colour, shadow or transform change. **Active:** `translateY(1px)`.
- **Pressed (`[aria-pressed="true"]`):** the fill becomes `bg-layer-2`, the border steps up to `border-l2`, and the weight goes to `font-weight: 600`. It is deliberately never a colour on its own: `brand-primary` resolves to near-white in dark, so a brand *background* painted body-white while the unselected button read stronger — the tint-plus-weight cue survives both themes and a greyscale screenshot. Its remaining consumers are the active saved view, `All` while nothing is filtered, and a ticked checklist row.
- **Disabled:** `opacity: 0.5; cursor: default`, with hover, the press nudge **and any pressed fill** cancelled, so a control that is both chosen and disabled (a ticked checklist row a mutation has taken out of action) reads as inert rather than as chosen. Used by `Add` with an empty title, `Drop`/`Block` with an empty reason, `Comment` with an empty body, `Move with exception` without a reason, `Set position` before the number changes, and every checklist row while the store's `busy` is set — a tick that cannot land is not offered. The button that would create nothing is present but inert.
- **Focus:** `:focus-visible` draws a 2px solid brand outline at 2px offset, authored for buttons, inputs, checklist rows and the drawer in one selector list; a card gets the same ring at 1px offset.

### Disclosure / Toggle
- **Shape:** the button vocabulary plus `.kb-more` — `display: inline-flex`, `padding: 1px 7px`, 12px type, inside the shared 24px height floor. It is the smallest control on the panel by *type* — it names what it reveals and competes with nothing — but no longer the hardest to hit.
- **State:** `aria-expanded` is the whole state, and the toggle is a real `<button type="button">` with a stable label — a control that renames itself is two controls to a reader. An open disclosure takes the same treatment as a pressed button (tint, `border-l2`, weight 600) and is told apart from one by its caret: a drawn 9px chevron pointing right when closed, rotated a quarter-turn when open, `aria-hidden` so the accessible name stays exactly the label.
- **Reveal:** the revealed half is a sibling rendered inline in the row it belongs to, never a block the browser styles: a `<span>` beside the metrics, the `host …` span beside `Host`, a `.kb-fold` under `More…`. Not `<details>`, deliberately — the opened half must render as part of its row.
- **The two weights:** only `aria-expanded` gets the weight bump. `Exception…` and `More…` additionally carry `aria-expanded` while sitting in `.kb-bar`; a nested disclosure (`Exception…` inside `More…`'s fold) is allowed, and the fold is separated by a `border-l1` hairline rather than by indentation.
- **Consumers:** `More metrics` (the metrics strip), `Host` (the header), `More…` (the drawer's move group), `Exception…` (inside the fold). `Exception…` and `More metrics` also carry a `data-action` for the DOM suite; the label stays fixed in every case.

### Chips
- **Style:** pill (999px), 1px `border-l1` border, transparent background, `padding: 1px 8px`, 12px.
- **State:** a chip is never selectable, never a filter, and carries no pressed or active variant — but it is not always neutral. Three variants exist: `.kb-chip-kb` adds `bg-layer-2` and marks the active sprint; `.kb-chip-warn` colours the `over limit` chip in `state-error` at 600 weight, so the lane's warning is a colour **and** a word rather than a coloured count beside an ordinary chip; every other chip is informational. On a card they show only the four facts that demand a decision: `blocked`, the P0/P1 word, an age band that has left `fresh`, and `expedite`. Class, assignee, project and sprint are facts about the card rather than about what to do next, and they live in the drawer. In the drawer header the chips state, priority, class and age.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** `bg-base` on the lane's `bg-layer-1`. In light both resolve to `#fff`, so the card reads through its hairline and radius; in dark the card is a step lighter than the lane.
- **Shadow Strategy:** none — see Elevation & Depth.
- **Border:** 1px `border-l1`, recoloured whole to red for `expedite` and amber for blocked. A card can carry both classes; the blocked rule is declared second, so on a card that is both, amber wins.
- **Priority code:** `P0`–`P4` in 600-weight monospace, built by slicing the priority label. **Only `P0` and `P1` carry a colour**, and `P1`'s is dark-only: `P0` is red in both themes, `P1` is the foreground in light and amber under `body[data-ds-dark-theme]`. `P2`–`P4` are explicitly `label-primary` rather than left to inheritance, so every member of the family is authored. The word in the chip row (`high`) is not decoration — it is how the priority survives the light theme.
- **Age:** `3d` / `0.5d` / `—`, banded against the SLE. `stale` (past `1.5 ×` SLE) is red **and** bold in both themes; `ageing` (past the SLE) is the foreground in light and amber in dark; `fresh` is explicitly `label-secondary`, so the three bands are authored rather than two authored and one inherited. The band is only printed as a chip once it has left `fresh`.
- **Completion mark:** a `done` card carries a drawn 14px tick in `state-success` at the head of its top row, with one stroke width and `currentColor`. It is a mark, not an edge — a done card and a review card are otherwise the same shape and hairline.
- **Internal Padding:** `7px 9px`, with a 5px gap between the three rows, 7px in the top row and 6px in the meta row. A card with nothing to flag is exactly three rows: no empty chip row is rendered.
- **States:** hover promotes the **border** to the brand token; `:focus-visible` draws a 2px brand outline at offset 1px; `cursor: grab` at rest. No dragging cursor is declared. A card is `draggable`, `tabIndex: 0`, `role="button"`, labelled `"{id} {title}, {state}, {priority}"`, carries `aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"` and `data-card="{id}"`. A card in `dropped` state — only ever on screen in the `Dropped` view — adds `.kb-card-dropped` and takes the dim tier: nothing is wrong with it and nothing is waiting on it, so it is not a state colour.
- **Order inside a column** is expedite, then hand-set position, then priority rank, then id — position is the truth and priority is a badge.

### Metrics Strip
- **Shape:** a `flex-wrap: wrap` row of monospace 12px spans with a 14px gap, `font-variant-numeric: tabular-nums`, labelled `aria-label="Flow metrics"`.
- **The two leads:** `WIP n/limit` (the sum of the In Progress and Review limits) and `Oldest Xd vs Yd SLE · N past`, each a `.kb-metric-lead` span (600 weight) wrapping a `<b>` label. They answer *is anything stuck?* without a click, and they are the strip's only permanent content.
- **The disclosure:** `More metrics` opens three `.kb-dim` facts — `Cycle median Nd · p85 Nd · mean Nd`, `Throughput N/7d · N/30d`, and `SLE P% ≤ Nd (source)`. The three cycle readings are one fact told three ways and share one span, so the reveal stays three items rather than nine; a metric the store cannot compute prints `—`. The full metrics, including each band's own basis, stay in `kanban_metrics`.
- **Emptiness:** the strip renders nothing until the first payload arrives, and `—` stands in for a metric the store cannot compute. The pending state does not live here: it lives on the board row (see below).

### Inputs / Fields
- **Style:** 1px `border-l1` border, transparent background, `color: inherit`, 7px radius, `padding: 3px 8px`, `font: inherit`, `min-width: 140px`. Types in use: `search` for the card filter, `text` for new-card title, comment and the three reason fields, `number` for position (narrowed to `min-width: 76px`), and `<select>` for priority, class of service and the exception target (narrowed to `min-width: 0` with a tighter right padding of 4px, because a value picker is not a search field).
- **Hover:** the border steps up to `border-l2`. **Focus:** the shared 2px brand outline at 2px offset.
- **Error / Disabled:** no error state and no disabled state is styled; validation is expressed by leaving the paired button disabled until the field has content. Placeholders are lowercase and trailing-ellipsised: `search cards…`, `new card…`, `comment…`, `reason to drop…`, `reason to block…`, `reason to except…`.

### Notices
- **Shape:** 1px `border-l1`, 7px radius, `padding: 7px 11px`, a baseline-aligned `flex-wrap: wrap` row.
- **Kinds:** `refusal` and `error` recolour the border to `state-error`; `info` recolours it to `brand-primary`. The message is the product's own words; the refusal's machine vocabulary is a monospace `missing: …` span in `label-secondary`; a Dismiss button borrows the button rules.
- **Live:** the strip is `role="status" aria-live="polite"`, and it is one of only two live regions — the other is the single hidden announcement span the board writes every state change into.

### Signature Component: the Two-Number Metrics Strip

The strip is the distill pass's clearest statement: **the two numbers that answer the urgent question are permanent, and the history that answers a slower one costs one click.** WIP against its limit and the oldest card against the SLE fit on one 12px line; cycle, throughput and the SLE's own basis do not deserve that line's width until someone asks. The order inside the row is fixed — two leads, then the disclosure, then the revealed facts — so the strip has one scan order instead of nine equal items, and the disclosure keeps its position whether it is open or closed.

### Signature Component: the Card's Dual Path

A card is not a list row. It is a `role="button"` that carries three independent interactions on one surface: pointer drag with a drop index computed from the pointer's Y against each card's midpoint, `Alt+←/→` to move it one lane along the board order (announcing "T-006 moved to review", "T-006 is already at the edge of the board" at either end, or — for a `dropped` card, which is not on the board at all — that it is dropped and its drawer is the way back), and `Enter` or a click to open the drawer. All three land in the same store call, so the keyboard path passes the same gates as the drag — a refusal reads the same either way. Cards are sorted with `expedite` first so the one exception to WIP control is visible without opening anything.

### Signature Component: the Checklist Row

The Definition of Ready and Definition of Done rows are `kb-check kb-btn` — a button that borrows the whole button vocabulary (radius, hairline, hover, press nudge, focus ring, disabled) and adds a drawn glyph at 14px, `viewBox="0 0 16 16"`, one 1.5 stroke in `currentColor`, `aria-hidden`, with the tick path rendered only when the item is checked. `aria-pressed` is the only source of truth for the state, and the unticked case appends the words `· unticked`, because the amber that colours it in dark cannot carry small text on white. Every row is disabled while the store's `busy` is set — a tick that cannot land is not offered — so a ticked row is briefly both chosen and disabled, which is the one case the sheet's `[aria-pressed="true"]:disabled` rule exists for.

### Signature Component: the Drawer

The drawer is the last child of the page, inline and scrollable, never a modal and never an overlay: it takes focus when it opens (`tabIndex: -1`), and it records *why* it was opened — `data-open="keyboard"` when `Enter` on a card moved the keyboard there, `data-open="pointer"` otherwise — so the programmatic focus paints its ring on the keyboard path without giving the pointer path a ring it did not earn, then hands focus back to the card it came from when it closes, `Escape` is a convenience beside the Close button rather than the only way out, and `Tab` leaves it like any other box. Its header is one wrapping row of chips (id, title, state, priority, class, age) and the keyboard hint `Alt+←/→ moves · Esc closes`. Its body leads with **one primary move** — the next state in the board's own order — beside a `More…` disclosure; behind that fold sit every other target, the numeric position with its `Set position` button, `Exception…` and its target/reason pair, and the `block` and `drop` groups with their reason fields, the destructive group set off by a full-width hairline and 7px of padding. The two checklists and the comment stay visible: they are the gate and the conversation. `Unblock` is the exception — it sits on the blocked notice that names the blocker, because a blocked card is the one case where the obvious move is not a move.

### Signature Component: the Sidebar Icon

An inline SVG, `viewBox="0 0 20 20"`, `fill: none`, `stroke: currentColor`, `aria-hidden`, `strokeWidth` 1.4 at rest and 1.8 when the row is active. Three rounded bars of decreasing height (`rx: 1.2`) at x = 2.5 / 8.1 / 13.7, y = 3, heights 14 / 10 / 7 — a board seen down its lanes. It takes `{ size, active }` from the sidebar row and defaults to 20px when `size` is not a number. The entry is labelled **Kanban**.

## Do's and Don'ts

### Do:
- **Do** style every colour through a `--dsw-*` token with a literal fallback, exactly as `styles.ts` does — the app's theme is the palette, and it must work in both modes without an edit.
- **Do** use `border-l1` hairlines, the radius scale (7/8/10/999px) and the three background tiers to separate surfaces; that is the whole depth vocabulary.
- **Do** give every interactive control the shared 2px brand focus ring (2px offset; 1px on a card), and never leave a control on the browser default.
- **Do** signal a card's exception by recolouring its whole 1px border in the state colour — `--dsw-alias-state-error-primary` for expedite, `--dsw-alias-state-warn-primary` for blocked — and let the chip text name the state.
- **Do** de-emphasise with `--dsw-alias-label-secondary`, and use `--dsw-alias-label-tertiary` only as a dark-theme enhancement inside `body[data-ds-dark-theme]`.
- **Do** keep a colour that fails AA on light out of a text rule unless it is scoped to the dark marker; the panel's own test enforces exactly this.
- **Do** reveal progressive detail with the disclosure primitive: a real `<button type="button">` carrying `aria-expanded`, a stable label, and the revealed half rendered inline in the row it belongs to.
- **Do** keep the two metrics numbers permanent and put the rest of the history behind `More metrics`; a one-click cost is the right price for a second question.
- **Do** lead the drawer with one primary move, and keep the checklists and the comment visible while everything rarer hides behind `More…`.
- **Do** keep lanes at `flex: 0 0 236px` inside an `overflow-x: auto` row with a 140px floor, and collapse an empty lane to the 46px rail that opens while a drag is live.
- **Do** keep the card drawer inline, below the board, capped at `max-height: 260px` with its own scroll.
- **Do** make a pressed control a tint (`bg-layer-2`) plus `border-l2` plus weight 600 — never a colour on its own.
- **Do** keep the 140ms ease-out transitions as the only motion, and cancel them under `prefers-reduced-motion: reduce`.
- **Do** use monospace for card ids, lane counts, priority codes, flow metrics, history rows and the `rev · cards` line, and draw every icon as inline SVG in one stroke width with `currentColor`.
- **Do** keep only what demands a decision on the card — `blocked`, the P0/P1 word, a non-`fresh` age band, `expedite` — and let the drawer print the card's filing in full.
- **Do** keep a keyboard path for every pointer action, and announce state changes through the single `aria-live` region.

### Don't:
- **Don't** introduce a colour that is not one of the app's `--dsw-*` tokens. Invented `--dsw-*`/`--dsh-*` names resolve to nothing and fall back silently; the panel shipped ten of them once and was off-theme in both modes.
- **Don't** hardcode a hex, `rgba()` or `oklch()` value as a design colour — the literals in `styles.ts` are fallbacks for absent tokens.
- **Don't** add `box-shadow`, a gradient, a glass/blur treatment, or a `border-left`/`border-right` (or any one-sided border) above 1px. The 3px coloured side stripe the panel once used is banned by the craft floor and has been removed.
- **Don't** assume `--dsw-alias-brand-primary` is a hue. It resolves to the app's foreground value; a brand-coloured fill or a brand-coloured pressed state is the bug that shipped once already.
- **Don't** carry text in amber or in `--dsw-alias-label-tertiary` outside `body[data-ds-dark-theme]`.
- **Don't** use `opacity` as the de-emphasis ladder — the label tokens are the ladder, and the only opacity left is `0.5` on a disabled button.
- **Don't** paint a page background — `.kb-page`, notices, the drawer, buttons, inputs and cards stay transparent-by-token so the host panel shows through.
- **Don't** give the board a sixth lane for `dropped`, or any other lane beyond the five `BOARD_STATES`.
- **Don't** use red, amber or green for emphasis, size or decoration.
- **Don't** make the drawer, the drop-reason prompt or any board action a modal dialog — dropping needs a written reason, so it is an inline field whose button stays disabled until there is one.
- **Don't** animate a disclosure open; the revealed half appears in the same frame, separated by a hairline rather than by motion.
- **Don't** build a disclosure out of `<details>` or re-implement it with local state and a renamed label — `aria-expanded` on a real button is the contract.
- **Don't** use monospace for prose, titles or button labels.
- **Don't** let a state be carried by colour alone: the card prints the word, the lane prints `M/N`, the unticked row prints `· unticked`.

## Open Questions & Unresolved Gaps

Recorded deliberately, in place of values. `/impeccable document` was re-run non-interactively, so Step 3's qualitative round still cannot reach Dhira; nothing below has been guessed to fill the space. The previous run recorded twenty-two gaps. **Thirteen of them are resolved by the polish pass** and are kept in place, marked `(resolved in this pass)` with the reason, so the record shows what changed and nothing is renumbered. The other nine — the unratified North Star and qualitative readings (1), the token resolutions' provenance (2), `--dsw-alias-label-tertiary`'s guarantee (3), the unused sidebar fill (4), the two unused tokens (5), the sidebar icon's real rendered size (16), the dark-theme ratios measured against the wrong surface (21), and the inherited light/dark scene (22) — are still true of this code and stand as written. Item 12 is counted among the resolved thirteen but carries a caveat: the states exist, and one defect it describes is recorded under *Known defects* rather than claimed fixed.

1. **The Creative North Star is proposed, not chosen.** This run puts forward *"A departures board for work: the state of play legible in one glance, and every card's next legal move one interaction away."* and marks it as awaiting Dhira's confirmation. The procedure's other qualitative questions are likewise unratified: descriptive colour names beyond the token roles (this file uses role names — "Interactive accent", "Refusal red" — rather than authored names like "Deep Muted Teal-Navy"), mood adjectives, an aesthetic anti-reference, and the component philosophy in one phrase. Elevation ("flat, hairline-and-tint") and component philosophy ("one quiet outline button, no hierarchy") were read from the code, and the human has not ratified those readings either.
2. **The resolved token values come from the installed app, not the running one.** They were re-read on 2026-10-16 from the design-platform stylesheet inside `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` (`body` = light, `body[data-ds-dark-theme]` = dark), by chunked scan. Every one of the sixteen tokens this panel references resolved in both scopes, so **no documented value is a fallback literal**. If the app is updated, the resolutions move; the token *references* in the frontmatter do not. Separately, the asar declares `--dsw-alias-brand-primary` a second time as `var(--dsw-alias-label-primary)`, in a stylesheet whose cascade position relative to the design-platform block was not verified — both spellings resolve to the same value, so the conclusion is safe, but the exact winning declaration is unrecorded.
3. **`--dsw-alias-label-tertiary` is real but is not one of the app's overridable tokens.** It was confirmed from the app's own compiled stylesheet (`#81858c` light / `#adb2b8` dark), not from the live theme query that produced the other fourteen names, because that query was unavailable when the contrast pass needed it. Whether the app guarantees it, or the panel is leaning on an implementation detail, is unresolved.
4. **`--dsw-specific-sidebar-fill` is provided and never used.** The app defines it (`#f9fafb` light / `#1b1b1c` dark) — but no rule in `src/client/styles.ts` references it. PRODUCT.md binds "the app's own theme tokens" generically rather than naming it, so nothing promises it either way. Whether some element (the page, the lane row, the drawer) is meant to carry the sidebar fill is unresolved.
5. **Two provided tokens are unused: `--dsw-alias-bg-overlay` and `--dsw-alias-state-idle-primary`.** Both are real (`#e9ecf2`/`#61666b` and `#d4d4d4`/`#545557`). The absence of `state-idle-primary` is why the pending treatment this pass added is built from `bg-layer` dimming and a skeleton line rather than from the app's own idle colour; whether the app means that token for exactly this is unresolved.
6. **The `border-l1` fallback literal was inconsistent across rules — (resolved in this pass).** It was `rgba(128,128,128,0.28)` on lanes, `0.3` on chips, `0.32` on cards and `0.35` elsewhere; `bg-layer-2` was `0.1` on the sprint chip and `0.12` elsewhere; `label-secondary` was `0.9` in some rules and `inherit` in others. The drift was not deliberate in any way a reader could name — the lane, the *largest* surface in the panel, held the *faintest* border. Each role now has one alpha, declared once in `:root` as `--kb-border-l1` (`0.35`), `--kb-bg-layer-2` (`0.12`) and `--kb-label-secondary` (`0.9`), and **every rule that needs the literal takes the property**: the card id, the input, its placeholder and the dark `label-tertiary` chain no longer restate it. The one remaining second value is `border-l2`'s own `0.5`, which is a stronger *role*, not a drift of this one. A test walks the sheet and fails on any direct `border-l1`/`bg-layer-2`/`label-secondary` fallback literal at all, while requiring the property form to be the one in use.
7. **`kb-card-done` has no rule — (resolved in this pass: it does not exist).** The class is not applied by `components.ts` and no rule for it remains in `styles.ts`; both were already true when this pass began, so the uncertainty is what went, not any code. The test that walks every class the components file emits now also fails on a hook — class or family member — that is emitted and styled by nothing.
8. **Three dynamically-generated class families style only some of their members — (resolved in this pass).** The restraint was coherent but unenforced, and the unstyled members (`kb-age-fresh`, `kb-pri-p2..p4`) inherited whoever their parent happened to be. Every member is now authored: `fresh` and `P2–P4` are stated as the resting tiers (label-secondary for a fresh age, label-primary for a low priority), and the coloured exceptions are unchanged. A test asserts each family against the sheet *and* against a rendered card.
9. **The drawer's own focus ring may never paint — (resolved in this pass).** The drawer is focused programmatically (`node?.focus()` on a `tabIndex: -1` element), and whether a browser treats that as keyboard-visible focus is not something the panel can rely on. The keyboard path now says so itself: `Enter` on a card marks the drawer `data-open="keyboard"` and it takes the ring from `.kb-drawer[data-open="keyboard"]:focus`; a pointer-opened drawer is `data-open="pointer"` and stays quiet, because a click is not a claim about the keyboard's place. The attribute is read once at mount, so it cannot go stale between renders.
10. **Motion is one micro-transition and nothing else — (resolved in this pass: it is deliberate).** The 140ms ease-out state transition *is* the authored moment, and the sheet now says so at the rule that declares it instead of leaving the question open. Nothing was added to make polish visible: no keyframe, no entrance, no loop. The disclosure's reveal stays instantaneous — the caret rotates, the revealed half does not animate in — and the whole block is cancelled under `prefers-reduced-motion: reduce`.
11. **Browser surfaces are unauthored — (resolved in this pass).** Text selection, the caret and both scrollbars now come from the app's own tokens, each with a literal fallback: `--dsw-alias-bg-document-selection` on `.kb-page ::selection`, `--dsw-alias-label-primary` as `caret-color`, and the `--dsw-alias-scrollbar-bg-l1/bg-l2/hover-l1` ladder on `.kb-lanes` and `.kb-drawer` — both halves, the standard `scrollbar-color`/`scrollbar-width` pair and the `::-webkit-scrollbar-*` set. Those four names were re-read from the installed app's compiled stylesheet (see open question 2) because the live token query was unavailable, and they are recorded in the test that guards the token list.
12. **Loading and error are strings, not states — (resolved in this pass, with one defect left open).** The board row now carries the pending state: `aria-busy` plus a dim, and while the first payload is in flight the lanes are drawn with one `.kb-skeleton` line each instead of a verdict — an empty lane says `nothing here` only when that is the answer. The board-level error is a live `role="status"` notice with a `Retry` button on it, in addition to the header's `Refresh`, so the recovery sits where the failure is. **Not resolved:** `busy` is cleared by any refresh that lands, including an unrelated poll, so a poll arriving mid-write can switch the pending treatment off early — and the same branch replaces the optimistic `payload`, which is the fuller defect recorded under *Known defects* below. This pass tried to guard that in `store.ts` and could not make it hold, so the guard was reverted rather than shipped half-working.
13. **`dropped` cards are unreachable from the panel — (resolved in this pass).** A `Dropped` view beside `All` renders the dropped lane while it is active, the card's drawer leads with `→ Backlog`, and `All` still returns to the board. The default board is unchanged at five lanes: `filterStates` swaps the lanes only for a filter that names `dropped` **alone**. This was the only new affordance the pass added, and it replaced no existing control.
14. **Over-limit is signalled twice, and only one of the two is coloured — (resolved in this pass).** Both halves are kept, deliberately: the count (red **and** weight 600) is the scan signal, and the `over limit` chip is the word that survives a greyscale read and a screen reader. What changed is the chip: it now carries the state colour and the weight too (`.kb-chip-warn`), so the pair reads as one warning instead of a coloured number beside an ordinary chip. Neither half is colour alone.
15. **The pixel caps are one-offs, not tokens — (resolved in this pass: they stay one-offs).** The drawer's `260px`, the lane row's `140px` floor, the lane's `110px` floor, the card list's `36px` floor, the rail's `46px`, the notice's `10px` padding and the inputs' `140px`/`76px` minimums each govern exactly one surface and are used once. Promoting a single-use value to a `--kb-*` property is an abstraction, not a scale, so the variable set keeps only what is genuinely reused: the lane width, the prose measure, the three radii, and now the three role fallback literals from question 6. The comment at `.kb-drawer` records the decision.
17. **A disclosure's open state is signalled more weakly than a pressed button's — (resolved in this pass).** Pressed and open are the same *kind* of thing, so they now take one treatment — the tint, `border-l2`, weight 600 — and the difference that survives without colour is a drawn caret beside the disclosure's label: pointing right when closed, rotated a quarter-turn when open, `aria-hidden` so the accessible name stays exactly the label.
18. **Toggles and disclosures share one visual vocabulary — (resolved in this pass).** They share the *treatment* on purpose (see 17) and are told apart by two things that are not colour: the caret, which only a disclosure has, and the attribute itself — `aria-pressed` on a toggle, `aria-expanded` on a disclosure. A reader who cannot see the tint still gets a different shape and a different state name.
19. **The disclosure toggle is the smallest hit target on the panel — (resolved in this pass).** Every `.kb-btn` now carries `min-height: 24px` — 3px + 13px × 1.4 + 3px + 2px of border — and `.kb-more` is an inline-flex box inside that same floor, so the smallest control by *type* is no longer the smallest by *target*. The visual weight is unchanged: the padding, the font size and the transparent ground are exactly as they were.
20. **The rail hides its own empty-state text — (resolved in this pass: kept, and bounded).** A 46px rail still renders the name vertically and the count, and `nothing here` stays hidden — a rail exists to be narrow, and that text is what makes it 236px. The information stays available to assistive technology through the lane's `aria-label`, and the rail no longer lies during a first load: a pending board draws a skeleton line in each lane and is `aria-busy` at the row, so `nothing here` is only said when it is the answer.

21. **The dark-theme resolutions are documented against the app's `bg-base`, and the card sits on a lighter surface.** `label-tertiary` is 8.54:1 against `#151517` but 7.36:1 against the lane/card tier `#232324`, and red is 5.55:1 against the base but 4.77:1 against the card. Both still pass, so no rule changes — but the recorded ratios are the surface's, not the card's, and this regeneration did not measure against the host's actual sidebar fill (which the panel never paints over and therefore cannot itself guarantee).
22. **The scene for light-versus-dark is not recorded.** The craft floor asks the theme to be picked from the use scene rather than by category. This panel does not choose at all: it follows the app's active theme. PRODUCT.md states that as a commitment, so the light/dark question belongs to the app and not to this system — recorded here because a design system that inherits its theme should say so rather than appear undecided.

## Known Defects

- **A poll that lands mid-write can clear `busy` and replace the optimistic payload.** `store.refresh` sets `busy: false` and `payload: answer.payload` whenever it applies an answer, and the poll runs on a timer, so a refresh unrelated to an in-flight write can (a) switch the `kb-lanes-busy` treatment off early and (b) overwrite the optimistic card with the board as of that read. The write still completes and the refresh that follows it renders the truth, so the second effect is a **risk, not a proven bug**: it takes a concurrent *external* change to the same card for the snap-back to be visible, and no test has produced it — the pending-treatment half, which needs no second writer, is the half that bites in practice. A guard was attempted in this pass (a write sequence number so a refresh only ends its own write) and did not hold under test, so it was reverted rather than shipped half-working; the attempt left **no trace in git**, so the shape of the failure is recorded here rather than in a diff. Fixing it means giving `refresh` an owner — it decides both the busy flag and the payload — and pinning it with the store-level case the attempt was written against.
