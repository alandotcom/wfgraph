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
- **Graphite Mid** (oklch(0.556 0 0)): Muted foreground for descriptions and placeholders. This is the darkest gray allowed to carry text on Paper (4.5:1 floor); anything lighter is decorative only.
- **Canvas Line** (oklch(0.6 0 0), oklch(0.48 0 0) in dark): The structural stroke on the React Flow canvas, carrying a node's resting border and the wire between two nodes. `--canvas-line`. It is a separate step from Graphite Line because a node card is Paper on a Paper canvas, so this stroke is the whole card edge rather than a hairline over a fill; it is solved for the 3:1 WCAG 1.4.11 asks of a graphic carrying meaning, which Graphite Line misses at 1.20:1. Canvas only. A border inside a panel or a card is still Graphite Line.
- **Canvas Line Muted** (oklch(0.78 0 0), oklch(0.37 0 0) in dark): One step down at 2.0:1, for an edge into a subtree the run cannot reach. `--canvas-line-muted`. It is a value per theme rather than Canvas Line mixed toward the background, because mixing toward Paper lightens while mixing toward Void darkens, so a single expression reads correctly in one theme and disappears in the other. This is the one canvas stroke below the 3:1 floor, and it is deliberate: an unreachable edge has to read as quieter than a live one, and the meaning is carried by the wider dash gap and the stopped march rather than by contrast alone. Treat 2.0:1 as the floor for a deliberately quiet stroke, not as a target to design toward.
- **Void** (oklch(0 0 0)): Dark mode's background. True black, tuned for the OLED-dark canvas where the graph floats.

### Tertiary (signals)

Each signal is one token carrying both the fill and the text form. On Paper, every light-mode value clears the 4.5:1 body floor as text: Amber 5.05:1, Green 5.01:1, Red 4.77:1, Blue 6.72:1. A signal's own 10% tint costs it about six tenths of a point, leaving Red at 4.01:1, Green at 4.35:1 and Amber at 4.42:1. The `bg-x/10 text-x` pattern is therefore below the floor for those three at Caption and Body sizes. Blue holds at 5.76:1. Where words must be read at those sizes, drop the fill and let the signal carry a dot, the border, or the word itself on Paper, as the dashboard's Published mode cell does with an Amber dot and an Amber word. Closing the gap for the tint pattern needs a second token per signal, a foreground tuned against the tinted ground. Until those tokens exist, a tinted band carrying its own signal text is a known shortfall.

- **Signal Red** (oklch(0.577 0.245 27.325)): Destructive actions and failed runs. `--destructive`.
- **Signal Green** (oklch(0.526 0.148 149.58)): Successful runs. `--success`.
- **Signal Amber** (oklch(0.546 0.12 70.08)): Waiting runs, test recipients (a Published mode of Test, and every Draft run), and unmet prerequisites. Nothing else uses it; a paused workflow is graphite. `--warning`.
- **Signal Blue** (oklch(0.482 0.18 259.8)): Work in progress, including the running-node border sweep, and live template variables. `--info`.
- **Selection Blue** (oklch(0.56 0.21 264), oklch(0.72 0.17 264) in dark): The persistent outer halo on the selected canvas object. `--selection`. It stays separate from Signal Blue so selection never reads as execution state, and it leaves the node surface unchanged.
- **Signal Slate** (oklch(0.52 0.046 257.417)): Cancelled and superseded runs. `--cancelled`.

### Node-type accents

Four hues name what a built-in node does: `--node-lifecycle`, `--node-split`, `--node-wait`, `--node-condition`. These are a deliberate exception to the Signal Rule, kept because node type is the fastest thing to read on a dense canvas. Each is a single value clearing 3:1 against both card surfaces, so it serves light and dark without a variant, which is what WCAG 1.4.11 asks of a graphic carrying meaning.

The exception is bounded. It applies to the glyph of a built-in node and to nothing else: never a node fill, never a border, never a panel. A plugin's identity still lives in its own icon.

### Named Rules

**The Signal Rule.** Chroma is earned by state. If an element is not communicating run status, a destructive consequence, selection, or an integration's identity, it is grayscale. There is no decorative color anywhere in the editor.

**The One Ramp Rule.** All neutrals come from the zero-chroma graphite ramp. The single exception is Signal Slate, which carries cancelled and superseded runs: the tint is what separates "this run stopped" from "this text is quiet", and it is spent on status rather than on the field. Everywhere else a warm or cool tinted gray breaks the achromatic field.

### Routine work and warnings

Signal Red and the confirmation dialog are the two loudest things the editor owns, and both are spent on loss. The rules below keep them there, and hold every surface to one vocabulary.

**Red marks a failure or a deletion.** Running a workflow, publishing a version, and switching Published mode are routine work. Each uses the default button and no signal color.

**A confirmation dialog that warns is for an action that destroys data.** A dialog that collects what a run or a publish needs is not a warning. A setting a person can switch back is not confirmed at all.

**One fact, one vocabulary.** Every surface that shows a fact uses the words of the control that sets it. Published mode is Live or Test, Graph is Draft or v7, and Recipients is Live or Test. A column or a badge never coins its own words for a fact a control already names.

**Do not explain one control in the copy of another.** If a control needs a sentence about what its neighbor does, move or regroup the controls.

**A setting is a control, not a command.** It lives where its state is shown, which for Published mode is the status strip. It never appears in the Actions menu or the command palette.

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
- **Caption** (400, 0.75rem, 1.35): Canvas edge labels, node status chips, handle labels, and secondary run metadata. The floor of the scale. Nothing renders below it; the 10px and 11px values that used to sit here were arbitrary rather than a step.

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

## 5. Components

All primitives are shadcn/ui on Base UI, refined and restrained: quiet at rest, precise on interaction. Focus is always the 2px `ring-ring/30` halo with a border-color shift; hover is always a fill change, never movement.

### Buttons

- **Shape:** Gently rounded (8px), 28px tall at default size.
- **Primary:** Graphite Ink fill with Paper text, hover dims to 90% opacity.
- **Outline:** Paper fill, hairline border, shadow-xs; hover fills with Graphite Wash.
- **Ghost:** Transparent until hovered, then Graphite Wash.
- **Destructive:** Signal Red fill; the only chromatic button.
- **Focus:** 2px ring at 30% ring color plus a border shift, visible in both themes. `--ring` is oklch(0.6 0 0) in light so the border shift clears the 3:1 that WCAG 1.4.11 asks of a focus indicator.

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

The reason the product exists. A 192×112px rectangular card at 8px radius sitting on the React Flow canvas: a 16px integration icon, a 14px semibold title that wraps to two lines, and a one-line description at detail zoom. The overview presentation hides descriptions while retaining card geometry. Event Split is wider at 264px on purpose, because it carries two labelled outlets. A collapsed Group draws at the same 192×112. The card is flat; elevation on the canvas would compete with the status border.

At rest the border is 1.5px of Canvas Line. Status is worn on that same border, stepping up to 2px: Signal Green for success, Signal Red for failure, Signal Slate for cancelled, and an animated Signal Blue sweep while running. A step the run is parked on keeps the resting border and shows a Waiting chip. Every status also renders its word in a chip, so the border is never the only carrier. Focus shifts the border to Graphite Ink rather than the ring color, because the resting border already sits at the ring's lightness and the shift would otherwise read as nothing.

The workflow overview draws each Group as one collapsed card: solid Graphite Wash behind a 1.5px Canvas Line border, a title band holding the Group icon, the label, the issue badge, and an **Enter group** arrow, and below a rule the number of steps, or on a run's canvas the Group's run status and step counts. The Wash is what separates a Group from a step, and it inverts on its own in dark. Its members never expand in place. Edges entering and leaving the Group attach to the card's top and bottom handles. When the Group continues from a Condition's True or False outlet, the card's bottom handle keeps that outlet and is labelled True or False beneath it, the way the Condition's own card labels its outlets. While nothing leaves the Group, the card draws one bottom handle for each place a path ends inside it, spread along the edge: a Condition's unconnected outlet is labelled True or False, and a step that connects to nothing is labelled with the step's name, as its own card titles it, when the card draws more than one handle. Each handle sits at the centre of an equal share of the bottom edge, and its label is no wider than that share, so a long name truncates and the handle's accessible name carries it whole. Dragging from one of those handles adds one connection from that outlet alone, and afterwards the card draws only the handle the Group continues from. An outlet entering the Group at several steps draws one edge onto the card, and deleting that edge deletes the connection to each of those steps.

The focused Group canvas shows only the Group's members, as standard cards laid out in rows from the Group's interior edges, with those edges between them. A step where branches join sits in the row after its last branch, near the middle of the steps that feed it, and an edge that passes a row runs through a lane no card covers and turns across in the gap just before the step it reaches. Each Group stores a layout direction, **Top to bottom** or **Left to right**. Top to bottom stacks the rows downward with handles on the cards' top and bottom; Left to right runs the rows across with handles on the cards' left and right. The layout depends on the Group's steps, edges and direction alone, so moving the collapsed card never moves a member or the camera a person left on the Group. The Group card itself is not drawn. Each outside step that enters the Group is a dashed stub before the members reading "Incoming from" and the step's name, one per outlet it enters by, so a Condition entering by both branches draws two stubs with True and False on their edges. Each step the Group continues to is a dashed stub after them reading "Continues to" and the step's name. Each place a path ends inside the Group is a dashed stub on the same line reading "Path ends", with an edge from a step that connects to nothing, or from a Condition's unconnected True or False outlet, which then carries that branch label. The stubs on that line follow the order of the steps they leave across the flow, True before False, and each step with an edge to one of them keeps a lane clear through the rows below it. An outlet that enters the Group at several steps draws one stub with an edge to each of them. An edge between two members can be selected and deleted, and dragging from one member's outlet to another member adds one. An edge from an "Incoming from" stub can be selected and deleted on its own, and dragging from that stub onto another member adds one more edge from the same outside outlet. A Group is entered from one outside outlet, so a connection that would enter it from a second outlet is refused with a notice. A connection that would give a step inside the Group a branch from outside it, or put a Condition on a branch into a join, is refused with the notice Publish would give. Stubs cannot be selected or dragged, "Continues to" and "Path ends" stubs and their edges cannot be selected or connected, members cannot be dragged, and **Add Step**, **Paste**, **Duplicate**, and **Tidy layout** are not offered, so entering, leaving, or inspecting a Group never writes a coordinate. **Ungroup** places the steps in the same rows along the Group's direction, centred on the collapsed card, with the first row where the card was. A bar at the canvas's top left holds a **Workflow** button that returns to the overview, the workflow and Group names, and the step count.

Handles are 12px dots in Graphite Ink with a hairline ring, and their hit areas are 24px on desktop and 44px on touch. Those sizes are divided by `--rf-zoom`, the live canvas scale the viewport transform applies, because a flat pixel size inside that transform shrinks with the zoom and delivered 24.6px on a phone.

Edges leave the bottom handle, travel in a rounded orthogonal step, and enter the top handle of the next node. The dash is the wire, 2px of Canvas Line marching while live and Graphite Ink when selected; a label sits on the horizontal span when the outlet has a name. An edge landing where the run cannot go widens its dash gap and stops marching, keeping a legible stroke rather than fading toward the background.

A step the run can never reach is muted: the card drops to 50% opacity, its incoming edge takes Canvas Line Muted and a wider dash gap, and that edge stops animating, so a dead region reads as still while a live one moves. Two things put a step out of reach, and both wear this: a Canceled subtree while no Cancel Event is declared, which also labels the outlet, and everything below a disabled step, since disabling one ends its branch. A disabled step wears its own face instead, 50% opacity with an eye badge, which is what separates the step a person switched off from the steps that lost their path because of it. A Group frame has no enabled state and never wears the disabled face; each member wears its own.

### Navigation

A quiet menu bar spans the canvas. Canvas Reveal, a Panel-toned inspector
floating over the canvas, shows details for the active workspace view. The
selected workspace uses a Graphite Ink fill with Paper text. Tone, rather than an
accent stripe, marks the active workflow.

The workflow workspace has three views: **Draft**, **Runs**, and **Changes**. A
segmented control precedes the Run split button and **Publish** at desktop
widths. Below `md` the three views sit at the top of the toolbar's overflow
menu, the active one checked, above the run commands and **Publish**. The control
remains available when the inspector is closed. The canvas,
inspector, editing lock, and status strip always follow the same active view.
When a resolved view changes, the canvas keeps its zoom and anchors the Lifecycle
card at the top center when the full graph fits. A graph that would clip is
centered at the preserved zoom. Loading changes inspector status without fading,
re-fitting, or replacing the last valid canvas; resolved content replaces it
only when the next presentation is ready.

**Draft** owns the editable workflow and its properties. **Runs** resolves its
initial load directly to the newest run, and owns the run list, run details, and
run-node inspection. **Changes** owns publication review, comparison properties,
and version history. Entering **Runs** or **Changes** opens the inspector.
Closing the inspector doesn't change the active view.

Canvas Reveal has three levels: Closed, Browse, and Focus. It floats 8px inside
the canvas box's top, right, and bottom edges with a hairline border and
shadow-sm, and it never resizes the canvas. Its width is fixed per level and
canvas width, and no control resizes it:

| Canvas width     | Browse | Focus       | Lifecycle Focus      |
| ---------------- | ------ | ----------- | -------------------- |
| Under 1024px     | 320px  | Up to 640px | The canvas less 16px |
| 1024px to 1279px | 360px  | 640px       | Up to 840px          |
| 1280px to 1535px | 380px  | 720px       | 920px                |
| 1536px and wider | 400px  | 800px       | 1000px               |

Under 1024px, Focus is 640px or the canvas less 16px, whichever is narrower,
so a window between 768px and 1023px keeps part of the canvas visible beside
it. From 1024px up, Focus and its 8px inset always leave at least 256px of canvas, so a
Lifecycle Focus on a canvas narrower than 1104px is narrower than 840px.

The Draft canvas rests with Reveal closed. Selecting an ordinary step, which is
any Action or Wait, opens Browse. A context header names the workspace, the step,
the path from the workflow through any Group to the step, and the step's
validation status, beside **Back**, **Focus editor**, and **Close**. Browse is a
summary: an editable label, the action and its Connection, each setting as a
label and value with "Not set" for a missing one, and the step's issues, each of
which opens Focus on the field it names. Focus holds the complete form, and
**Return to summary** goes back to Browse. Edits write to the draft as they are
made, so changing level loses nothing and autosave carries on. A step with no
action chosen shows the action picker in Browse and has no Focus. Selecting a
collapsed Group opens its summary in Browse: the step count, the **Layout**
choice between **Top to bottom** and **Left to right**, each step, the outside
steps that enter it, the step it continues from with the Condition branch when
it leaves by one, the steps it continues to, its issues, and **Enter
group**. Changing the layout is one undo step that saves. Focus holds the Group's label, description, the **Layout** choice, each step, **Enter group**,
**Ungroup**, and **Delete Group and Steps**. In Browse and Focus, each step is
listed with its issue count and opens that step inside the Group: the Group is
entered and the step is selected. The collapsed card hides the Group's steps, so
the card's issue badge and the status in the Group's header count the steps'
issues with the Group's own. Double-clicking the card or its arrow also enters it.
Entering and leaving a Group each add a browser history entry, so Back leaves a
Group and Forward enters it again. On a focused Group canvas, selecting a step
opens that step's own inspector. A connection and a multiple selection show
their panel at Browse width, under a header holding the panel's title and
**Close**. **Runs** and **Changes** each have a Browse of their own, and
**Changes** is described under Publication review.

Selecting the Lifecycle node opens Browse with the workflow's lifecycle policy:
an editable label, the Start Events with each payload Start Filter, the
overlapping-run behavior and whether manual runs are allowed, the Cancel Events,
the tracked Entity with its binding in each Event, the eligibility rule and when
it is checked, and the validation issues. Start Filters and eligibility sit in
separate sections, and each says what it reads: the arriving Event's payload,
or the Entity's current state from the host. Each section's edit button opens
Focus on the matching section, and each issue opens the section that edits what
it names. Every Lifecycle Rules problem Publish refuses, including a Start or
Cancel Filter reading a path its Event does not declare, is a blocking issue.
Lifecycle Focus is wider: a section list beside one section at a time, for
Start Events, Overlapping runs, Cancel Events, Entity eligibility, Evaluation
checkpoints, Connections, and Validation. The list counts Start Events, Cancel
Events, and issues. A control that shows another section moves focus to that
section's entry in the list. The Lifecycle node shows no Delete.

A selected Condition opens the same header. Its Browse reads the decision: an
editable label, one sentence stating when the Condition takes True and which
AND or OR joins its rules or groups, each rule as a line of text, the steps its
True and False outlets continue to or a line saying a disconnected branch ends
the run, the first five values its rules can compare, and its issues. **Edit
rules** and each issue open Focus on the rule builder. Focus holds the label and
description, the rule builder open for editing, both branch destinations, every
available input, the issues, and the enable, Ungroup, and delete controls.
Placing a Condition sets the zoom from its card and both outlet handles, and
keeps each True and False label on its outgoing edges inside the usable canvas
too when the label fits at that zoom. A label on an edge to a distant step stays
off screen.

A selected Event Split opens the same header, with Browse only. Browse names the
Event source its outlets come from: the Lifecycle node's Start Events for a
split on the Started side, its Cancel Events for a split on the Canceled side,
or the Wait Subscriptions of the nearest event-mode Wait above it. It lists each
outlet with the Event's label, the raw Event name on a second line, and the step
its stored connection leads to, or a line saying a disconnected outlet ends the
run there. The primary action opens the source: **Open Lifecycle Start Events**
or **Open Lifecycle Cancel Events** selects the Lifecycle node and opens Focus
on that section, and **Open** followed by the Wait's name selects the Wait and
opens its Browse. The list also says when no Event source reaches the Event
Split, when an outlet's Event is no longer declared by the app, when a stored
connection names an Event that no longer reaches it, and when a connection
leaves by no outlet. Placing an Event Split sets the zoom from its card and its
outlet handles the same way a Condition does, keeping every outlet label that
still fits inside the usable canvas.

**Runs** has a Browse of its own and shows a run node's evidence in Focus. On
the run list the header path names the workflow and Runs, and **Refresh** and
**Clear All** sit above the superseded count, the Refused Starts, the
Cancellation Failures, and the run rows. Selecting a run adds a browser history
entry and puts the graph version the run pinned on the canvas. The header then
titles the run by its list number, shows its status, and offers **Back**.
Browse holds the run's start identity, outcome, timing, and entity, then its
active waits with **Resume now**, **Cancel**, exit details, the failure summary,
the node journey, and activity. **Back** and Escape on a run replace the history
entry with the run list and put focus on that run's row, or on the header title
when the list shows no row for it. A run past the newest 50, or one that leaves
the list, keeps its view and says why it is not listed. Each run list remembers
whether it shows superseded runs.

Selecting a node on a run's canvas, or its entry in the node journey, opens
Focus on that node's evidence. A journey entry for a Group member opens that
Group's view with the member selected. The header adds the node to the path and
shows the status of the execution on screen; **Show evidence** and **Return to
run** switch levels. An execution is one time the run reached the node, such as
a second pass through a branch run. Retries inside one execution leave no
separate record, so an execution shows their final outcome, and Focus says so.
Focus lists every execution of a node the run reached more than once, as
"Execution N of M", and choosing one changes neither the canvas selection, the
journey, nor the control that has focus. Each execution shows its status, start,
finish and duration, its error or cancellation, the wait it holds with **Resume
now**, the node's activity such as parking and resuming, its result, input and
output, and the node's configuration in the graph the run pinned. Notices say
when the node is no longer in that graph, when the graph is loading or could not
be loaded, when an execution never finished, and when the run is still in
progress and refreshing. A Group records nothing in a run, so a Group card has
no evidence. On a run's canvas the card shows the Group's run status and counts
of its steps, such as "3 of 5 steps reached, 1 failed", and never a percentage.
The status is Failed, Canceled, Waiting, or Running when any step is, in that
order. With no step reached it is Idle. A Group is Successful once a step it
continues to has evidence, or once the run completed with evidence at one of its
steps where a path ends inside it, such as a Condition branch with no step after
it. A Group with no step after it is also Successful once the run completed.
Otherwise it is Reached, and its border carries only Successful, Failed, and
Canceled. The card, its summary, and the step cards read one status per step,
so a step's chip and the Group's counts always agree. Selecting the card opens
its summary in Browse, titled by the Group, with the same status and counts and
each step with its own status. Choosing a step there enters the Group and opens
that step's evidence in Focus. **Back** and Escape from that evidence return to
Browse in the Group, then to the overview with the Group card selected and its
summary shown, then to the run with focus on the card, and then to the run
list. From evidence Focus opened on the overview they return to the run's
Browse at the journey position it was left at, with focus on the journey entry
or canvas node that opened Focus. A canvas click that opened Focus or a Group
summary from a closed Reveal returns straight to Closed, and that opening and
closing leave the saved open or closed preference as it was. A click
on the empty canvas clears the evidence. Selecting another node replaces the
evidence and shows its latest execution. The chosen execution is remembered for
each run. On a phone the evidence replaces the run overview in the sheet, and
its heading takes focus.

Escape and **Back** take one step back as the shown object's kind defines it.
For a step or Condition that step is one level: Focus to Browse to Closed. For a
run node's evidence it is the run, for a run it is the run list, and on the run
list Escape closes Reveal. For the Lifecycle node or a Wait opened from an Event
Split, the step back selects that Event Split again, and the camera moves only
if Reveal would cover it. The way back lasts while
Reveal stays open and the source stays selected alone; closing Reveal or
selecting anything else ends it, and Back then steps one level. **Close** closes
Reveal from any level. Escape belongs to an open select, combobox, menu,
autocomplete, or dialog first.
Opening Focus moves focus to the step title, returning to Browse puts focus on
**Focus editor**, and closing returns focus to the canvas object or control that
opened Browse. Closing keeps the canvas selection. Selecting a step again, or
the chevron on the canvas's right edge, reopens the level Reveal was closed
from. Cmd+B opens and closes Canvas Reveal. The level, the inspected step, the
inspector's scroll position, and the Lifecycle Focus section are remembered
separately for Draft, each Group view, the run list, each run, and each
comparison. Levels add no browser history.

Opening or changing Reveal moves the camera and nothing else: it never runs
layout, moves a node, or marks the draft changed. The camera keeps its zoom when
the selected step fits the usable canvas, the part left after Reveal, the canvas
controls, the MiniMap, and the docked agent card, and zooms out only as far as
fitting it needs. It then moves the least distance that keeps the step and 64px
of its neighbors inside the usable canvas, so a long horizontal or vertical workflow
keeps its direction. **Runs** and **Changes** place their selected node the same
way, or the whole graph when no single node is selected. The MiniMap sits beside
open Reveal. The camera moves once per change and only when Reveal would cover
the step or its 64px of neighbors: a step already in the usable canvas stays
where it is. Opening Reveal, selecting another step, and widening Browse to
Focus can each move it. Closing Reveal by any path (Close, Escape, Back,
clicking empty canvas, or clearing the selection) and returning from Focus to
Browse never move the camera.

Below `md`, Draft replaces Canvas Reveal with a sequence of sheets over the
full-screen canvas. Selecting a step, Condition, Lifecycle node, Event Split,
collapsed Group, or connection opens its summary sheet: the same Browse body,
over the bottom of the canvas, which stays pannable and zoomable above it. A
summary sheet that opens moves the camera once, the least it must, to keep its
subject above the sheet's top edge, and only when the sheet would cover it. The sheet's header names the object and its
validation status beside **Open editor**, for an object with a Focus body, and
**Close**. **Open editor**, an issue, and a Lifecycle section's edit button open
the full-screen inspector with the Focus body; the Lifecycle section list sits
above its section there. An Event Split's action opens the Lifecycle inspector
at its section, or the Wait's summary, over the Event Split's summary. Every
sheet above the first leads with a Back control named for the sheet beneath,
**Summary** when that sheet shows the same object. Back and Escape remove one
sheet and restore the sheet beneath with its selection and its scroll position.
The Canvas Reveal shortcut closes every sheet. Removing or closing sheets never
moves the camera. Each sheet moves focus to its title. Back returns focus to
the control that opened the removed sheet, or to the title of the sheet beneath
when that control is gone, and closing the last sheet returns focus to the
canvas node. The canvas and the agent panel under the inspector leave the tab
order. Every control inside the sequence, and every option of a select, combobox
or menu popup while the sequence shows, is at least 44px tall, text fields read
at 1rem, and the sheets clear the left and right safe-area insets. The sheets,
their scroll positions, and the Lifecycle section are remembered for each Draft
scope apart from desktop Reveal, and each form factor keeps its own camera.
While a sheet shows, the toolbar's **Configuration** button is absent. A phone
offers no topology authoring: nodes cannot be dragged, added, deleted, pasted,
duplicated, grouped, or ungrouped, connections cannot be drawn, the canvas has
no context menu, multi-select, delete keys, or Tidy layout control, and a
Group's layout direction is shown as text. Undo and redo stay available on a
phone, because restoring an earlier state of the workflow is not topology
authoring. **Runs** and **Changes** keep the configuration sheet below `md`,
and returning to Draft closes that sheet.

On a phone, a collapsed Group's summary sheet names the Group's stored layout
direction, and for a Left to right Group it also says "On a phone, a Group's
steps show top to bottom." **Enter group** opens the focused Group canvas, whose
**Workflow** button is 44px tall. A phone draws every focused Group top to
bottom, whatever direction the Group stores. That drawing changes nothing
stored: the Group's direction, every coordinate, and the saved draft stay as
they are, and a wider screen draws the stored direction with its own camera. A
handle on a phone, on a step or on a stub, starts no connection, and a touch on
it pans the canvas. Selecting a step on the focused canvas opens its summary
sheet, whose first control is a Back control named for the Group in place of
**Close**, and **Open editor** opens the step's full-screen inspector.
**Workflow** or browser Back returns to the overview with the Group's summary
sheet, its scroll position, the overview's camera, and focus on **Enter group**.
Browser Forward returns to the Group with its sheets, their scroll positions,
and the Group's camera.

A Panel-toned status strip closes the canvas column: 32px tall, Caption type, a
hairline top border, and one line that never wraps. While the draft is on
screen, the strip names the published version and carries **Published mode** one
divider from it, as a ghost menu button reading Live or Test behind a dot. The
dot is an outline for Live and a filled Signal Amber for Test. The setting sits
there because the badge beside it already names the version the mode governs.
The strip also identifies **Runs** and **Changes**, explains that editing is
off, and provides **Back to draft**. With a read-only view on the canvas, the
strip tints toward `--info`. Its height remains constant because the strip and
graph share the column height.

The 44px editor toolbar spans the full editor shell. Workflow navigation,
**Actions**, and **Settings** form the leading group. The 320px search control
stays centered in the shell and hides at 70rem or narrower; its keyboard
shortcut remains available. A compact **Find a node** control stays in the
trailing group while the search control is hidden. It sits between the two
groups in DOM order, so Tab reaches it in the position it appears. The workspace
control, the Run split button, and **Publish** form the trailing group, which
sticks to the shell's right edge so a scrolling row never carries a write control out of reach. The
split button's face is **Run draft**, which always sends to test recipients. Its
menu holds the run of the published version, labelled with that version number
and the Published mode. Below `md` the workspace control, both run commands and
**Publish** collapse into one overflow menu, each disabled for the reason its
desktop control is disabled. **Configuration** stays beside that menu as an icon
button, because Canvas Reveal is absent at that width. In Draft it opens the
selected object's summary sheet.

### Publication review

The toolbar shows **Changes** after the first publication. **Changes** compares
the selected published version with the exact draft that was visible when the
view opened. Its Canvas Reveal header names the comparison as "Version N →
proposed version M" and keeps that title while the comparison refreshes. Browse
holds **Refresh comparison**, **Version history**, and **Exit comparison**, and
counts changes under **Behavior** and **Organization**. Behavior counts the
added, modified, and removed steps whose execution changed and the changed
connections. Organization appears when Groups changed and counts the added,
modified, and removed Groups and the steps whose Group membership changed. A
Group's label, layout direction, creation, and removal, and a step's Group
membership, are Organization; a step's settings, its enabled state, and every
connection are Behavior. A comparison whose only changes are Organization shows
"Execution behavior is unchanged. Only how steps are organized in Groups
differs." in place of the Behavior counts. The list shows each changed Group,
then each changed step, then each changed connection with its marker and
change, and a step whose only change is its Group reads **Group membership**.
Choosing a row, **Previous**, or **Next** selects that object on the canvas and
places it. A collapsed Group card on the comparison canvas counts the changed
steps inside it, as "2 changed"; pressing that count enters the Group, selects
the first of those steps, and opens Browse when Reveal is closed.
Collapse, camera, Group depth, selection, Reveal state, and scroll never enter
a comparison.
The Publish confirmation shows the same Behavior and Organization counts, and
the same sentence for a version whose only changes are Organization.
While a different comparison is loading or has failed, Browse shows that state
and never the comparison it replaces, and the canvas shows the draft without
change markers until the comparison the route names arrives. Version history opens inside Browse with focus
on its heading. **Back to changes** or Escape returns to the list with its
selection and scroll, and focus on **Version history**; Escape from the list
closes Reveal. **Reset comparison layout** also hands focus to **Version
history**.

With one changed step or connection selected, on the canvas or from the list,
**Compare fields** opens a wide Focus for that object. Its path ends with the
object's title. A table lists each setting under readable names, with a column
for the published version ("Version N") and one for **Current draft**: both
columns for a modified step, the draft column alone for an added one, and the
published column alone for a removed one. A long value starts shortened with
its length and **Show full value**, and a value the server redacted or masked
reads "Hidden for security". A Lifecycle rule keyed by Event names that Event,
as "Start filter › Appointment booked", a Start or Cancel Filter reads as its
rules or "Filter changed" when it cannot be read, and a Connection reads as its
name or "Connection changed". Focus says so when a step's action is missing from
the catalog and its settings show general names, when the comparison lacks a
side's values, and when a step is unchanged and only its connections changed,
listing those connections. A changed Group lists its own settings, reads its
layout direction as "Top to bottom" or "Left to right", and lists the changed
steps inside it, each entering the Group to show that step. It says execution
behavior is unchanged when none of those steps changed behavior, and otherwise
says that the Group's own change does not affect execution. A step whose Group changed shows a **Group membership** table
naming each version's Group or "Not in a Group", and its sentence names the
Groups it moved between. A changed step also shows how the editor's issue
checks differ between the two versions, and says validation is unknown for a
version whose action is missing from the catalog. **Previous** and **Next** in Focus move the canvas selection and
Focus together, and a changed step inside a collapsed Group is selected on that
Group's focused canvas. Previous and Next replace the
route's history entry when they reach another scope. Back or Escape returns to
the change list in Browse with the list scroll Focus was entered with, the
selection, and the camera, and focus on the object's row, scrolled into view
when it is outside the list. Restore
always says "Restore version N as draft" and requires confirmation that the
published version remains unchanged.

Version history starts with **In use** when the viewer can inspect version
usage. Its count names versions, not runs: the current publication remains
listed even with no active runs, alongside every version an active run pins.
Each row keeps its active-run status visible, opens to its action ids, and marks
catalog drift as a warning without implying that a draft snapshot was published.

The **Migrate active runs** command sits in the **In use** section, because that
section is where a builder reads how many runs sit on older versions. The
toolbar's trailing group holds **Run** and **Publish**, the commands a builder
uses on every visit, and a Migration is a rare action taken after reading the
version usage it acts on.

Comparison marks nodes with `A`, `M`, or `D` in addition to signal color. Added
nodes use Signal Green, modified nodes use Signal Amber, and deleted nodes use
Signal Red. Deleted edges use a distinct dotted treatment. Node position,
dimensions, and measured geometry never create a change marker.

Below `md`, selecting a changed node opens comparison properties on the
configuration sheet. Modified nodes show published and draft values side by
side. Added nodes show draft values only. Deleted nodes show published values
only. Field labels come from the extension catalog; machine paths don't appear
as labels. Deleted nodes remain movable for comparison clarity, and **Reset
comparison layout**, offered only after one has moved, restores historical
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
