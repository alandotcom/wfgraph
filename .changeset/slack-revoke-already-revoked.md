---
"@wfgraph/plugins": patch
---

Disconnecting or deleting a Slack OAuth connection now succeeds when Slack answers `apps.uninstall` with `invalid_auth`, `token_revoked` or `account_inactive`, which is what Slack says once a workspace has already uninstalled the app. Those answers used to fail the revocation, so the disconnect failed on every try.
