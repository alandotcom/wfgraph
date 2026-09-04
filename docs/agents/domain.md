# Domain docs

This file defines how engineering skills use the repository's domain documentation.

## Before exploring, read these

- `CONTEXT.md` at the repository root contains the glossary of domain terms.
- `docs/adr/` contains the architecture decisions. Read the ADRs that apply to your work.

If a domain documentation file is absent, proceed with the work. The `/domain-modeling` skill, reached through `/grill-with-docs` or `/improve-codebase-architecture`, creates domain documentation when the team resolves a term or decision.

## File structure

This is a single-context repository. One glossary and one ADR directory cover all
workspace packages.

```
/
├── CONTEXT.md
├── README.md              # short host entrypoint
├── docs/
│   ├── embedding.md       # mount, database, options, package exports
│   ├── events.md          # defineEvent
│   ├── integrations.md    # defineIntegration
│   ├── adr/
│   ├── agents/            # engineering-skill config, not host manuals
│   └── internal/          # session plans and product intent; not adopter docs
└── packages/
    ├── agent/
    ├── client/
    ├── core/
    ├── evals/
    ├── plugins/
    └── shared/
```

If packages diverge into separate domains, create a root `CONTEXT-MAP.md` that points
to one `CONTEXT.md` file per package. Store context-specific decisions in
`packages/<name>/docs/adr/`, and update this file with the new layout.

## Use the glossary's vocabulary

When your output names a domain concept in an issue title, proposal, hypothesis, or test name, use the term from `CONTEXT.md`.

If `CONTEXT.md` does not define a required concept, verify that the project uses the proposed term. Record a genuine vocabulary gap for `/domain-modeling`.

## Flag ADR conflicts

If your output contradicts an existing ADR, identify the conflict explicitly:

> _Contradicts ADR-0007's decision that Lifecycle Rules are defined per workflow. Reopen the decision because ..._
