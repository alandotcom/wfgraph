---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

Disconnecting OAuth now removes a connection the grant supplied on its own. Previously the row was kept with the grant stripped out, which left a connection holding no credential at all: it stayed in the node's connection picker, drew a check when a node selected it, and failed only at run time. A connection carrying a credential the operator entered themselves is still kept, which is the case the disconnect-as-escape-hatch exists for.

`integration.disconnectOAuth` answers `removed` alongside `success`, saying which of the two happened. The editor closes the dialog and repairs the nodes that named the connection when it is gone, taking the same path a delete takes.

Disconnecting confirms before it acts, and the confirmation says which of the two outcomes applies: it names the connection being removed when the grant is its only credential, and says the credentials the operator entered themselves survive when they do. Revoking the grant at the provider cannot be undone from the editor, so the click that starts it is no longer the click that does it.
