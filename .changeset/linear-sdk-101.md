---
"@wfgraph/plugins": patch
---

The Linear integration now depends on `@linear/sdk` `^101.1.0`, up from `^99.0.0`. The breaking changes in Linear's 100 and 101 releases remove Salesforce and Jira settings inputs that the integration never sends, so its actions and connection test behave as before.
