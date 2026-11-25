---
"@wfgraph/plugins": patch
---

The Clerk integration calls Clerk's Backend API directly, at API version 2026-08-20, and `@clerk/backend` is no longer a dependency of `@wfgraph/plugins`. Clerk calls now share the timeout and retry rules of the other built-in integrations: reads, updates and deletes are retried after a rate limit or an unavailable answer, and creating a user is sent once. Update User sends a changed name to `PATCH /v1/users/{user_id}` and metadata to `PUT /v1/users/{user_id}/metadata`, which replaces each metadata field it is given.
