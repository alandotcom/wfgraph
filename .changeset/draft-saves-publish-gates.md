---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

A draft always saves; an invalid graph never publishes.

`prepareGraphSave` refused a graph whose nodes were half-built, which is the
ordinary state of an editor session. The editor suppressed that 400 for
autosaves, so the canvas sat dirty with nothing said and a reload discarded the
work. The battery is split: the save asks only what has to be true of a graph in
a row (it parses, and its stored expressions are ones the compiler produced), and
the readiness half moves to `checkPublishReadiness` in `publish-checks.ts`.

Nothing loses a guard. No run reads the draft column — both start paths load the
published version row and refuse when there is none — and publish is the sole
writer of the event subscription index, so an Event cannot reach a draft either.
Publish is the one gate that makes a graph runnable, and it now runs required
fields, Events, Event Split outlets, template references, connections and the
unreachable-subtree check together. Draft saves also stop costing a query, since
nothing left in that path reads the catalog or the database.

In the editor, validation runs continuously against the graph rather than only
when Run is pressed (#2). Broken nodes wear a warning badge, the toolbar carries
an issue count that opens the existing issues list, and Publish opens that list
instead of spending a round trip on a refusal the canvas was already showing.
The connection-missing triangle each action card used to draw from its own
reading of the connection list is now one rule inside the shared collector, and
every caller normalises its nodes the same way, so the canvas and the pre-run
check cannot disagree about a node. Nothing is reported until the connection
list has actually arrived: an empty list is a real answer, and using it for
"not asked yet" would accuse every node that names a connection.

Save state is a word rather than a dot — "Saving", "Unsaved changes", "Saved",
"Save failed" — and closing or reloading the tab with an edit still in the
debounce window asks first. Both are owner-only: a viewer of a public workflow
can still nudge a node, and the refused save that follows would otherwise leave
them holding a dirty flag and a leave-prompt they could never clear.
