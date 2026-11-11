---
"@wfgraph/client": minor
---

The Agent panel keeps each workflow's conversation in the browser's `localStorage` and restores it when the editor opens that workflow again, so a reload or a trip to another workflow no longer loses it. A "New conversation" button in the panel header clears the thread and its stored copy. When storage is blocked or full, the panel keeps the thread in memory for the life of the page.
