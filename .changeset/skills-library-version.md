---
"@wfgraph/core": patch
"@wfgraph/plugins": patch
---

The published Agent Skills now declare `library_version` 4.1.1, the version they ship in. The 4.1.0 tarballs carried skills that still declared 3.1.1, so `intent stale` reported them as out of date against the installed package. The skill content is unchanged.
