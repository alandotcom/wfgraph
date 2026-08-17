---
"@wfgraph/client": patch
---

Drop `react-grab`. It was a dependency of the published editor for the sake of
one development-only dynamic import, so every adopter installed it to run code
that a production build never reaches.
