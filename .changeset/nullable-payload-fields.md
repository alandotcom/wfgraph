---
"@wfgraph/core": minor
---

A payload field whose schema leaves the key optional now reaches the editor marked nullable, so the condition picker badges it and offers `is set` and `is not set` on that path. Only a field declared as null carried the mark before, which made `Schema.optionalKey` look like a value every run carries.

Resend's webhook Events are held to one rule read off its docs and the `resend-node` types: a key is required where both sources agree Resend always sends it. `broadcast_id`, `template_id` and `tags` are the keys an email payload can arrive without. Three schema gaps against the docs close with the same pass. `email.suppressed` now declares the suppression details Resend sends with that event. A bounce carries the receiving server's raw SMTP responses. The inbound `email.received` payload is described by its own type, the one Resend documents for a received email.
