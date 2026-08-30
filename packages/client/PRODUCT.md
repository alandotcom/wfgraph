# Product

## Register

product

## Platform

web

## Users

Developers first: engineers who adopt Workflow Graph, embed `@wfgraph/core` and the editor in their own stack, and build or debug workflows in it. Once embedded, their less-technical teammates use the same editor to wire up automations. The developer is the primary audience and sets the bar; the ops teammate must still be able to read a workflow at a glance and edit one safely.

## Product Purpose

Workflow Graph is a general workflow automation platform: a node-based visual editor over a typed, plugin-driven execution engine (Hono API, Postgres, Inngest). Users compose a Lifecycle Node, steps, and conditions on a canvas, connect integrations (Slack, Twilio, Resend, Linear, Clerk), and watch runs execute with logs and history. Success in the near term is production use at Fountain, with real workflows running reliably.

## Positioning

Own your automation: a self-hosted, typed, plugin-driven workflow platform you run on your own infrastructure against your own database.

## Brand Personality

Precise, calm, technical. An instrument for people who know what they're doing. The editor should feel like Linear or the Vercel dashboard: quiet surfaces, sharp typography, restrained monochrome with color reserved for state and status. Confidence comes from responsiveness and legibility rather than decoration.

## Anti-references

The colorful automation-canvas look of Zapier or n8n, where every node type shouts its integration branding. Also the SaaS-generic default: gradient accents, cream-tinted backgrounds, identical card grids. Workflow Graph reads as a tool, closer to an IDE than a marketing site.

## Design Principles

1. **The canvas is the product.** Chrome stays out of the way; the workflow graph gets the space, the contrast, and the motion budget.
2. **State is always visible.** A run's status, a node's configuration health, and unsaved changes surface where the eye already is; users never wonder what the system is doing.
3. **Color means something.** The palette stays monochrome; when color appears it encodes status (success, failure, running, warning), integration identity, or selection, and only that.
4. **Fast is a feature.** Interactions respond immediately: optimistic saves, instant panel transitions, polling that never blocks the user.
5. **Legible to the second audience.** Every screen a developer builds must remain readable to the ops teammate: plain-language labels, visible structure, safe defaults.

The 2026-08-21 editor chrome redesign intent is
`docs/internal/intent/editor-ui-redesign.md`. This file stays the vocabulary home.

## Accessibility & Inclusion

WCAG 2.1 AA. Body text at 4.5:1 contrast minimum in both themes, visible focus indicators, keyboard-operable controls, and reduced-motion alternatives for every animation. The React Flow canvas gets best-effort keyboard support within AA's practical limits.
