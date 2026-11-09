---
"@wfgraph/core": minor
---

A template may now name only a node upstream of the node holding it. Publish and a draft run refuse a workflow whose template names any other node, such as a node on a parallel branch, because whether that node had run when the template resolved depended on which branch finished first, and the action could receive the template text in place of the value. The editor marks the node that holds such a template, and the build agent reports it as a publish blocker. A node behind the Canceled outlet can still read a node behind the Started outlet.
