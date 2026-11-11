---
"@wfgraph/plugins": patch
---

PostHog's `POSTHOG_HOST` must now be an `https:` URL with no user name or password. The Capture Event and Identify Person steps fail and the connection test answers an error for any other host, before any request carries the project key. A blank host still means US Cloud.
