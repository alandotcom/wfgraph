---
timestamp: 2026-07-28T06-08-18Z
slug: src-components-workflow-config-trigger-config-tsx
---

# Critique: Trigger & Webhook Configuration UX

Method: dual-agent (A: design review agent · B: detector agent)

## Design Health Score

| #         | Heuristic                       | Score     | Key Issue                                                                                        |
| --------- | ------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| 1         | Visibility of System Status     | 2         | Typing a sample payload silently rewrites both schemas; no confirmation the trigger ever works   |
| 2         | Match System / Real World       | 2         | Three names for Event Type, three for Correlation Key, in one panel                              |
| 3         | User Control and Freedom        | 1         | Routing section header is a dead control whenever warnings exist; no undo for schema destruction |
| 4         | Consistency and Standards       | 2         | "Wait for webhook event" renders under the heading "Event-Based Wait"; Replace defined two ways  |
| 5         | Error Prevention                | 2         | Good domain checks, but the data.id default manufactures a warning on an untouched field         |
| 6         | Recognition Rather Than Recall  | 2         | Action meanings hidden inside a closed dropdown; Wait chips governed by a table in another node  |
| 7         | Flexibility and Efficiency      | 3         | Presets, inference, dual editing; docked for Monaco options passed to a plain textarea           |
| 8         | Aesthetic and Minimalist Design | 2         | Six sections for one trigger; Output Schema styled as a peer of Request Schema                   |
| 9         | Error Recovery                  | 3         | Warnings name the path and the remedy; badge lacks an accessible name                            |
| 10        | Help and Documentation          | 2         | Microcopy is all there is; nothing explains webhooks to the ops teammate                         |
| **Total** |                                 | **21/40** | Competent structure, vocabulary and destructive-write problems                                   |

## Anti-Patterns Verdict

LLM assessment: visually clean (no gradients, glass, or colored chrome; amber only for warnings). Editorial tells: six near-identical imperative section subtitles, Request/Output Schema template symmetry despite unequal importance, three uppercase tracked eyebrows that DESIGN.md bans.

Deterministic scan: 6 findings (exit 2), all design-system-font-size advisories — text-[10px]/text-[11px] off the 16/14/13 ramp (trigger-config x3, wait-event-select x2, routing-policy-editor x1). The detector's color rule cannot see Tailwind palette classes and its allow-list loaded empty, so amber was never adjudicated; there is no warning token in the system. The repo-root detector run false-cleaned (design system lives in packages/client). Browser overlays skipped: no listener on :4017.

## Priority Issues

- [P0] Sample payload edits silently destroy both schemas (payload onChange + presets spread webhookSchemaPatchFromSamplePayload on every valid-JSON keystroke; field descriptions unrecoverable). Fix: auto-write only when schema is empty; otherwise explicit "Sync schema from payload".
- [P0] Routing Policy header is dead on every fresh trigger (open OR-ed with configWarnings.length > 0). Fix: user choice wins once made.
- [P1] Request Schema silently overwrites Output Schema while the UI presents them as peers. Fix: subordinate Output Schema as an explicit disclosure with a persistent reset note.
- [P1] Three names for Event Type, three for Correlation Key, two definitions of Replace. Fix: render CONTEXT.md glossary terms verbatim everywhere.
- [P1] Wait picker depends on the trigger's policy table with no route to it. Fix: "Open trigger" button + mapped-action suffixes on chips.
- [P2] "Wait for webhook event" renders under "Event-Based Wait"; cold-start warnings fire before any work; webhook URL field disabled instead of readOnly.

## Persona Red Flags

Screen-reader: all seven CodeEditor instances unlabeled (component accepts no id); amber badge is an unqualified number; Wait chips lack group semantics; URL field out of tab order; action-config.tsx:1113 icon-only button unlabeled.
Ops teammate: three failures shown on a fresh node; jargon-dense questions; action verbs without visible meanings; no confirmation the trigger works.
Power developer: Monaco options ignored by textarea; path pickers discard type annotations; no curl example; chip selection nearly invisible.

## Minor Observations

Policy row truncation (hover-only recovery); bg-blue-500 resize handle violates the Signal Rule; three banned eyebrows; Behavior Summary static instead of evaluating the sample payload; duplicate-draft warning doesn't mark the colliding row; presets all appointment.* (Fountain-specific).

## Questions to Consider

1. What if "paste a payload or send one" were step one and the schema a consequence rather than a prerequisite?
2. Is Routing Policy four verbs, or two questions (begin work? end work in flight?) — two checkboxes per row would expose the policy at a glance.
3. Could a webhook trigger receive a declared vocabulary like custom triggers do, collapsing the webhook branch into the custom one?
