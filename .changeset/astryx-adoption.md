---
"@wfgraph/client": minor
---

Adopt Astryx (`@astryxdesign/core`) as the editor's design system, coordinating its theme with the existing color-mode provider and flattening the condition builder's nested cards.

The client installs `@astryxdesign/core` (pinned 0.4.5) plus its StyleX peer and coordinates its theme with the editor's existing persisted color-mode state. The editor's visual identity ships as a custom built theme (`src/theme/wfgraph-theme.ts`, regenerate with `pnpm --filter @wfgraph/client run theme:build`), while Tailwind v4 stays for legacy UI and layout during the incremental shadcn/Base UI migration.

The Wait node's subscription panel and the Condition node's builder lose their concentric borders: one frame per panel section, hierarchy below it by fill and spacing (DESIGN.md, "The One-Frame Rule").
