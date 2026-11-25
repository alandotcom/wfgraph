---
"@wfgraph/plugins": patch
---

The Linear integration calls Linear's GraphQL API directly, and `@linear/sdk` is no longer a dependency of `@wfgraph/plugins`. Its calls now share the timeout and retry rules every other built-in integration uses: a read that Linear rate limits is retried, and creating an issue is sent once. Find Issues reads each issue's workflow state and assignee in the same request as the issue.
