---
"@wfgraph/core": patch
---

The page the OAuth callback serves when a connection cannot be completed is now sent as `text/html`. It was sent as `text/plain`, so the provider's popup showed the page's markup in place of the message and its Close button.
