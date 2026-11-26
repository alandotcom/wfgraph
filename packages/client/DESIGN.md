---
name: Workflow Graph
description: A self-hosted visual workflow editor that reads as an instrument, with graphite surfaces and color reserved for signal.
colors:
  paper: "oklch(1 0 0)"
  graphite-ink: "oklch(0.145 0 0)"
  graphite-mid: "oklch(0.54 0 0)"
  graphite-line: "oklch(0.922 0 0)"
  graphite-wash: "oklch(0.97 0 0)"
  page: "oklch(0.96 0 0)"
  page-dark: "oklch(0.18 0 0)"
  panel: "oklch(0.985 0 0)"
  void: "oklch(0 0 0)"
  scrim: "oklch(0 0 0 / 0.4)"
  paper-dark: "oklch(0.98 0 0)"
  graphite-line-dark: "oklch(0.27 0 0)"
  graphite-wash-dark: "oklch(0.15 0 0)"
  signal-red: "oklch(0.555 0.245 27.325)"
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
    height: "28px"
    padding: "0 8px"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "0 8px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "0 8px"
  input:
    backgroundColor: "{colors.graphite-wash}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "2px 8px"
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

The system is built from shadcn/ui (base-mira style) on Base UI primitives, styled with Tailwind v4 tokens declared in OKLCH. It is deliberately conventional where convention earns trust: standard buttons, standard dialogs, standard form controls, in the vocabulary a Linear or Vercel user already speaks. The strategic anti-references from PRODUCT.md hold here: this must never resemble the colorful n8n/Zapier canvas where every node shouts its brand, and it must never drift into SaaS-generic gradients and cream tints.

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
- **Panel** (oklch(0.985 0 0)): The inspector layer, half a step off Paper so panels read as a separate plane without a border doing all the work.
- **Graphite Wash** (oklch(0.97 0 0)): Secondary and muted fills: hover states, secondary buttons, muted badges.
- **Page** (oklch(0.96 0 0), oklch(0.18 0 0) in dark): The surface the editor shell is inset on, and the only thing that uses it. `--page`. Solved for the step against the two surfaces the shell shows at its edge, Paper and Panel, which measures 1.12:1 and 1.08:1. It is its own step on the ramp rather than a reuse of Graphite Wash, because a page and a fill inside a panel are different things and one value cannot be retuned for both; at three levels of 255 apart nobody would tell them apart where they met, so the separation is in what each token means. In dark mode the step goes up rather than down, as Graphite Wash Dark and the card step do, because nothing renders darker than Void: it sits between those two, above the wash so a fill inside the shell never matches the page and below the card so the page never reads as a surface something could sit on. The shell is what stays Void there, since the canvas is Void by design and lifting the shell would repaint the field the graph floats on.
- **Graphite Line** (oklch(0.922 0 0)): Hairline borders and input strokes (oklch(0.27 0 0) in dark mode).
- **Graphite Mid** (oklch(0.54 0 0), oklch(0.65 0 0) in dark): Muted foreground for descriptions and placeholders. It is solved against Graphite Wash, the darkest ground muted text sits on: 4.61:1 there and 5.02:1 on Paper. Anything lighter is decorative only.
- **Canvas Line** (oklch(0.6 0 0), oklch(0.48 0 0) in dark): The structural stroke on the React Flow canvas, carrying a node's resting border and the wire between two nodes. `--canvas-line`. It is a separate step from Graphite Line because a node card is Paper on a Paper canvas, so this stroke is the whole card edge rather than a hairline over a fill; it is solved for the 3:1 WCAG 1.4.11 asks of a graphic carrying meaning, which Graphite Line misses at 1.20:1. Canvas only. A border inside a panel or a card is still Graphite Line.
- **Canvas Region** (oklch(0.955 0 0), oklch(0.15 0 0) in dark): The fill of a Group region and its header band. `--canvas-region`. One step below the canvas in light and above Void in dark, and below the card in both, so a region reads as a place and every card stays the lightest thing in it. Its dashed Canvas Line border carries the boundary.
- **Canvas Line Muted** (oklch(0.78 0 0), oklch(0.37 0 0) in dark): One step down at 2.0:1, for an edge into a subtree the run cannot reach, and on a run's canvas for an edge the run did not take. `--canvas-line-muted`. It is a value per theme rather than Canvas Line mixed toward the background, because mixing toward Paper lightens while mixing toward Void darkens, so a single expression reads correctly in one theme and disappears in the other. This is the one canvas stroke below the 3:1 floor, and it is deliberate: an unreachable edge has to read as quieter than a live one, and the meaning is carried by the wider dash gap rather than by contrast alone. Treat 2.0:1 as the floor for a deliberately quiet stroke, not as a target to design toward.
- **Void** (oklch(0 0 0)): Dark mode's background. True black, tuned for the OLED-dark canvas where the graph floats.

### Tertiary (signals)

Each signal is one token carrying both the fill and the text form. As text, every light-mode value clears the 4.5:1 body floor on Paper, Panel and Graphite Wash: Red 5.08, 4.86 and 4.66:1, Green 5.01, 4.80 and 4.59:1, Amber 5.05, 4.84 and 4.63:1, Slate 5.51, 5.28 and 5.06:1, Blue 6.72, 6.44 and 6.17:1. In dark, the lowest is Red at 4.75:1 on the card step. A signal's text never sits on that signal's own tint, where it measured about 4:1. A status either sets a signal dot or icon beside a word in foreground text, or sets the word itself in the signal color on a neutral ground. The Workflows table's State column, the All Runs status and a node's status chip use the first form. A run row uses the second. A tinted band, such as a failed run's error or a Waiting notice, keeps its tint, border and icon in the signal and sets its words in foreground text. A solid signal disc carries its glyph in the signal's foreground token: the change marker and the blocking issue badge measure at least 4.80:1 in light and 5.49:1 in dark.

- **Signal Red** (oklch(0.555 0.245 27.325)): Destructive actions and failed runs. `--destructive`.
- **Signal Green** (oklch(0.526 0.148 149.58)): Successful runs. `--success`.
- **Signal Amber** (oklch(0.546 0.12 70.08)): Waiting runs, a step the executor is retrying, an Unclaimed run (one no worker has picked up within its host's threshold, a minute for a worker loop at its default poll), test recipients (a Published mode of Test, and every Draft run), and unmet prerequisites. Nothing else uses it; a paused workflow is graphite. `--warning`.
- **Signal Blue** (oklch(0.482 0.18 259.8)): Work in progress, including the running-node border sweep, and live template variables. `--info`.
- **Selection Blue** (oklch(0.56 0.21 264), oklch(0.72 0.17 264) in dark): The persistent outer halo on the selected canvas object. `--selection`. The card a list points at, such as an outline row under the pointer or a review edit, wears the pointed tint instead: an 8px wash of Selection Blue at 22% outside the card's edge, with no solid stroke, so it never reads as a second selection. It stays separate from Signal Blue so selection never reads as execution state, and it leaves the node surface unchanged.
- **Signal Slate** (oklch(0.52 0.046 257.417)): Cancelled and superseded runs. `--cancelled`.

### Node-type accents

Four hues name what a built-in node does: `--node-lifecycle`, `--node-split`, `--node-wait`, `--node-condition`. These are a deliberate exception to the Signal Rule, kept because node type is the fastest thing to read on a dense canvas. Each is a single value clearing 3:1 against both card surfaces, so it serves light and dark without a variant, which is what WCAG 1.4.11 asks of a graphic carrying meaning.

The exception is bounded. It applies to the glyph of a built-in node and to nothing else: never a node fill, never a border, never a panel. A plugin's identity still lives in its own icon, and a host action, or an action whose integration draws no icon, draws a Zap glyph in Graphite Mid, so amber on a card always means a Wait.

### Named Rules

**The Signal Rule.** Chroma is earned by state. If an element is not communicating run status, a destructive consequence, selection, or an integration's identity, it is grayscale. There is no decorative color anywhere in the editor.

**The One Ramp Rule.** All neutrals come from the zero-chroma graphite ramp. The single exception is Signal Slate, which carries cancelled and superseded runs: the tint is what separates "this run stopped" from "this text is quiet", and it is spent on status rather than on the field. Everywhere else a warm or cool tinted gray breaks the achromatic field.

### Routine work and warnings

Signal Red and the confirmation dialog are the two loudest things the editor owns, and both are spent on loss. The rules below keep them there, and hold every surface to one vocabulary.

**Red marks a failure or a deletion.** Running a workflow, publishing a version, and switching Published mode are routine work. Each uses the default button and no signal color.

**A confirmation dialog that warns is for an action that destroys data.** A dialog that collects what a run or a publish needs is not a warning. A setting a person can switch back is not confirmed at all.

**One fact, one vocabulary.** Every surface that shows a fact uses the words of the control that sets it. Published mode is Live or Test. A version is Draft or v7. A run reads as the Run control names it, "v7 · Live" or "Draft · Test", in one Version column. A column or a badge never coins its own words for a fact a control already names.

**Do not explain one control in the copy of another.** If a control needs a sentence about what its neighbor does, move or regroup the controls.

**A setting is a control, not a command.** It lives where its state is shown, which for Published mode is the publication chip beside the workflow's name. Published mode never appears in the workflow's menu or the command palette.

**Rows offering the same kind of repair use the same button weight.** Filling one button ranks it above the others, and the reader picks the row that matches the problem.

**UI copy follows Google's developer documentation style guide.** Present tense, one idea per sentence, plain words.

### Copy

The rules above decide what a control is. These decide what it says.

**A label says what the control does. A detail line adds a fact the label cannot carry.** A shortcut, the current state ("Live"), or the reason the row is disabled ("Nothing published yet") earns a detail line. A paraphrase of the label ("Add step: pick what the new step does") is removed.

**A help popover is at most three paragraphs of one sentence each.** A popover that needs more is a control that needs a visible label.

**No UI sentence runs past 20 words.** Split it, or cut it.

**The product is not a character.** An Event has fields; it does not "declare" them. A run has an Event; it does not "stand in for" one. A path is a default; it is not "read instead". Say what the thing is or does.

**Facts are nouns, actions are imperatives.** A column, badge, or status is the noun the control uses. A button or menu item is the action it performs, in the same words the toolbar uses.

**Every string follows Google's developer documentation style guide,** and a review of a change reads its UI copy against that guide before the change lands.

## 3. Typography

**UI Font:** Geist (with ui-sans-serif, system-ui fallback)
**Mono Font:** Geist Mono (with ui-monospace fallback), for template variables, code editors, and log output

**Character:** A single well-tuned grotesque carries the whole interface, which is correct for a product register: headings, labels, buttons, and data all speak in one voice, differentiated by weight and the muted-foreground color rather than by family or dramatic size jumps.

Both families are self-hosted through Fontsource variable packages, imported in `main.tsx`; `--font-geist-sans` and `--font-geist-mono` are defined in `globals.css` and point at "Geist Variable" and "Geist Mono Variable".

### Hierarchy

- **Title** (600, 1rem, 1.375): Card titles and dialog headings. The largest text in the working UI.
- **Label** (500, 0.875rem, 1.25): Buttons, form labels, tabs, menu items.
- **Body** (400, 0.875rem, 1.5): Descriptions, settings prose, run detail text. `text-base` (1rem) only on mobile inputs to prevent iOS zoom.
- **Mono** (400, 0.8125rem, 1.5): Template expressions, cron strings, JSON output, execution logs.
- **Caption** (400, 0.75rem, 1.35): Canvas edge labels, node status chips, handle labels, and secondary run metadata. The floor of the scale. Nothing renders below it, and every shortcut hint is the `Kbd` keycap at this size, with a hairline border on Graphite Wash; the 10px and 11px values that used to sit here were arbitrary rather than a step.

### Named Rules

**The Fixed Scale Rule.** Sizes are fixed rem steps. No clamp(), no fluid type; this is a tool viewed at desktop DPI, and hierarchy comes from weight and color before size.

## 4. Elevation

Depth follows shadcn's native vocabulary and nothing more: hairline borders define structure, a whisper of shadow keeps surfaces from feeling painted on, and real shadow is reserved for things that genuinely float. In dark mode, tonal layering does most of the work (Void background, 0.205-lightness cards, 0.15 washes) because shadows read poorly on black. The card step has to survive 8-bit quantisation to do that job: anything under about oklch(0.12) rounds to the same rgb(0,0,0) as the background and separates by nothing at all.

The editor shell is inset 12px from the viewport on all four sides at `md` and above, with a `--radius-xl` corner, a hairline border and shadow-xs over the Page surface. That inset is the app's one structural elevation: it says the editor is a thing on a page rather than the window itself. In dark mode the Page step carries it alone, since shadow-xs is invisible against any of these tones. Below `md` the inset is dropped entirely, along with the border and the radius, since 24px of a phone's width is a real cost and the status strip needs the bottom edge of the screen for the home indicator.

### Shadow Vocabulary

- **shadow-xs** (`0 1px 2px 0 rgb(0 0 0 / 0.05)`): Outline buttons at rest. A form control carries a fill and a border instead.
- **shadow-sm** (`0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)`): Cards and workflow nodes.
- **shadow-lg** (`0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)`): Dialogs, dropdown menus, popovers: true overlays only.

### Named Rules

**The Overlay Rule.** Anything at shadow-lg must be dismissible. If it can't be dismissed, it isn't floating, and it doesn't get the shadow.

**The Scrim Rule.** A modal layer dims the page behind it with `bg-scrim`: black at 40% in both themes, with no blur, so dark mode darkens too. Dialogs, alert dialogs, stacked overlays and the phone drawer all use it. The command palette uses none, because the canvas it acts on stays readable behind it. A stacked overlay shares the dialog's container and motion: Popover fill, 14px radius, hairline ring, shadow-lg, and a 200ms fade with a 95% zoom.

## 5. Components

All primitives are shadcn/ui on Base UI, refined and restrained: quiet at rest, precise on interaction. Focus is always a 2px halo in full `--ring` with a border-color shift, and an element with no ring of its own gets a 2px `--ring` outline. Both clear 3:1 on Paper, Panel and Wash in light (3.95, 3.78 and 3.62:1) and on every dark surface; hover is always a fill change, never movement.

### Buttons

- **Shape:** Gently rounded (8px), 28px tall at default size.
- **Primary:** Graphite Ink fill with Paper text, hover dims to 90% opacity.
- **Outline:** Paper fill, hairline border, shadow-xs; hover fills with Graphite Wash.
- **Ghost:** Transparent until hovered, then Graphite Wash.
- **Destructive:** Signal Red fill; the only chromatic button.
- **Focus:** 2px ring in full ring color plus a border shift, visible in both themes. `--ring` is oklch(0.6 0 0) in light so the ring clears the 3:1 that WCAG 1.4.11 asks of a focus indicator, on borderless ghost controls as well.

### Cards / Containers

- **Corner Style:** 14px (rounded-xl), the roundest shape in the system.
- **Background:** Paper with hairline Graphite Line border.
- **Shadow Strategy:** shadow-sm per the Elevation section.
- **Internal Padding:** 24px vertical rhythm, 16px on the small variant.

### Inputs / Fields

- **Style:** A `--input` tint, hairline border, 8px radius, 28px height, no shadow at rest.
- **Focus:** Border shifts to ring color plus the 2px halo.
- **Error:** `aria-invalid` drives a Signal Red border and red-tinted ring; error state is attribute-driven, never a bespoke class.
- **Disabled:** 50% opacity with pointer events off.

### Workflow Node (signature component)

The reason the product exists. A 192×112px rectangular card at 8px radius sitting on the React Flow canvas, with one anatomy at every zoom. A lead row in the top-left corner holds the step's kind glyph, its number in run order, and its issue badge or disabled mark; the run status sits in the top-right corner. Below the lead row the full card adds a 14px medium title that wraps to two lines and a one-line description. A Condition holding more than one rule leads that line with how many must match, such as "All of 2 rules", because its title names one question. As the card shrinks it drops detail, and the lead row and status keep their places while a title follows. Below zoom 1, where the full card's 12px description, status chip and connection labels would draw under the 12px Caption step, every card draws its compact form: the lead row is set in 22px type, the description is gone, and the title takes the card's full width in the same medium weight and breaks only between words: 24px down to 22px on two lines, or 21px on three, after which it ends in an ellipsis. A 4px gap separates it from the lead row, and its box is what the card leaves at the compact form's lowest zoom, so three lines still clear the lead row and the bottom handle. A title holding one word wider than the card shrinks until the word fits, and hyphenates below 16px. Below zoom 0.52, where a 21px title would draw under 11px, every card draws its number form: the lead row alone, centered in the card, since the outline carries the names and the number ties a card to its row. In that form the lead row draws at 18px on screen wherever the card holds it with 8px on each side and 6px above and below, its 2px border included, and shrinks to that room where the card is smaller, so a number never touches or crosses the border. The status icon is 14px and hangs off the card's top-right corner, 4px inside and 10px outside along each edge, so it never meets the glyph or the number. Only the card box shrinks with the canvas. Waiting is marked by a clock, apart from the Wait step's hourglass glyph. Each switch between forms is a change of one value a card reads from the zoom, so zooming between switches redraws nothing. The Lifecycle card's lead row holds its Play glyph and no number. Unless a builder names it, the card is titled by what starts a run, such as "When Payment settled", and "Start" while no Start Event is chosen, and its line says only what the title leaves out, such as "Filtered". A start a builder named keeps that name as its title, and its line says what starts it, such as "On Appointment created"; the outline's "Starts when" row reads the same name and the same line, so a trigger has one name in both places. The issue list and the review sheet use the same name, and the review sheet lists a new start as "Added". Value references keep the node's own name. A Group's lead row holds the Group glyph beside its number when it has one. A compact card's run status is its border and a 22px status icon in its top-right corner, named by the status word. Outlet captions and connection labels are not drawn while cards are compact, because the outline names every outlet in words. The change marker straddles a compact card's top-right corner, clear of the title. Event Split is wider at 264px on purpose, because it carries two labelled outlets. A collapsed Group draws at the same 192×112. The card is flat; elevation on the canvas would compete with the status border.

At rest the border is Canvas Line, 2px flow at zoom 1 and above and held at 2px on screen below it. A line 2px wide on screen covers at least one whole pixel wherever it falls, so it reads at Canvas Line's own contrast, 3.95:1 in light and 3.21:1 in dark, at every card size; at the fitted zoom a 1.5px flow border drew 0.5px and measured 1.29:1. Edges and a Group region's border are held the same way. Status is worn on that same border, stepping up to 3px held the same way: Signal Green for success, Signal Red for failure, Signal Slate for cancelled, and an animated Signal Blue sweep while running. A step the run is parked on keeps the resting border and shows a Waiting chip, and a step the executor is retrying after a failure keeps it too and shows a Retrying chip in Signal Amber. Every status also renders its word in a chip, so the border is never the only carrier. The chip straddles the card's top edge, right-aligned in the strip between the top handle and the card's right corner, so it covers neither the type icon nor the handle. A chip wider than that strip starts just right of the handle and runs past the card's right edge into the gap between siblings. The chip reads Running, Waiting, Retrying, Completed, Failed, or Canceled, the words a run reads with, the same words a run's Group card, Group summary, and member rows use for that step. A successful step that did nothing because the run has Test recipients keeps the resting border and reads "Skipped (test run)" on its chip, its outline row, and its evidence, which says why in one sentence. Focus shifts the border to Graphite Ink rather than the ring color, because the resting border already sits at the ring's lightness and the shift would otherwise read as nothing.

A Group draws in place on the canvas as a region around its member steps, which are ordinary cards with their own step numbers, handles and status. The region's node box starts at the frame's stored position, where members' local positions start, and reaches 24px past the last member's right and bottom edges. Its outline reaches 24px further left and a 56px header plus 24px further up: a dashed Canvas Line border held at 2px on screen over the Canvas Region fill, so connections inside the region stay visible. On the full card the header holds the Group glyph and the Group's number when it has one, its label in 14px type, its issue badge, on a run's canvas its run status and member counts, while the review sheet is open the number of changed steps, and a **Collapse group** control. When cards are compact the header names the Group on up to two lines in 21px type, which draws at 11px or more, with its issue badge and a run status icon; when cards show their number alone it shows the Group glyph and its step count at 12px on screen, with the same marks. **Collapse group** is also on the Group's context menu at every zoom. Only the header takes the pointer: pressing it selects the Group and dragging it moves the Group with its members, while a press on the region's body reaches the canvas. On a run's canvas the border turns solid and takes the outcome's signal colour, as a step's border does. Connections into and out of a Group attach to the member steps they really connect. Such a connection makes its horizontal run above the region and passes under the region's header band, its stroke hidden across the band, so it never strikes through the Group's name or marks. Each member is held inside its region: dragging one moves it inside, and the region grows to its right and bottom edges as the member nears them. A Group that is collapsed draws as one card: solid Graphite Wash behind the card's held Canvas Line border, a title band holding the Group icon, the label, the issue badge and an **Expand group** control, and below a rule an optional one-line description above the number of steps, or on a run's canvas above the Group's run status and step counts. Collapsing is the viewer's own choice for the session and changes nothing stored; folding the Group in the outline leaves the canvas alone, and **Tidy layout** keeps the region's room. Edges entering a collapsed Group attach to the card's one top handle, and edges leaving it attach to its one bottom handle, which carries no label. Every edge from inside the Group to the same outside step draws as one edge from that handle, and when every edge it stands for leaves by the same Condition branch, it carries that branch's True or False label. While nothing leaves the Group, dragging from the bottom handle to an outside step adds a connection from each terminal non-Condition member. Unused Condition outlets stay unwired, so taking an unused branch ends the path without running the outside step. If only unused Condition outlets remain, the editor asks the builder to expand the Group and choose a branch. Deleting an edge drawn from the card deletes every connection it stands for.

Two gestures add a step where a path already runs. **Add step after** on a step's context menu, one row per outlet so a Condition, an Event Split and the Lifecycle Node say which branch, inserts a step on that outlet: each existing connection becomes source → new step → former target. **Add step** from the palette or toolbar does the same while one step is selected, and uses the Started outlet while the Lifecycle Node is selected. With nothing selected, Add step joins the Started path when that path has exactly one open end: the Started outlet of a new workflow, or the one outlet nothing leaves yet. Otherwise the step stands alone, placed clear of every card by half the layout's gaps and clear of every connection and its label. Dragging a connection from an outlet into empty canvas adds a branch with no automatic rejoin. Every open end of a path, an outlet nothing leaves yet, draws a + below its handle, below the outlet's caption on a full card, while cards show their title and the Draft can be edited; pressing it adds a step on that outlet, which opens with the list of what it can do. It is held at 20px on screen, and it is not a Tab stop, since the outline's / and the step's menu reach the same command. A Canceled outlet that no Cancel Event can take draws none. **Insert step**, on a connection's context menu and on the + control the connection draws while it is hovered, selected, or focused, puts the step inside that connection instead: the connection's source reaches the new step and the new step reaches what the connection reached. On a downward connection, the new step takes the target's position and moves the target and its downstream cards down by one rank. Cards on sibling branches stay fixed. On a collapsed Group card the connection stands for every stored edge it draws, and all of them are replaced. Each gesture is one undo step and goes through the Group rules. **Ungroup** shows on the menu of a Group card and a Group member, and nowhere else. The draft's outline holds an **Add a step** row at every open end of a path: beneath an outlet nothing is connected behind, such as "Otherwise, the path ends", after a step with no connection out of it, and first under "Steps" while nothing follows the start. The row is a stop for the keyboard, and pressing it, Enter, Space or `/` opens the same step picker `/` opens, which adds the chosen step on that open outlet. A run's outline and the review sheet's hold no such row.

A Group's members are authored on the one canvas. A connection between two members, from an outside step to a member, or from a member to an outside step is stored as drawn, and the Group rules judge it: a Group is entered from one outside outlet, so a connection that would enter it from a second outlet is refused with a notice, and a connection that would continue the Group to a second outside step from several outlets, give a step inside the Group a branch from outside it, or put a Condition on a branch into a join, is refused with the notice Publish would give. A step joins a Group from the selected member or the drop position: **Add step after** a member and **Insert step** on a connection leaving a member add the step to that member's Group, a step placed or dropped inside a region joins that Group, and **Paste** and **Duplicate** join the Group every selected step is a member of, or, for a paste at a point, the Group whose region holds the point. Copying a member copies that step alone, and copying a Group copies it with its members. Every such change is one undo step, and a change the Group rules refuse stores nothing and shows the refusal as a notice. **Tidy layout** first lays out each Group's members by the edges between them, with the topmost and leftmost member at the region's corner, then sizes the region and lays out the whole graph around each region as one box, in one undo step. **Ungroup** translates the stored member positions by the frame position, then moves the arrangement together down and to the right until it clears outside cards. Connections that would create a cycle are refused before any graph, history, or save change. A link that carries the `group` key an older editor wrote opens the workflow with that Group's first step selected and drops the key. A workflow last laid out by the editor that drew Groups as collapsed cards, which shows as a Group frame holding members with no stored size or exactly the card's 192 by 112, is laid out again once when it opens, the way **Tidy layout** lays it out, and saved through the ordinary draft save; a frame the in-place editor writes always stores its region's larger size, so its layouts are never touched. A viewer who cannot edit, a run's pinned graph, and the review sheet's comparison show such a graph laid out for display and write nothing.

Handles are 12px dots in Graphite Ink with a hairline ring, and their hit areas are 24px on desktop and 44px on touch. Those sizes are divided by `--rf-zoom`, the live canvas scale the viewport transform applies, because a flat pixel size inside that transform shrinks with the zoom and delivered 24.6px on a phone.

Edges leave the bottom handle, travel in a rounded orthogonal step, and enter the top handle of the next node. The dash is the wire, 2px of Canvas Line and Graphite Ink when selected, with its width and its dashes held at that many screen pixels while the canvas is zoomed out; a label sits on the horizontal span when the outlet has a name. The dash holds still on a Draft, under the review sheet and on an ended run, and marches only on the canvas of a run in progress, along an edge the run may still take, so motion on the canvas always means work in progress. An edge landing where the run cannot go widens its dash gap, keeping a legible stroke rather than fading toward the background.

A run's canvas shows the path the run took, read from its recorded executions. A Condition leaves by the branch its answer names, an Event Split by the outlet of the Event it recorded, and any other step by each edge whose target the run reached. An edge the run took is a solid 2px Graphite Ink line that does not march, and is drawn above the others. An edge it did not take wears the unreachable face: Canvas Line Muted, the wider dash gap, and no march. While the run is in progress, an edge it may still take keeps the live marching dash. The outlet label of a branch the run took, on the edge or under the card, inverts to Graphite Ink with Paper text and leads with a check, so it reads without color; the label of one it did not take drops to 70% opacity. A Group card's edge is taken when any edge it stands for was, and on a focused Group canvas the edges to and from stubs follow the same rule. A Draft canvas shows no path.

A step the run can never reach is muted: the card drops to 50% opacity, its incoming edge takes Canvas Line Muted and a wider dash gap, and that edge never marches, even while a run is in progress. Two things put a step out of reach, and both wear this: a Canceled subtree while no Cancel Event is declared, which also labels the outlet, and everything below a disabled step, since disabling one ends its branch. A disabled step wears its own face instead, 50% opacity with an eye badge, which is what separates the step a person switched off from the steps that lost their path because of it. A Group frame has no enabled state and never wears the disabled face; each member wears its own.

### Navigation

A quiet menu bar spans the editor. Below it the canvas fills the editor, with
the status strip beneath it, and everything else floats over the canvas: the
outline at the top left, the zoom controls at the bottom left, the agent's
prompt line at the bottom, and the Inspector at the right edge while something
is selected. Nothing docks beside the canvas, so the canvas box never changes
size. The selected workspace uses a Graphite Ink fill with Paper text. Tone,
rather than an accent stripe, marks the active workflow.

The workflow workspace has two views: **Draft** and **Runs**. A
segmented control precedes the Run split button and **Publish** at desktop
widths. Below `md` the two views sit at the top of the toolbar's overflow
menu, the active one checked, above the run commands and **Publish**. The
outline, the Inspector, the editing lock, and the status strip always follow
the same active view.
A workflow opens with its cards readable. The camera fits the whole graph, with
the padding **Fit view** uses and no higher than 100%, so a small workflow is
not blown up, when that leaves every card at the compact form or larger, with
its number and title. Otherwise it opens at the compact form's lowest zoom,
0.52. The Lifecycle card sits at the top center of the usable canvas. A graph
that fits but would clip at that anchor is centered, and a graph that does not
fit at 0.52 runs off the bottom edge. **Fit view** still fits the whole graph,
and the number-only form is there for a person who zooms out. A camera remembered for the view wins. When a resolved
view changes to a view with no remembered camera, the canvas places the graph
the same way, never zooming in past the zoom it had. A run that failed, is
waiting, or was canceled then moves the least distance that puts the step where
it stopped in the usable canvas. Loading changes inspector status without fading,
re-fitting, or replacing the last valid canvas; resolved content replaces it
only when the next presentation is ready.

**Draft** owns the editable workflow and its properties. **Runs** opens on
the run list, opens a run only when the person picks one or the route names one,
and owns the run list, run details, and run-node inspection. Reviewing a change before publishing it, and reading what a
past version changed, happen in the review sheet, described under Publication
review.

The outline floats 12px inside the canvas's top left corner, capped at the
canvas height less the room the zoom controls need, and scrolls inside itself.
It is plain rows over the canvas with no box, border, background or header; a
soft shadow in the canvas colour behind its text keeps it legible over cards
and connections. A row shows a faint fill under the pointer and a stronger
Selection Blue fill when selected, with no edge bar. Cmd+F (Ctrl+F) shows a
"Filter steps" field at the top of the list and puts the cursor in it; Escape
clears and hides it, and leaving it empty hides it. On a phone the field stays
at the top of the outline. The run list's rows float the same way.

A row and its canvas card answer the same gestures in an editable Draft:
pointing at either puts the pointed tint on the card, a click selects the
step, Shift-click adds it to the selection, Cmd-click (Ctrl-click) adds or
removes it, Delete or Backspace deletes the selection, Enter opens the step
with focus in its first field, and right-click opens the step's context menu.
A right-click on a row or card outside the selection selects it first; one
inside a selection of two or more steps keeps the selection, and the menu
names the count and offers only what applies to every selected step: **Group 2
steps**, **Duplicate 2 steps**, **Copy**, **Disable 2 steps** or **Enable 2
steps** when all are steps, and **Delete 2 steps**, the last three absent when
the selection holds the Lifecycle node.
`[` hides and shows it from anywhere outside a text field, and the command
palette offers the same command. In Runs with no run open it is the run list,
which always shows, because it is the only way to open a run. Hiding it is not
remembered across reloads or workflows.

The Inspector is one card floating 8px inside the canvas's top, right and
bottom edges, 340px wide, on the card surface with a hairline border, a 14px
radius and shadow-lg. It opens when something is selected: a step, a
connection, a Group, the Lifecycle node, or in Runs an open run or a run node.
Two or more selected steps close it, since their commands are the context
menu's. It closes when the selection clears, on its **Close**
control, and on Escape with nothing left to step back through, which returns
focus to the selected step's outline row as before. Pressing a step on the
canvas or its outline row opens it again. Selecting something else while it is
open replaces its content in place, and the card does not move or resize. In
Draft with nothing selected, and on the run list, there is no card; the
workflow's issues are reached from the issues chip. It floats, so the canvas
box keeps its size and nothing reflows, and the camera moves only when the card
would cover the selection. Under reduced motion the card appears and leaves
without sliding.

The Inspector's header is one row: **Back** where a jump reached the object,
the step's number and title, its status or issue count, a ⋯ menu, and
**Close**. It draws no path. The ⋯ menu of a Draft step, Group or Lifecycle
node holds the commands its context menu on the canvas offers, from the same
source, less Edit: Disable or Enable, Add step after on each outlet, Copy,
Duplicate, Group, Ungroup, Collapse or Expand group, and Delete. The body
scrolls inside the card while the header stays put.

The build agent works on the whole workflow, so it sits on the canvas rather
than in the Inspector. In Draft and Runs, for a viewer who may use it on
a server that offers one, one prompt line floats at the bottom centre of the
canvas, up to 560px wide, on the card surface with a hairline border and
shadow-sm, clear of the zoom controls on the left and of the open Inspector on
the right. Its placeholder reads "Ask about this workflow, or describe a
change". Focusing it, or sending, opens the conversation directly above it: a
Popover-filled panel up to 560px wide and 60% of the canvas tall, with a
hairline ring and shadow-lg, holding the thread, the suggestions, tool
activity, errors, **New conversation**, and **Close conversation**. That
control and Escape collapse it back to the line and keep the conversation; the
line then shows a small dot while the agent works or after it replied.
Clicking the dot, clicking the line, or pressing Enter or Down in an empty line
opens the conversation again, which also works when the line kept focus. The
conversation covers the canvas where an edit lands, so the agent's first edit
in a turn collapses it to the line, whose dot says the agent is still working,
and when the turn ends the camera shows the steps it added or changed if they
are out of view. With a
step selected, the line offers it as a chip, such as "+ Step 4 · Send 24-hour
reminder"; pressing it attaches the step to the message being written, its ×
removes it, and nothing is attached unless the person attaches it. Every fit
and every camera placement keeps the graph above the line and above the 24px
row that chip adds, so selecting a step never covers a card the fit placed. A sent
message shows its attached step above it in the thread. The command palette's
**Agent** puts the cursor in the line. Opening
or closing the conversation moves no camera and no column, and neither ever
changes the canvas box. Opening a workflow, Fit view, and a placement keep
cards clear of the line. While the review sheet is open the line and the
conversation hide, since the canvas is read-only then.

A workflow that holds only its Lifecycle Node draws nothing more on the canvas: choosing what starts it is the Inspector's, adding a step is the outline's **Add a step** row and the start card's +, and the agent's prompt line sits at the foot of the canvas. The build agent's empty conversation offers **Explain this workflow** and **Why did the last run fail?**, and each sends at once.

On a phone the zoom controls sit in a row along the bottom edge. The zoom
controls draw on the card surface, so the graph never shows through them.

Selecting an ordinary step, which is any Action or Wait, shows its editor in
the Inspector at once. A press on a step selects it only when it ends as a
click. Dragging a step never selects it or moves the camera, and dragging a
step that is not selected clears the selection. The header offers **Back** only
where a jump reached the object, such as the Lifecycle node opened from an
Event Split. No header control changes a level. A step's editor holds an
editable label and
description, what it does and its Connection, and every setting as its field.
What it does is one field, **Does**, that names the action with its category,
such as "Appointments · Send Patient Message", or the action alone for a
built-in step such as Wait. Pressing it opens, in place of the form, the same
searchable list grouped by category that adding a step uses, with focus in its
search; choosing an action closes it, and Escape closes it with focus back on
the field.
Each issue shows beneath the field it names, and the Validation list repeats
every issue, where choosing one puts focus in its field. An empty required
field waits: it says "is required" beneath itself once it has been focused and
left empty, or once a Run draft or Publish was refused for it, so a step just
added shows no red text before anyone types. The issue counts from the start,
in the Validation list, the outline's issue mark and the issues list. A template field's
help line says that typing @ inserts a value from the Event or an earlier step.
Edits write to the draft as they are made, and autosave carries on. Typing in
one field is one undo step until the field loses focus or the typing pauses for
a second, the way a text editor groups it. A step with no
action chosen shows the **Does** field open with its list, and choosing an
action moves focus to the first required field it leaves empty. A Wait opens
on the one choice it needs: how long, under how it should wait, or which Event
it waits for. Its other settings sit under **More options**, closed by
default: for a time-based Wait the time source, what happens when the
scheduled time has passed, the allowed hours and the timezone, and for an
Event Wait when to stop waiting and what happens then. **More options** opens
by itself when any of them is set away from its default, including an Event
Wait's timeout left blank. The Condition's rules and the Event Split's
outlets are each the step's one choice, so neither has such a disclosure. A Condition's rules are live the
same way: the sentence saying when it takes True sits above them and changes as
they do, and there is no Edit or Done. Every rule builder, the Wait's match and
the filters and eligibility rule in the Start's form included, edits in
place; a person who may not edit reads the rules as sentences. A rule names
its field with the step it comes from, "Status · Patient State", when another
input shares the field's name. A Condition's rule keeps field,
operator, value, and remove on one line where the rule has 28rem; in a
narrower Inspector the field shares the first line with remove, and the
operator and value share the second. The operator is always as wide as its
chosen label, so "is greater than or equal" never reads as "is greater than";
the field and the value take the width it leaves. Selecting a
Group, by its header or its card, opens its editor: its label and description,
the step count, each step in stored position order, the outside steps that
enter it, the step it continues from with the Condition branch when it leaves
by one, the steps it continues to, its issues, **Ungroup**, and **Delete Group
and steps**. Each step is listed with its issue count and selects that step on
the canvas. The Group's issue badge and the status in the Group's header count
the steps' issues with the Group's own. A connection and a multiple selection show
their panel under a header holding the panel's title. **Runs** has a Browse of
its own.

Selecting an object with the pointer opens its editor and leaves keyboard focus
on the canvas object. The context menu's **Edit**, Enter on a focused object,
and the command palette finding a step open the editor with focus in its label,
or in the **Does** list's search of a step with no action. **Edit** on a row of the
workflow's issue list, in the issues chip's list or in the list a blocked
Publish opens, selects the step, opens the Inspector,
and puts focus in the field the row names. A
step added from the palette opens with focus in the first required field it
leaves empty, and any other new step opens with focus in the **Does** list's
search.
However a step is added, by the palette, the outline, a connection dropped on
empty canvas, a duplicate or a paste, the camera then moves once, the least it
must, to show the new steps clear of the agent's prompt line and the canvas
controls, and does not move when they are already in view.

Selecting the start opens its one form, which is always editable and shows
only what is set, with no summary and no Edit or Done. **Starts when** always
shows: the Start Event picker and each chosen Event with its payload Start
Filter, or **Filter the arrivals** to add one, then **Can be run by hand**.
Each other rule shows once it is set, as its controls under one label, in this
order: **One run per**, the tracked Entity, with each Event's binding where the
Event offers more than one, its eligibility rule named for the Entity, such as
"Only while the patient matches", and **When to check**; "If a run is already
in progress"; "On a schedule", each schedule with its next runs; and "Stop a
run when" with its Cancel Events. Event Connections show without being added
while a Start or Cancel Event arrives through an integration, since such an
Event reaches no run until its Connection is chosen. **Add a rule** sits at the
end, and its items name each rule not yet set by what it does: "Only start
when…" (a Start Filter, offered once a Start Event is chosen), "Stop a run
when…" (Cancel Events), "If a run is already in progress…" (Overlapping runs),
"On a schedule…", "One run per…" (the tracked Entity) and "Only while the
record matches…" (its eligibility rule). Choosing one shows that rule's
controls in place and moves focus into them, scrolling only as far as bringing
them into view needs; a rule added and left empty stays until it is removed. A
rule goes by that one name in its menu item and its label. CONTEXT.md keeps the
domain nouns for the same rules. A set rule's **Remove**, a small control on
its label row, puts it back to its default, every arrival starting its own run,
no schedule, no Cancel Event, or no Entity, and focus moves to **Add a rule**.
What a choice does, which runs count as related, and the binding an Event with
one binding uses sit behind the info icon on the rule's label. Start Filters and
eligibility are separate rules, and each one's help says what it reads: the
arriving Event's payload, or the Entity's current state from the host. A
refusal Publish would give shows beneath the rule its check reads, and an issue
no rule holds is listed at the end of the form, after the label, which follows a
divider. Every Lifecycle Rules problem Publish refuses, including a Start or
Cancel Filter reading a path its Event does not declare, is a blocking issue. A
schedule is a preset (Every hour, Every day at, Every weekday at, Every week on)
or a Custom cron expression, with its own time zone, starting from the
browser's. Each one reads back as a sentence and its next three runs. Each
schedule saves as it is edited. One that cannot be saved, such as an invalid
expression or a duplicate, stays in the form unsaved, keeps the version it last
saved, and is named beneath the schedules. While the workflow tracks an Entity,
the help of its Start and Cancel Events says that their Entity bindings supply
run identity, and they show no Correlation Path controls. The Lifecycle node
shows no Delete.

A selected Condition opens the same header. Its editor starts with one sentence
stating when the Condition takes True and which AND or OR joins its rules or
groups. The rule builder sits beneath it, open for editing, with each rule on
one line: the field and the value share the free width, the operator takes
less, and the remove button keeps its own slot at the end. Then come the steps
its True and False outlets continue to, or a line saying a disconnected branch
ends the run, every value its rules can compare, the label and description, the
issues, and the enable, Ungroup, and delete controls. Each issue puts focus in
the rule builder.
Placing a Condition sets the zoom from its card and both outlet handles, and
keeps each True and False label on its outgoing edges inside the usable canvas
too when the label fits at that zoom. A label on an edge to a distant step stays
off screen.

A selected Event Split opens the same header over a summary with no editor. It names the
Event source its outlets come from: the Lifecycle node's Start Events for a
split on the Started side, its Cancel Events for a split on the Canceled side,
or the Wait Subscriptions of the nearest event-mode Wait above it. It lists each
outlet with the Event's label, optional description, raw Event name, and the step
its stored connection leads to, or a line saying a disconnected outlet ends the
run there. The primary action opens the source: **Open start Events**
or **Open Cancel Events** selects the start and puts focus in that rule's Event
picker, and **Open** followed by the Wait's name selects the Wait
and opens its editor. **Back** from either returns to the Event Split. The list also says when no Event source reaches the Event
Split, when an outlet's Event is no longer declared by the app, when a stored
connection names an Event that no longer reaches it, and when a connection
leaves by no outlet. Placing an Event Split sets the zoom from its card and its
outlet handles the same way a Condition does, keeping every outlet label that
still fits inside the usable canvas.

**Runs** has a Browse of its own and shows a run node's evidence in Focus. The
run list is the outline's: its first row holds **Refresh** and **Delete all
runs**, above the superseded count, the Refused Starts, the
Cancellation Failures, a muted line naming the host's run retention window when
the host deletes old runs, and the run rows. The All Runs list on the workflows
page states the same window under its title. Selecting a run adds a browser history
entry and puts the graph version the run pinned on the canvas. The outline
then shows the run's outline under a row naming the run, with **Back** to
the list, and J and K open the next and previous run in the list. A failed run
opens with the step that failed selected, and a waiting run with the Wait it is
parked on, so the Inspector shows that step's evidence. The Inspector's header
titles the run by its Entity and its start time, such as "Patient pat_20418 ·
Nov 25, 7:42 AM", shows its status, and offers **Back**. A run's Entity is the
Entity's label and the id the host supplied. A workflow that tracks no Entity
names its runs by their Entity Value, and a run with neither, such as a manual
run with no payload, by its Event's label, or as a scheduled or manual run. The
path and the phone's Back label use the same title, and the path's **Runs**
segment opens the run list the way **Back** does. A run's row leads with the
same title, puts the Event's label or the schedule and the start time on its
second line, and prints no id. All Runs puts the title and the Event under the
workflow's name. The short id, the last eight characters of the run's id, is a
detail row of the run's summary and appears in the status strip.
Browse holds the run's start identity, outcome, timing, and entity, then its
active waits with **Resume now**, **Cancel**, exit details, the failure summary,
and activity. The failure summary states the cause once, in a
plain sentence above the stored error. When a step's Connection refused or
lacked its credentials, the sentence names the Connection and offers **Edit
connection**. Beneath the cause, the summary names the steps after the failed
one that did not run, by number and name, and says the run has ended and is
not retried, so a fix reaches the next run. The failed step's Error section
says the same two sentences beneath its error, since a failed run opens on
that step. Activity entries read in the Runs view's words, with a clock time
and the stored type as secondary text. **Back** and Escape on a run replace the history
entry with the run list and put focus on that run's row, or on the header title
when the list shows no row for it. A run past the newest 50, or one that leaves
the list, keeps its view and says why it is not listed. Each run list remembers
whether it shows superseded runs.

Selecting a node on a run's canvas, or its row in the run's outline, opens
Focus on that node's evidence. A row for a Group member opens that
Group's view with the member selected. The header adds the node to the path and
shows the status of the execution on screen; **Show evidence** and **Return to
run** switch levels. An execution is one time the run reached the node, such as
a second pass through a branch run. Retries inside one execution leave no
separate record, so an execution shows their final outcome, and Focus says so.
Focus lists every execution of a node the run reached more than once, as
"In this run · time N of M", and choosing one changes neither the canvas selection nor
the control that has focus. Each execution shows its status, start,
finish and duration, its error or cancellation, the wait it holds with **Resume
now**, what the step did in words, and the node's activity such as parking and
resuming. A Condition leads with its answer, such as "Took False", and the step
the branch continues to, or that the path ends there. Each rule then reads as
the sentence the Inspector builds for it, with whether it matched where the
answer and the rules' logic decide that, and the value it compared where the
run recorded the step it reads. Any other step shows its integration's own
result display when it has one, then its input and output as labeled values
under the action's field labels. The recorded input, output, and the node's
configuration in the graph the run pinned stay as raw JSON with **Copy** behind
one **Show raw data** disclosure, closed each time a step's evidence opens. Notices say
when the node is no longer in that graph, when the graph is loading or could not
be loaded, when an execution never finished, and when the run is still in
progress and refreshing. A Group records nothing in a run, so a Group card has
no evidence. On a run's canvas the card shows the Group's run status and counts
of its steps, such as "3 of 5 steps reached, 1 failed", and never a percentage.
The status is Failed, Canceled, Retrying, Waiting, or Running when any step
is, in that order. With no step reached it is Idle. A Group is Completed once
a step it continues to has evidence, or once the run completed with evidence at
one of its steps where a path ends inside it, such as a Condition branch with
no step after it. A Group with no step after it is also Completed once the run completed.
Otherwise it is Reached, and its border carries only Completed, Failed, and
Canceled. The card, its summary, and the step cards read one status per step,
so a step's chip and the Group's counts always agree. Selecting the card opens
its summary in Browse, titled by the Group, with the same status and counts and
each step with its own status. Choosing a step there enters the Group and opens
that step's evidence in Focus. **Back** and Escape from that evidence return to
Browse in the Group, then to the overview with the Group card selected and its
summary shown, then to the run with focus on the card, and then to the run
list. From evidence Focus opened on the overview they return to the run's
Browse at the scroll position it was left at, with focus on the outline row or
canvas node that opened Focus. A click
on the empty canvas clears the evidence. Selecting another node replaces the
evidence and shows its latest execution. The chosen execution is remembered for
each run. On a phone the evidence replaces the run overview in the sheet, and
its heading takes focus.

Escape and **Back** take one step back as the shown object's kind defines it.
In Draft, Escape inside the Inspector belongs to an open select,
combobox, menu, autocomplete, or dialog first, and then hands focus back to the
selected step's outline row, or to the selected object on the canvas when the
outline does not show it.
For the Lifecycle node or a Wait opened from an Event Split, Back and that last
Escape select the Event Split again. The way back lasts while the source stays
selected alone; selecting anything else ends it, and Back is then no longer
offered. For a run node's evidence the step back is the run, and for a run it
is the run list. In Runs, opening Focus moves focus to the title. The inspected
step and the inspector's scroll position are remembered separately for Draft,
each Group view, the run list, and each run.
Levels add no browser history.

Selecting an object moves the camera only when the Inspector would cover it. The camera
moves for a request alone: the command palette finding a step, an issue's
**Edit**, a jump to another scope, the review sheet pointing at an edit, and a
selection that the Inspector would cover. A request never runs
layout, moves a node, or marks the draft changed. The camera keeps its zoom
when the nodes fit the usable canvas, the canvas less its controls, the
MiniMap, and the part the review sheet or the Inspector covers, and zooms
out only as far as
fitting them needs. It then moves the least distance that keeps them and 64px
of their neighbors inside the usable canvas, so a node already in view moves
nothing.

Below `md`, 900px, the outline is the editor's main view and fills the width.
A **Map** control in the toolbar shows the canvas in the outline's place, and
pressing it again returns to the outline. The canvas under the outline keeps
its camera and leaves the tab order. `[` does nothing there.
The agent's prompt line sits below either view, above the status strip, so
the outline's last row and the bottom of the map scroll clear of it, and its
conversation covers the whole screen under a header whose Back returns to it. Details are a sequence of sheets over the outline or the canvas.
Selecting a step, Condition, Lifecycle node, Event Split,
Group, or connection opens its summary sheet over the bottom of the
canvas, which stays pannable and zoomable above it. It reads the object the way
the desktop editor would summarize it: settings as labels and values, a
Condition's rules as sentences, and the start's sections. A
summary sheet that opens moves the camera once, the least it must, to keep its
subject above the sheet's top edge, and only when the sheet would cover it. The sheet's header names the object and its
validation status beside **Close** and the control that opens its full-screen
editor: **Edit step**, **Edit rules** for a Condition, or **Edit group**. That
control, an issue, a start section's **Edit** and an **Add a rule** item open
the full-screen editor; the start's section list sits above its section there
and holds the sections the start has set and the one open now. An Event Split's action opens the start's details
at its section, or the Wait's summary, over the Event Split's summary. Every
sheet above the first leads with a Back control named for the sheet beneath,
**Summary** when that sheet shows the same object. Back and Escape remove one
sheet and restore the sheet beneath with its selection and its scroll position.
Removing or closing sheets never moves the camera. Each sheet moves focus to its title. After Back, focus
stays where the sheet body put it, such as a run row or the canvas node that
opened the evidence; otherwise it goes to the element the workspace names for
that sheet, then to the control that opened the removed sheet, and then to the
title of the sheet on screen. Closing the last sheet returns focus to the canvas
node. The canvas and the outline under the inspector leave the tab
order. Every control inside the sequence, and every option of a select, combobox
or menu popup while the sequence shows, is at least 44px tall, text fields read
at 1rem, and the sheets clear the left and right safe-area insets. The sheets,
their scroll positions, and the Lifecycle section are remembered for each Draft
scope apart from the Inspector, and each form factor keeps its own camera.
While a sheet shows, the toolbar's **Configuration** button is absent. A phone
offers no topology authoring: nodes cannot be dragged, added, deleted, pasted,
duplicated, grouped, or ungrouped, connections cannot be drawn, the canvas has
no context menu, multi-select, delete keys, or Tidy layout control. Undo and redo stay available on a
phone, because restoring an earlier state of the workflow is not topology
authoring. The configuration sheet opens below `md` only for a Draft with
nothing selected, and moving to another workspace closes it.

Below `md`, **Runs** uses the same sequence of sheets. A sheet has one of two
shapes: a summary sheet over the bottom of the canvas, or an inspector that
covers it. A Draft sheet is about one object, a Runs sheet is about the
address itself or about one object. Entering Runs, or **Configuration** in Runs,
opens the run list or the open run as a summary sheet. A run row opens that run's summary sheet, which holds its
status, **Cancel**, active waits with **Resume now**, exit details, the failure
summary, and activity, and adds a history entry. A row of the run's outline,
a step pressed on the run's canvas, or **Show evidence** opens that
step's evidence as the inspector over the run's sheet, and another step swaps
the evidence in place. A Group card shows its run summary in the run's sheet.
Back is named for the level it returns to: the run from the evidence or a Group
summary, and **Runs** from a run, which replaces the history entry with the run
list and returns focus to that run's row. The run list offers **Close**. Moving
from one Runs address to another with a sheet open keeps the sequence open, so
selecting a run, Back to the run list, and a
run started from the toolbar all show a sheet. Each run list and each run keeps
its sheets and scroll positions, so leaving Runs and returning shows the same
run at the same depth, and a poll or a late response never changes which sheet
shows.

On a phone, **Map** shows the same one canvas, with each Group drawn in place
around its members at the same stored positions as on desktop and an
independent mobile camera. A handle on a phone starts no connection, and a
touch on it pans the canvas. Runs offers no topology authoring on a phone. In
Runs a Group's summary in the run's sheet shows its run status, its member
counts, and each step with its status, and a step there, or its outline row,
selects that step on the canvas and opens its evidence over the run's sheet.

A Panel-toned status strip closes the canvas column: 32px tall, Caption type, a
hairline top border, and one line that never wraps. While the draft is on
screen, the strip says whether the draft is saved, and holds the issue count.

The publication state is stated once, in a chip beside the workflow's name in
the toolbar, in the words the Workflows list uses: "Live · v2 · changes not
published", "Test · v3" or "Never published", and a paused workflow keeps the
same parts after "Paused": "Paused · Live · v2". It sits behind the list's dot,
filled green for Live, filled Signal Amber for Test and an outline otherwise.
Its menu holds **Published mode**, each choice with one line on what it does
("Real Events start runs, and every step reaches real recipients." and "Real
Events still start runs, and each step follows its In test runs setting."),
with "Takes effect on publish" before the first publish; **Pause workflow**
("New Events, schedules and manual runs start nothing. Runs in progress
continue.") or **Resume workflow** ("Events, schedules and manual runs start
runs again.") once a version is published; **Version history**; and **Review
changes**. A viewer who may not edit sees the mode and cannot change
it. The chip renders nothing until the workflow has loaded, since Live is a
claim about real recipients.
The strip also identifies **Runs**, explains that editing is
off, and provides **Back to draft**. With a read-only view on the canvas, the
strip tints toward `--info`. Its height remains constant because the strip and
graph share the column height.

The 44px editor toolbar spans the full editor shell. Workflow navigation,
the workflow's menu under its name, and **Settings** form the leading group.
The workflow's menu holds **Rename**, **Duplicate workflow**, **Copy workflow
ID** and **Delete workflow**. Pause, Version history and Review changes are in
the publication chip's menu, beside the state they change.
**Settings** holds what is about the app: **Connections**, **Theme** and
**Keyboard shortcuts**. There is no save command, because the draft saves by
itself; Cmd+S (Ctrl+S) does nothing and keeps the browser's save dialog shut. Below
`md` the workflow's name keeps at least its first letters, with the full name
in its title: **Settings** shows as its icon and the publication chip as its
dot, and both keep their names for assistive technology. The 320px search control
stays centered in the shell and hides at 70rem or narrower; its keyboard
shortcut remains available. A compact **Find a step** control stays in the
trailing group while the search control is hidden. It and Cmd+F (Ctrl+F)
bring the outline into view, over the canvas or in place of a phone's
map, and put the cursor in its "Filter steps" field. The command palette's
**Find a step** row does the same. It sits between the two
groups in DOM order, so Tab reaches it in the position it appears. The workspace
control, the Run split button, and **Publish** form the trailing group, which
sticks to the shell's right edge so a scrolling row never carries a write control out of reach. The
split button's face is **Run draft**, which always starts a test run. Its
dialog says what this draft will do at each step that reaches outside the
workflow, naming the steps by the rule its "In test runs" setting or its app
decides by: "Send reminder and Alert the desk are skipped in this draft run.",
"Text the test phone sends to Test Phone Number …", "Whether Send intake form
does anything is up to the app; afterwards the run shows "Skipped (test run)"
on a step that did nothing.", and that a Wait waits its full time
unless Continue now is pressed. A published run in Test mode says the same of
its version's steps. Its
menu holds the run of the published version, labelled with that version number
and the Published mode. Below `md` the workspace control, both run commands and
**Publish** collapse into one overflow menu, each disabled for the reason its
desktop control is disabled. In Runs, disabled Run and Publish
controls say "Switch to Draft to run." or "Switch to Draft to publish." in a
tooltip, and their menu rows say it in a detail line. A paused workflow starts
no run, so in Draft both run commands are disabled and say "Resume the workflow
to run." **Configuration** stays beside that menu as an icon
button, because the Inspector is absent at that width. In Draft it opens the
selected object's summary sheet, and in Runs the sheet of the run list or the run.

Every icon-only control in the toolbar and on the canvas names itself in the
app's tooltip after the pointer rests on it for half a second, or on keyboard
focus, with its shortcut as a `Kbd` keycap. Run draft's tooltip carries its
shortcut too, and while disabled it gives the reason instead. Run draft and
**Publish** stay focusable while disabled, so a dialog they open returns focus
to them. Every dialog returns focus to the control that opened it, including
one opened from a menu row or the command palette.

The command palette reaches every menu command by the words its row uses: the
workflow menu's **Rename**, **Duplicate workflow**, **Copy workflow ID**, and
**Go to workflow…**, the chip's **Pause workflow** or **Resume workflow**; and the
Settings menu's **Connections** and **Theme**. With one step selected in an
editable Draft, the palette opens on a group headed by that step, "Step 4 ·
Send 24-hour reminder", holding what its context menu and Inspector offer,
each named with the step: Edit, Disable or Enable, Add a step after it on each
outlet, Move up and Move down, Duplicate, and Delete. A query lists the steps
it finds under "Steps", each named with its number, "Step 13 · Alert the front
desk", and a query of digits alone finds the step with that number and no
other. Its rows draw shortcuts as
`Kbd` keycaps. The canvas commands, **Add step**, **Undo**, **Redo**, **Tidy
layout**, **Fit view**, **Copy selection**, **Paste**, **Duplicate selection**
and **Group selection**, are in the palette; the canvas's context menu also
offers Add step, Paste, Copy, Duplicate and Group.
Settings' **Keyboard shortcuts** row, the palette row of that name, and "?"
outside a text field open one searchable reference of every shortcut. Cmd+Enter submits Run
draft from any field in it, and publishes from anywhere in the review sheet.

The Workflows page has no command palette. Its header holds a search field
that narrows All Workflows by name, and **New workflow**. The Workflows table and the All Runs list are
each one Tab stop. Arrow keys or J and K move between rows, Enter opens the row,
Space ticks a workflow's checkbox, and Shift+F10 opens its actions menu.
A workflow row with failed or waiting runs says so after its name, such as "2
failed" and "1 waiting", each count a signal dot beside muted words. The failed
count covers the runs the workflow's Runs view lists, and the waiting count
covers every run waiting now. Choosing a count filters All Runs to that
workflow and state and brings the list into view. The counts are no Tab stop:
the row's actions menu offers the same commands, such as **Show 2 failed
runs**.

### Publication review

**Publish** opens the review sheet. It saves the draft when it has unsaved
changes, and only then, checks it for blocking issues, and compares the exact draft on screen with the current publication.
A draft with blocking issues lists them instead, and a draft with no change
says "No changes to publish" and opens nothing. **Review changes**, in the
command palette and the publication chip's menu, runs the same path.
**Version history** in the chip's menu opens the sheet on the list of
versions. A publish that
lands ends the redo branch, so an edit undone before the publish cannot come
back after it; Undo still steps back through the edits made before it.

The sheet covers the Inspector and reaches over the canvas from the
editor's right edge, 8px inside it, up to 640px wide. The Inspector keeps
its subject beneath it and returns as it was when the sheet closes. The sheet's header holds its title, one line of counts,
**Version history** on the draft's review, and **Close**; a page opened over
another leads with **Back**. Its footer holds the decision. The body between
them scrolls as one surface, and nothing else in the sheet stays pinned.

The title is the decision: "Publish v3". The line under it counts the edits
that change what runs and the changes that do not, as "3 edits change what
runs. 1 does not." The body lists the edits in the order a run reaches them,
True before False and Started before Canceled. An edit is one added, modified,
or removed step. A connection that exists only because a step was added or
removed belongs to that step's edit. A connection that changed between two
steps that both still exist is an edit of the step it leaves, reading "Now
continues to Send intake form", or "On False, now continues to Release the
slot" for a Condition or Event Split outlet.

Each edit's header shows its marker, the step's name, one line saying what
changed, and **Show on canvas**. The line reads "New step", "Removed", one
changed setting by name as "Body changed", several as "2 settings changed",
"Rules changed" for a Condition, or "Turned off" and "Turned on". The header
sticks to the top of the body while the edit's difference scrolls under it.
Under the header a strip says where the step sits, using step labels and outlet
names and never an id: "In Pre-visit reminders: Wait until 24 hours before →
Send 24-hour reminder → Wait until 2 hours before". A branch name follows the
step it leaves, and "path ends" stands for no next step.

The difference follows the strip, in one column. A changed text setting reads
as one flow: removed words struck through on a red tint, a space, then the added words
that replace them on a green tint. A replacement covers whole words, so "$50"
to "$75" reads as all of "$50" struck before "$75", and changes kept apart
only by spaces read as one removed phrase followed by one added phrase. A template reference reads as the badge the
Draft editor draws, and long unchanged text folds around each change until
**Show full value**. Any other changed setting shows its earlier value struck
through under "Before" above its value under "Now". A Condition's rules read as
sentences, a Wait's settings use its form's labels, a Start or Cancel Filter
reads as its rules, and a Connection reads as its name. A value the server
redacted or masked reads "Hidden for security". A new step shows what its
action does and its longest text setting, with **Show all settings** for the
rest. The Lifecycle Node reads as the outline's "Starts when" and "Stops when"
sentences. A changed one shows the sentences it had struck through above the
ones it has, then its changed settings. A removed step shows its strip, with its own name struck through, and its
one line. The edit says so when
the step's action is missing from the catalog and its settings show general
names. Field labels come from the extension catalog, and machine paths never
appear as labels.

Changes that leave every run the same sit last, collapsed under **Does not
change what runs**: a Group added, removed, renamed, or given a new
description, and a step moved into, out of, or between Groups with its
connections unchanged. They start open when no edit changes what runs.

The footer states the consequence in one line beside the Published mode dot
the publication chip uses: "Live. New runs use v3 and reach real recipients. 1
active run stays on v1." It then offers **Keep editing** and the filled
**Publish v3**. Cmd+Enter anywhere in the sheet publishes, and Escape takes the
sheet back one page or keeps editing. Publish sends the exact draft the sheet
reviewed. A refusal because the draft or the publication changed meanwhile
ends the review and says why in a notice.

While the sheet is open, the Draft canvas draws the comparison and refuses
every edit. Changed cards wear the `A`, `M`, or `D` marker and the same one
line the sheet uses, and a Group's header, or its card while collapsed, counts
its changed steps, as "2 changed". The canvas holds no selection. Pointing at or focusing an edit puts
the pointed tint on its card, and on its Group's card when the step sits in
a collapsed Group, with no camera move. **Show on canvas** places the step
once beside the sheet, drawing its Group in place if the viewer collapsed it. Pressing a
changed card scrolls the sheet to its edit and moves focus to the edit's title,
and pressing a Group card does the same for the first changed step inside it. **Keep editing**, **Close**, or Escape
return the canvas to editing. Opening or closing the sheet never moves the
camera, runs layout, moves a node, or marks the draft changed. A link naming
the Changes view the editor once had, or `review=true`, opens Draft and runs the Publish path once the draft is
loaded, its publication is read, and no save or check is running.

**Version history** lists the published versions, newest first, under **In
use** when the viewer can inspect version usage. In use counts versions, not
runs: the current publication remains listed even with no active runs,
alongside every version an active run pins. Each of its rows keeps its
active-run status visible, opens to its action ids, and marks catalog drift as
a warning without implying that a draft snapshot was published. Choosing a
version opens "What v2 changed" in the same form, read-only, comparing v2 with
the version published before it, and v1 with an empty workflow. The canvas
draws that comparison. Where Publish sits, the footer offers **Restore v2 as
draft**, which asks for confirmation that the published version stays the
same. The version published now says "v2 is the current version." and offers
no restore.

The **Migrate waiting runs** command sits in the **In use** section, because
that section is where a builder reads how many runs sit on older versions. A run paused at a Wait is "waiting" wherever a person reads it: the
Workflows page's count, the run list, the migration and its refusals. "Active
runs" stays where every run still in progress is counted, running and waiting
together: the In use counts and the publish review's "1 active run stays on
v1". The
toolbar's trailing group holds **Run** and **Publish**, the commands a builder
uses on every visit, and a Migration is a rare action taken after reading the
version usage it acts on.

Added nodes use Signal Green, modified nodes use Signal Amber, and deleted
nodes use Signal Red, each with its letter. The marker is a solid signal disc
with a 12px letter, and on the canvas it grows as the zoom drops so the letter
stays 12px on screen. When the comparison holds a removed step, the canvas
lays the comparison out for display, so the removed step stands beside the
steps the published version wired it to, with no card over another; the draft
keeps its own positions. A removed step cannot be moved. Deleted edges use a
distinct dotted treatment. Node
position, dimensions, and measured geometry never create a change marker.

Below `md` the sheet covers the screen, clear of the safe-area insets, with the
same content in one column and its footer always on screen.

## 6. Do's and Don'ts

### Do:

- **Do** keep every neutral at zero chroma; the graphite ramp is the entire field.
- **Do** route every status color through its token (`--destructive`, `--success`, `--warning`, `--info`, `--cancelled`). A Tailwind palette class like `green-500` in the editor is a defect.
- **Do** hold body and muted text at or above 4.5:1: Graphite Mid (oklch(0.54 0 0)) is the lightness floor for text on Paper and Graphite Wash.
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
