---
"@wfgraph/client": patch
---

The Agent panel no longer loads images the build agent writes in its reply. A markdown image renders as its alt text, so an address the model was led to write by text injected into the workflow cannot send draft content to another origin when the reply is drawn.
