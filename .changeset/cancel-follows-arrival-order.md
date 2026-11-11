---
"@wfgraph/core": patch
---

A Cancel Event now follows the order Events were received in, whatever order the worker loop delivers them in. A start delivered after a Cancel Event received later opens its run already claimed for the Canceled outlet, and a Cancel Event no longer cancels a run whose start Event was received after it. On PostgreSQL a start and a Cancel of one Entity delivered at once by two processes no longer miss each other. Runs a person or a schedule started are canceled as before. Run the new PostgreSQL migration (`@wfgraph/core/migrate`) before deploying; SQLite migrates on open.
