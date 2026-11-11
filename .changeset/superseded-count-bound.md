---
"@wfgraph/core": patch
"@wfgraph/client": patch
---

The Runs view's count of superseded runs now stops at 1,001, and the panel reads a count above 1,000 as "More than 1,000 runs were superseded by newer starts". The count runs on every two-second poll, and it used to read every superseded run a newest-wins workflow had ever produced. On SQLite the count and the default run list now read partial indexes of their own, as they already did on PostgreSQL.
