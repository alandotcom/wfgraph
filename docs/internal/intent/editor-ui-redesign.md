# Intent: redesign the editor UI

Confirmed with Alan on 2026-08-21, at commit `98c5ef7f`. This records what the work is
for. A plan for how to build it is downstream and does not live here.

Read this before `/tmp/handoff-*.md` from the same day. That handoff predates the
decisions below and contradicts two of them.

## Outcome

An editor where nothing has to be guessed at. The chrome states plainly what the workflow
is doing and names its own controls. Configuring a node has room to work in.

## Who it is for

A tech-savvy operations person, working alongside the developer who embedded Workflow
Graph. The developer does the mounting and writes the actions; the ops person builds the
workflows. Advanced features are all present and stay quiet until asked for.

## Why now

Alan opens the editor and cannot always tell what something means. The controls are nine
unlabeled icon buttons in a bar floating over the graph, and the workflow's state is
assembled from chips scattered across four corners. Redoing the UI is the moment to change
structure and layout together.

## Success

Someone opens a workflow and knows its state without hovering anything. They configure a
node carrying a stack of conditions without fighting a 380px panel.

## Constraints

The canvas barely changes. Node geometry, the graph itself, and the neutral Geist visual
language in `packages/client/src/routes/globals.css` all stay as they are.

Each screen lands whole in the new language. A screen holding two design languages at once
looks worse than a screen in either one, so the unit of work is a screen rather than a
component.

## Out of scope

**Run and debug.** It keeps working exactly as it does today. Build and debug are two
different jobs that currently share one screen, and separating them is its own project.
That project decides what a run view shows and where it lives.

**The sophisticated dashboard.** Faceted run history, filters, labels, tags, and grouping
belong with the run and debug work.

**Node configuration wording and content.** Already in decent shape. What changes is the
container it sits in, not the fields or their language.

## Decisions taken

**shadcn on Base UI is the component library.** It is what `packages/client/src/components/ui`
already holds, and shadcn made Base UI its default in July 2026, so the CLI serves Base UI
components directly. Astryx was adopted in #139 and reverted in #141: it would have added
StyleX as a third styling system to a cascade that already needs 29 `!important` rules to
hold React Flow down, and its Tailwind token bridge conflicts with the `primary`,
`secondary`, and `accent` names this repo already uses.

**Configuration takes most of the screen.** A selected node opens a surface large enough to
work in, carrying a way to reach the next node without dismissing it. Nothing selected
means the canvas runs full-bleed. The alternative considered and rejected was keeping
today's side panel and widening it, which leaves the surface too narrow to configure in and
the canvas too compressed to be useful.

**The shell is inset.** The app sits inside a margin with rounded corners over a darker
page.

**The dashboard gets a first pass in this project.** Same content it shows today, rendered
in the new language, with a faceted data table and some indication in each row of how far
an in-progress run has got. Many runs sit waiting for their next step, and a row that says
only "running" does not distinguish them. The editor goes first.

**⌘K opens a command palette that adds a node and picks its type.** Adding a step is the
most common action in the editor, so the palette earns its place by doing that rather than
by listing commands.

## Corrections to the earlier handoff

Two claims in `/tmp/handoff-20260821-200423.md` are wrong and should not be carried
forward:

- It says a modal for node configuration was "decided deliberately" against. That
  conversation never happened.
- Its entire tooling section assumes Astryx. Astryx is out.
