---
name: Workflow Graph
description: A self-hosted visual workflow editor that reads as an instrument, with graphite surfaces and color reserved for signal.
colors:
  paper: "oklch(1 0 0)"
  graphite-ink: "oklch(0.145 0 0)"
  graphite-mid: "oklch(0.556 0 0)"
  graphite-line: "oklch(0.922 0 0)"
  graphite-wash: "oklch(0.97 0 0)"
  page: "oklch(0.96 0 0)"
  page-dark: "oklch(0.18 0 0)"
  panel: "oklch(0.985 0 0)"
  void: "oklch(0 0 0)"
  paper-dark: "oklch(0.98 0 0)"
  graphite-line-dark: "oklch(0.27 0 0)"
  graphite-wash-dark: "oklch(0.15 0 0)"
  signal-red: "oklch(0.577 0.245 27.325)"
  signal-green: "oklch(0.526 0.148 149.58)"
  signal-amber: "oklch(0.546 0.12 70.08)"
  signal-blue: "oklch(0.482 0.18 259.8)"
  selection-blue: "oklch(0.56 0.21 264)"
  signal-slate: "oklch(0.52 0.046 257.417)"
  node-lifecycle: "oklch(0.646 0.19 259.815)"
  node-split: "oklch(0.646 0.13 232.661)"
  node-wait: "oklch(0.661 0.14 66.29)"
  node-condition: "oklch(0.673 0.16 346.018)"
typography:
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.375
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.25
  mono:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.35
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.graphite-ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "8px 16px"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "8px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "8px 16px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "4px 12px"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.xl}"
    padding: "24px 0"
  workflow-node:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.md}"
    width: "192px"
    height: "112px"
---

# Design System: Workflow Graph

## 1. Overview

**Creative North Star: "The Instrument Panel"**

Workflow Graph's editor is a cockpit for automation. The chrome recedes into graphite so the workflow graph owns the screen, and every light that comes on means something: a green border is a successful run, a red border is a failure, an animated border is work in progress. The user should feel they are reading gauges, never decoration.

The system is built from shadcn/ui (new-york style) on Base UI primitives, styled with Tailwind v4 tokens declared in OKLCH. It is deliberately conventional where convention earns trust: standard buttons, standard dialogs, standard form controls, in the vocabulary a Linear or Vercel user already speaks. The strategic anti-references from PRODUCT.md hold here: this must never resemble the colorful n8n/Zapier canvas where every node shouts its brand, and it must never drift into SaaS-generic gradients and cream tints.

**Key Characteristics:**

- Achromatic field: every surface, border, and text color is a zero-chroma graphite step.
- Color is signal: chroma appears only on run status, destructive actions, and integration icons.
- Refined and restrained components: quiet at rest, precise on interaction.
- Both themes are first-class; dark mode is a true-black inversion, ink and paper swapped.

## 2. Colors: Graphite & Signal

An achromatic graphite ramp carries the entire interface; saturated hues exist only as signals.

### Primary

- **Graphite Ink** (oklch(0.145 0 0)): Primary text and the filled action color. The default button is ink on paper; in dark mode the roles invert (near-white on black).

### Neutral

- **Paper** (oklch(1 0 0)): The content surface and card background in light mode.
- **Panel** (oklch(0.985 0 0)): The sidebar layer, half a step off Paper so panels read as a separate plane without a border doing all the work.
- **Graphite Wash** (oklch(0.97 0 0)): Secondary and muted fills: hover states, secondary buttons, muted badges.
- **Page** (oklch(0.96 0 0), oklch(0.18 0 0) in dark): The surface the editor shell is inset on, and the only thing that uses it. `--page`. Solved for the step against the two surfaces the shell shows at its edge, Paper and Panel, which measures 1.12:1 and 1.08:1. It is its own step on the ramp rather than a reuse of Graphite Wash, because a page and a fill inside a panel are different things and one value cannot be retuned for both; at three levels of 255 apart nobody would tell them apart where they met, so the separation is in what each token means. In dark mode the step goes up rather than down, as Graphite Wash Dark and the card step do, because nothing renders darker than Void: it sits between those two, above the wash so a fill inside the shell never matches the page and below the card so the page never reads as a surface something could sit on. The shell is what stays Void there, since the canvas is Void by design and lifting the shell would repaint the field the graph floats on.
- **Graphite Line** (oklch(0.922 0 0)): Hairline borders and input strokes (oklch(0.27 0 0) in dark mode).
- **Graphite Mid** (oklch(0.556 0 0)): Muted foreground for descriptions and placeholders. This is the darkest gray allowed to carry text on Paper (4.5:1 floor); anything lighter is decorative only.
- **Canvas Line** (oklch(0.6 0 0), oklch(0.48 0 0) in dark): The structural stroke on the React Flow canvas, carrying a node's resting border and the wire between two nodes. `--canvas-line`. It is a separate step from Graphite Line because a node card is Paper on a Paper canvas, so this stroke is the whole card edge rather than a hairline over a fill; it is solved for the 3:1 WCAG 1.4.11 asks of a graphic carrying meaning, which Graphite Line misses at 1.20:1. Canvas only. A border inside a panel or a card is still Graphite Line.
- **Canvas Line Muted** (oklch(0.78 0 0), oklch(0.37 0 0) in dark): One step down at 2.0:1, for an edge into a subtree the run cannot reach. `--canvas-line-muted`. It is a value per theme rather than Canvas Line mixed toward the background, because mixing toward Paper lightens while mixing toward Void darkens, so a single expression reads correctly in one theme and disappears in the other. This is the one canvas stroke below the 3:1 floor, and it is deliberate: an unreachable edge has to read as quieter than a live one, and the meaning is carried by the wider dash gap and the stopped march rather than by contrast alone. Treat 2.0:1 as the floor for a deliberately quiet stroke, not as a target to design toward.
- **Void** (oklch(0 0 0)): Dark mode's background. True black, tuned for the OLED-dark canvas where the graph floats.

### Tertiary (signals)

Each signal is one token carrying both the fill and the text form, and each light-mode value is solved so its text form clears 4.5:1 on its own 10% tint, which is the `bg-x/10 text-x` pattern the run panel uses throughout.

- **Signal Red** (oklch(0.577 0.245 27.325)): Destructive actions and failed runs. `--destructive`.
- **Signal Green** (oklch(0.526 0.148 149.58)): Successful runs. `--success`.
- **Signal Amber** (oklch(0.546 0.12 70.08)): Waiting runs, test mode, and unmet prerequisites. `--warning`.
- **Signal Blue** (oklch(0.482 0.18 259.8)): Work in progress, including the running-node border sweep, and live template variables. `--info`.
- **Selection Blue** (oklch(0.56 0.21 264), oklch(0.72 0.17 264) in dark): The persistent outer halo on the selected canvas object. `--selection`. It stays separate from Signal Blue so selection never reads as execution state, and it leaves the node surface unchanged.
- **Signal Slate** (oklch(0.52 0.046 257.417)): Cancelled and superseded runs. `--cancelled`.

### Node-type accents

Four hues name what a built-in node does: `--node-lifecycle`, `--node-split`, `--node-wait`, `--node-condition`. These are a deliberate exception to the Signal Rule, kept because node type is the fastest thing to read on a dense canvas. Each is a single value clearing 3:1 against both card surfaces, so it serves light and dark without a variant, which is what WCAG 1.4.11 asks of a graphic carrying meaning.

The exception is bounded. It applies to the glyph of a built-in node and to nothing else: never a node fill, never a border, never a panel. A plugin's identity still lives in its own icon.

### Named Rules

**The Signal Rule.** Chroma is earned by state. If an element is not communicating run status, a destructive consequence, selection, or an integration's identity, it is grayscale. There is no decorative color anywhere in the editor.

**The One Ramp Rule.** All neutrals come from the zero-chroma graphite ramp. The single exception is Signal Slate, which carries cancelled and superseded runs: the tint is what separates "this run stopped" from "this text is quiet", and it is spent on status rather than on the field. Everywhere else a warm or cool tinted gray breaks the achromatic field.

## 3. Typography

**UI Font:** Geist (with ui-sans-serif, system-ui fallback)
**Mono Font:** Geist Mono (with ui-monospace fallback), for template variables, code editors, and log output

**Character:** A single well-tuned grotesque carries the whole interface, which is correct for a product register: headings, labels, buttons, and data all speak in one voice, differentiated by weight and the muted-foreground color rather than by family or dramatic size jumps.

Both families are self-hosted through Fontsource variable packages, imported in `main.tsx`; `--font-geist-sans` and `--font-geist-mono` are defined in `globals.css` and point at "Geist Variable" and "Geist Mono Variable".

### Hierarchy

- **Title** (600, 1rem, 1.375): Card titles, node titles, dialog headings. The largest text in the working UI.
- **Label** (500, 0.875rem, 1.25): Buttons, form labels, tabs, menu items.
- **Body** (400, 0.875rem, 1.5): Descriptions, settings prose, run detail text. `text-base` (1rem) only on mobile inputs to prevent iOS zoom.
- **Mono** (400, 0.8125rem, 1.5): Template expressions, cron strings, JSON output, execution logs.
- **Caption** (400, 0.75rem, 1.35): Canvas edge labels, node status chips, handle labels, and secondary run metadata. The floor of the scale. Nothing renders below it; the 10px and 11px values that used to sit here were arbitrary rather than a step.

### Named Rules

**The Fixed Scale Rule.** Sizes are fixed rem steps. No clamp(), no fluid type; this is a tool viewed at desktop DPI, and hierarchy comes from weight and color before size.

## 4. Elevation

Depth follows shadcn's native vocabulary and nothing more: hairline borders define structure, a whisper of shadow keeps surfaces from feeling painted on, and real shadow is reserved for things that genuinely float. In dark mode, tonal layering does most of the work (Void background, 0.205-lightness cards, 0.15 washes) because shadows read poorly on black. The card step has to survive 8-bit quantisation to do that job: anything under about oklch(0.12) rounds to the same rgb(0,0,0) as the background and separates by nothing at all.

The editor shell is inset 12px from the viewport on all four sides at `md` and above, with a `--radius-xl` corner, a hairline border and shadow-xs over the Page surface. That inset is the app's one structural elevation: it says the editor is a thing on a page rather than the window itself. In dark mode the Page step carries it alone, since shadow-xs is invisible against any of these tones. Below `md` the inset is dropped entirely, along with the border and the radius, since 24px of a phone's width is a real cost and the status strip needs the bottom edge of the screen for the home indicator.

### Shadow Vocabulary

- **shadow-xs** (`0 1px 2px 0 rgb(0 0 0 / 0.05)`): Form controls and outline buttons at rest.
- **shadow-sm** (`0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)`): Cards and workflow nodes.
- **shadow-lg** (`0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)`): Dialogs, dropdown menus, popovers: true overlays only.

### Named Rules

**The Overlay Rule.** Anything at shadow-lg must be dismissible. If it can't be dismissed, it isn't floating, and it doesn't get the shadow.

## 5. Components

All primitives are shadcn/ui new-york on Base UI, refined and restrained: quiet at rest, precise on interaction. Focus is always the 3px `ring-ring/50` halo with a border-color shift; hover is always a fill change, never movement.

### Buttons

- **Shape:** Gently rounded (8px), 36px tall at default size.
- **Primary:** Graphite Ink fill with Paper text, hover dims to 90% opacity.
- **Outline:** Paper fill, hairline border, shadow-xs; hover fills with Graphite Wash.
- **Ghost:** Transparent until hovered, then Graphite Wash.
- **Destructive:** Signal Red fill; the only chromatic button.
- **Focus:** 3px ring at 50% ring color plus a border shift, visible in both themes. `--ring` is oklch(0.6 0 0) in light so the border shift clears the 3:1 that WCAG 1.4.11 asks of a focus indicator.

### Cards / Containers

- **Corner Style:** 14px (rounded-xl), the roundest shape in the system.
- **Background:** Paper with hairline Graphite Line border.
- **Shadow Strategy:** shadow-sm per the Elevation section.
- **Internal Padding:** 24px vertical rhythm, 16px on the small variant.

### Inputs / Fields

- **Style:** Transparent background, hairline border, 8px radius, 36px height, shadow-xs.
- **Focus:** Border shifts to ring color plus the 3px halo.
- **Error:** `aria-invalid` drives a Signal Red border and red-tinted ring; error state is attribute-driven, never a bespoke class.
- **Disabled:** 50% opacity with pointer events off.

### Workflow Node (signature component)

The reason the product exists. A 192×112px rectangular card at 8px radius sitting on the React Flow canvas: integration icon, title, and description at rest. Event Split is wider at 264px on purpose, because it carries two labelled outlets. Nested Group children are compact (188×56) so the frame reads as one step; parallel lookups sit side by side inside it. 192×112 remains the top-level card. The card is flat; elevation on the canvas would compete with the status border.

At rest the border is 1.5px of Canvas Line. Status is worn on that same border, stepping up to 2px: Signal Green for success, Signal Red for failure, Signal Slate for cancelled, and an animated Signal Blue sweep while running. Every status also renders its word in a chip, so the border is never the only carrier. Focus shifts the border to Graphite Ink rather than the ring color, because the resting border already sits at the ring's lightness and the shift would otherwise read as nothing.

A Group frame is the one container on the canvas: solid Graphite Wash behind a 1.5px Canvas Line border, with a rule under its title band. That gives the eye three tones to order, Paper canvas, recessed frame, Paper member cards, and it inverts on its own in dark.

Handles are 12px dots in Graphite Ink with a hairline ring, and their hit areas are 24px on desktop and 44px on touch. Those sizes are divided by `--rf-zoom`, the live canvas scale the viewport transform applies, because a flat pixel size inside that transform shrinks with the zoom and delivered 24.6px on a phone.

Edges leave the bottom handle, travel in a rounded orthogonal step, and enter the top handle of the next node. The dash is the wire, 2px of Canvas Line marching while live and Graphite Ink when selected; a label sits on the horizontal span when the outlet has a name. An edge landing where the run cannot go widens its dash gap and stops marching, keeping a legible stroke rather than fading toward the background.

A step the run can never reach is muted: the card drops to 50% opacity, its incoming edge takes Canvas Line Muted and a wider dash gap, and that edge stops animating, so a dead region reads as still while a live one moves. Two things put a step out of reach, and both wear this: a Canceled subtree while no Cancel Event is declared, which also labels the outlet, and everything below a disabled step, since disabling one ends its branch. A disabled step wears its own face instead, 50% opacity with an eye badge, which is what separates the step a person switched off from the steps that lost their path because of it. A Group frame carries no flag; it wears the disabled face once every member has it.

### Navigation

A quiet menu bar above the canvas and a Panel-toned sidebar for workflow lists and run history. Selection state uses Graphite Wash fills; the active workflow is marked by tone, never by an accent stripe.

A Panel-toned status strip closes the canvas column: 32px tall, Caption type, a hairline top border, one line that never wraps. It states what the editor is doing rather than offering anything to press, so the only control on it is the way out of a run. With a past run pinned to the canvas it tints toward `--info` and carries that run's identity; the height is the same in both states, because the strip and the graph share the column's height between them.

The 44px editor toolbar spans the full editor shell. Workflow navigation,
**Actions**, and **Settings** form the leading group. The 320px search control
stays centered in the shell and hides at 70rem or narrower; its keyboard
shortcut remains available. Run mode and **Publish** form the trailing group.
Test mode uses Signal Amber because it changes where configured messages go.
Publication state stays in the status strip, separate from run mode.

### Publication review

The sidebar has **Properties**, **Runs**, and **Changes** tabs after the first
publication. **Changes** compares the selected published version with the exact
draft on the canvas. It lists deterministic node and connection facts and links
to paginated version history. Restore always says "Restore version N as draft"
and requires confirmation that the published version remains unchanged.

Comparison marks nodes with `A`, `M`, or `D` in addition to signal color. Added
nodes use Signal Green, modified nodes use Signal Amber, and deleted nodes use
Signal Red. Deleted edges use a distinct dotted treatment. Node position,
dimensions, and measured geometry never create a change marker.

Selecting a changed node opens **Properties**. Modified nodes show published and
current draft values side by side. Added nodes show current draft values only.
Deleted nodes show published values only. Field labels come from the extension
catalog; machine paths do not appear as labels. Deleted nodes remain movable for
comparison clarity, and **Reset comparison layout** restores historical
positions. Comparison movement never changes the draft or its save history.

## 6. Do's and Don'ts

### Do:

- **Do** keep every neutral at zero chroma; the graphite ramp is the entire field.
- **Do** route every status color through its token (`--destructive`, `--success`, `--warning`, `--info`, `--cancelled`). A Tailwind palette class like `green-500` in the editor is a defect.
- **Do** hold body and muted text at or above 4.5:1: Graphite Mid (oklch(0.556 0 0)) is the lightness floor for text on Paper.
- **Do** use the standard component vocabulary everywhere; a save button looks identical on every screen.
- **Do** keep motion in the 150–250ms band, easing out, conveying state (the running-node border sweep is the model).
- **Do** honor `prefers-reduced-motion` with a static alternative for every animation, including the node border sweep.

### Don't:

- **Don't** recreate the colorful n8n/Zapier canvas; integration identity lives in the icon, never in node fills or borders (PRODUCT.md's named anti-reference).
- **Don't** introduce SaaS-generic styling: gradient accents, cream-tinted backgrounds, identical marketing card grids (PRODUCT.md's second anti-reference).
- **Don't** use color decoratively; if it isn't status, selection, destruction, or an integration icon, it's graphite.
- **Don't** add display fonts, clamp-scaled headings, or letter-spaced uppercase eyebrows; this is an instrument, and it speaks in one typeface at fixed sizes.
- **Don't** put shadow-lg on anything that can't be dismissed.
- **Don't** animate layout properties on the canvas; transform and opacity only, or React Flow's frame rate pays for it.
