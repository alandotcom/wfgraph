---
"@wfgraph/plugins": patch
---

Fail a Resend send whose Tags or Template Variables box does not parse, rather than
sending the email without them. Tags are an output other nodes reference by key, so a
dropped box left every downstream `tags.order_id` reading nothing while the run reported
success. The three content modes now name the field a builder still has to fill in as the
form labels it: "Content Mode is HTML, so HTML Body must be filled in."
