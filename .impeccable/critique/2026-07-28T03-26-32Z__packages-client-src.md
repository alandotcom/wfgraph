---
target: packages/client (workflow editor SPA)
total_score: 23
p0_count: 1
p1_count: 3
timestamp: 2026-07-28T03-26-32Z
slug: packages-client-src
---

Method: dual-agent (A: assessment-a · B: assessment-b)

## Design Health Score

| #         | Heuristic                       | Score     | Key Issue                                                                                                                |
| --------- | ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1         | Visibility of System Status     | 3         | Save-dot, spinners, 2s run polling, test-mode banner; node run status is border-color only                               |
| 2         | Match System / Real World       | 2         | Test mode defined with its own term; raw lowercase enum values leak as filter labels                                     |
| 3         | User Control and Freedom        | 3         | Undo/redo, Cmd+B, Cmd+Enter, confirms everywhere; no undo for workflow deletion                                          |
| 4         | Consistency and Standards       | 2         | Two empty-state vocabularies, two status palettes (emerald vs green), tabs are plain buttons, font-mono resolves to sans |
| 5         | Error Prevention                | 2         | Pre-flight validator is excellent; bulk-delete confirm is a neutral button that never names what it destroys             |
| 6         | Recognition Rather Than Recall  | 2         | Action descriptions truncate mid-word; list view drops icons; shortcuts documented nowhere                               |
| 7         | Flexibility and Efficiency      | 3         | Bulk ops, infinite paging, persisted prefs, resizable panel; held back by the broken checkbox                            |
| 8         | Aesthetic and Minimalist Design | 3         | Genuinely restrained; docked for the 8-button filter row and the three-facts header paragraph                            |
| 9         | Error Recovery                  | 2         | "Go to step" deep-linking is real recovery; per-step errors buried, no retry-from-step                                   |
| 10        | Help and Documentation          | 1         | No onboarding, no shortcut reference, no docs link, no dashboard empty-state guidance                                    |
| **Total** |                                 | **23/40** | **Acceptable: significant improvements needed before users are happy**                                                   |

## Anti-Patterns Verdict

Not slop, from both directions. The reviewer grepped the whole client against the slop-marker list and found two incidental hits (a `tracking-widest` shortcut label, one `backdrop-blur` placeholder); radius caps at 14px, chroma is truly reserved for status and integration identity, and dark mode measured 6.09:1 to 19.77:1. A Linear-fluent user would trust it on sight. The deterministic CLI scan agreed: exit 0, zero findings across 125 files, validated against a synthetic positive to prove the pipeline fires.

The in-page overlay (run on dashboard and editor) added seven findings: a 176-char/line dashboard paragraph and a flat 10/12/14/16px type ramp (both true positives that echo the review), `transition: height` inherited on body from broad `transition-all` (worth tightening), a cramped h-8 button and a "nested cards" hit on the Live/Test toggle (both judged false positives), and "only font used" resolving to the system fallback stack, which independently confirms the Geist finding. Where the reviewer and detector converge is exactly the typography layer.

The impression risk is not "AI made this" but "this is unfinished": the dashboard's selection checkboxes render as a 2px hairline.

## Overall Impression

The middle of the product is genuinely strong: a calm, disciplined editor with a pre-flight validator most commercial workflow tools lack. Both ends are weak. The dashboard greets users with bare "No workflows found" text, 21-character nanoids at equal weight to names, and a broken bulk-selection affordance; sessions also end there, so the weakest screen makes both the first and last impression. The single biggest opportunity is finishing the mechanics that the visual restraint promises: working checkboxes, visible run status, real fonts, destructive ceremony.

## What's Working

1. The pre-run validator (workflow-toolbar.tsx:559): collects broken template references, missing required fields, and missing integrations in one pass, distinguishes blocking from non-blocking, and deep-links each issue to the offending field.
2. Visual restraint that survives a grep: two slop markers in the entire client, and a token system that means what DESIGN.md says it means.
3. Polling discipline (workflow-runs.tsx:47): detail queries derive their interval from list status, so logs stop polling the instant a run finishes, with a comment explaining the design.

## Priority Issues

**[P0] Bulk selection is unusable: checkboxes render as a 2px hairline.**

- Why it matters: Base UI's `Checkbox.Root` renders an inline `<span>`, so `size-4` never applies (the Radix original was a button). Measured 2x19px, no visible focus ring, no accessible name on either dashboard checkbox. Pause/Resume/Delete Selected and select-all, the dashboard's core feature, hang off an invisible target an order of magnitude under the 24x24 AA minimum.
- Fix: add `inline-grid place-content-center` to the Root className in checkbox.tsx:12; add `aria-label="Select all workflows"` and per-row `aria-label={'Select ' + workflow.name}`.
- Suggested command: $impeccable polish

**[P1] Node run status is color-only.**

- Why it matters: success/error/cancelled are border colors (node.tsx:60), running is an animated border; no icon, text, or aria. Fails WCAG 1.4.1 on the product's centrepiece and contradicts the "state is always visible" principle; a colorblind user cannot separate succeeded from failed, a screen reader gets nothing.
- Fix: status chip in the node header (icon plus the word), status in the card's aria-label, border kept as reinforcement.
- Suggested command: $impeccable harden

**[P1] Both font tokens resolve to nothing; monospace is gone app-wide.**

- Why it matters: `--font-sans`/`--font-mono` map to Geist variables defined nowhere (globals.css:9). Verified live by both assessments: zero elements resolve to Geist, and `font-mono` computes to the sans fallback, so workflow IDs, template tokens, the code editor, and logs all render proportional and lose the "this is code" cue.
- Fix: self-host Geist and Geist Mono and define both variables in :root, or point the tokens at real stacks. The mono half matters more.
- Suggested command: $impeccable typeset

**[P1] Destructive confirmations use a neutral button and never name what they destroy.**

- Why it matters: AlertDialogAction has no destructive variant, so "permanently delete 5 workflows and all related runs" ends in the same calm black button as Create Workflow, and the dialog never lists which workflows. Alarming copy plus a calm button reads as carelessness exactly where trust matters, and there is no undo.
- Fix: variant prop on AlertDialogAction, destructive from every delete path; name the first three affected workflows plus "and N more"; require typing the count for bulk deletes above ~3.
- Suggested command: $impeccable harden

**[P2] The action picker truncates every description and hides icons in list view.**

- Why it matters: the highest-uncertainty decision (39+ actions, all groups expanded) gets one mid-word-truncated line and no logo in list view (action-grid.tsx:450).
- Fix: description on its own line with line-clamp-2, icons in list rows, non-System groups collapsed by default.
- Suggested command: $impeccable layout

**[P2] Mobile cannot reach row actions; the dashboard cannot reach Settings at all.**

- Why it matters: at 390px the table is 442px wide in a 340px container with the actions cell off-viewport, so a phone cannot pause or delete anything. Connections/API Keys/Theme live only in the editor toolbar, so a new user on the dashboard cannot add the connection they need before building.
- Fix: stack the table below `sm` with inline actions; add Settings and the UserMenu to the dashboard header.
- Suggested command: $impeccable adapt

## Persona Red Flags

**Alex (power user):** the broken checkbox removes his fastest path entirely. Cmd+Enter and Cmd+B exist but appear in no tooltip or menu ("Run Workflow", not "Run Workflow ⌘↵"). No shift-click range select; row actions hide behind a per-row "…" menu.

**Sam (screen reader / keyboard-only):** both dashboard checkboxes expose no accessible name and no visible focus. The create-workflow name field has no label and its placeholder never renders because the field ships pre-filled. Zero `role="tab"` in the document, so Properties/Runs and Workflow/Runs have no arrow-key navigation or aria-selected. The sidebar resize handle is a dead focus stop (tabIndex 0, mouse-only handler) and its collapse button is opacity-0 until hover. One aria-live region total (toasts); run transitions announce nothing.

**The ops teammate:** every row leads with a 21-char nanoid at equal weight to the name. "No real email or SMS is sent" appears only inside the editor, after test mode is already on. Filter labels are raw lowercase enums. Two condition branches both read "Action / Select an action". The loudest control on their landing page is saturated red Delete Selected, even while disabled.

## Minor Observations

- Two empty-state vocabularies: workflow-runs.tsx builds a proper one (dashed icon frame, guidance) while the dashboard ships bare sentences.
- Status colors are defined twice with different palettes (emerald/blue/amber/zinc on the dashboard, green/red/slate on canvas; 56 raw Tailwind palette references client-wide). One statusToken() helper would satisfy the Signal Rule.
- The Connections dialog shows a filter box above an empty list and makes "Done" primary over "Add Connection".
- handleGoToStep focuses via setTimeout(100) plus getElementById, racing the panel render.
- At 390px the React Flow control column overlaps the left node card.
- The dashboard header paragraph packs bulk management, paused semantics, and test-mode semantics into one 176-char/line block (the overlay's line-length hit).
- `transition-all` lands `transition: height` on body; scope transitions to the properties that animate.

## Questions to Consider

1. DESIGN.md says "the canvas is the product", yet the first screen is the one place with no canvas. What if each dashboard row were the workflow's actual graph thumbnail with last-run status painted on, instead of a name and a nanoid?
2. Live and Test are one click apart with identical visual weight, but one sends real email and SMS to real people. Does switching to Live deserve the same ceremony as Delete?
3. The pre-flight validator is the most sophisticated thing in the product. Why does it fire only on Run, rather than continuously painting broken nodes so the ops teammate sees the problem while reading?
