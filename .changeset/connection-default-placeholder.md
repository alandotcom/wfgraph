---
"@wfgraph/shared": minor
"@wfgraph/plugins": minor
"@wfgraph/client": minor
"@wfgraph/core": minor
---

Show a connection's stored value as the placeholder for the config field that falls back to it. Resend's From, and Twilio's From Number and Messaging Service SID, are optional on the node and the handler reads the connection when they are blank; the editor now says which value that is instead of drawing a generic example.

An action config field declares the fallback with `connectionDefaultKey`, naming one of the integration's own credentials, held to that set by the type. `checkIntegration` refuses a key the integration does not declare and refuses a `password` one, since the browser holds a mask in place of a secret. That declaration is also the allowlist for the new `connectionDefaults` on a connection summary: a stored value no field names never reaches the editor.

Also fixes a template field redrawing only when its text changed, which left a stale placeholder on screen after the value behind it moved.
