---
"@wfgraph/client": minor
---

Give a node's configuration a view mode.

Each block of the Lifecycle Node's panel, and each condition builder, now reads
back as plain text and opens its controls on an Edit button that becomes Done.
A Start Event reads as its name and the path runs are correlated on. A condition
reads as one line per rule, with its group shown as a left rule with the rows
indented behind it and the and/or joiner sitting on the divider between groups.

A rule that is not finished, points at a field the graph no longer offers, or
compares against a value its field no longer names says so on its own line, so
reading a configuration back tells you as much as opening it does.

The explanatory paragraphs that ran between the controls, including
Concurrency's three option descriptions, moved into a help popover beside each
block's label. It opens on a click, with the option in force listed first.

The Condition node's builder is now headed "Continue when".

With nothing selected the panel shows an empty state. Everything it used to
offer about the workflow itself lives in the menu beside the workflow's name,
which gains a Clear workflow item.
