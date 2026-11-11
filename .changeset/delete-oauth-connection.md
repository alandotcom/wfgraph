---
"@wfgraph/core": patch
---

Deleting a connection that holds an OAuth grant now always removes it. Workflow Graph still asks the provider to revoke the grant first, and the `integration.delete` answer carries `oauthRevocation: "revoked"` or `"not_revoked"`. A delete used to fail on every try when the provider refused revocation, when `publicUrl` was unset, when the integration no longer declared `oauth`, when the stored grant was unreadable, or when the connection needed reauthorization. `not_revoked` is also logged as a warning with its reason, so an operator can revoke the grant at the provider. A refresh owner that stopped answering no longer blocks a delete: past the staleness bound the connection is fenced for reauthorization and then deleted.
