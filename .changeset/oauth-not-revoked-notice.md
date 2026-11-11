---
"@wfgraph/client": patch
---

Deleting an OAuth connection whose grant the provider did not revoke now shows a notice that stays until dismissed, telling the admin to revoke the app's access in the provider's own settings. The editor used to report only "Connection deleted".
