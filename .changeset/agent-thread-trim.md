---
"@wfgraph/client": patch
---

A long build agent conversation no longer stops working at its hundredth message. The Agent panel now leaves the oldest messages out of a request once the thread passes the server's message, message-length or request-size limits, keeps the newest message, and says above the composer how many of the oldest messages the agent no longer sees.
