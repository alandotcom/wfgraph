# Plan: capture build agent turns as eval material

Not approved and not scheduled. Written on 2026-09-04 against commit `03ab9485`
on branch `agent-quality/mcp-adapter`, after an eval audit found that every
scenario in `packages/evals` is authored from `CONTEXT.md` rather than taken
from a turn anyone ran.

## Why

The audit's finding was that the suite measures the failure modes its authors
imagined. The session that produced it is the evidence: the four capability
scenarios are the only ones derived from an observed failure, and they found a
defect in reference resolution that twenty-six invented scenarios had never
touched, in a subsystem those scenarios exercise on every run.

The same audit found the one model-backed judge could not be validated, because
validating a judge means measuring how often it agrees with a person, and no
turn in this repository has ever carried a person's verdict. That judge was
deleted rather than left running unmeasured. Nothing here can be re-added until
this plan, or something like it, exists.

## Goal

Let a Workflow Builder mark a Turn as good or bad in the chat panel, keep the
Turn that was marked, and make a kept Turn convertible into an eval scenario.

## What a thumb is, and what it is not

A thumbs-down says a Turn was wrong. It does not say what was wrong, and the
failure mode is the part a judge is measured against. So the verdict decides
which Turns are worth reading, and the label comes from reading them.

That ordering is not a limitation to design around. Naming failure categories
in the widget requires knowing what the categories are, which is the output of
reviewing captured Turns rather than an input to capture. A first version that
records a verdict and nothing else is therefore complete, not a stub.

## Actors and state owners

| Actor            | Calls              | State read or written                | Observable result                    |
| ---------------- | ------------------ | ------------------------------------ | ------------------------------------ |
| Workflow Builder | The chat panel     | The verdict on one Turn              | The mark stays on that Turn          |
| Host             | `createWfGraphApp` | Whether capture is on at all         | Turns are kept, or none are          |
| Reviewer         | Reads kept Turns   | The failure label on a kept Turn     | A labelled set a judge is scored on  |
| Eval author      | `packages/evals`   | A kept Turn read as `AgentEvalInput` | A scenario grown rather than written |

## What already exists

Most of the recording half is built. A Turn produces the Draft Document it
started from, every tool call it made, the Draft Document it handed back, and
its final answer. `summarizeAgentTrace` in `backend/agent/trace.ts` already
walks that stream, and `packages/evals/src/agent/trajectory.ts` already
normalises it into the shape the judges read.

`AgentEvalInput` is `{ messages, document, catalog, integrations }`, which is
what a captured Turn holds. Converting one into a scenario is close to a
rename, and that is the whole payoff: the suite stops being authored and starts
being grown.

## What has to be decided first

**The name.** `CONTEXT.md` has Turn and Draft Document. It has no word for a
Turn that was kept and carries a verdict. AGENTS.md is explicit that a second
object for a concept with a canonical representation is the thing to avoid, so
this name is settled in `CONTEXT.md` before any table exists.

**Whether it is on.** A kept Turn carries the host's catalog, the Workflow
Builder's own words, and the graph they are building. That is the host's data,
not this library's, so capture cannot default to on. It belongs beside
`agent.apiKey` as a host option, and an adopter who passes nothing keeps
nothing.

**Where it is kept.** The four aggregate repositories are the persistence seam
(ADR-0005), so a fifth aggregate is the shape this takes if it is stored at
all. Whether a library should own an eval corpus, rather than handing each Turn
to the host and letting them keep it, is the open architectural question and
the reason this plan is not approved.

## Sequence, once those are settled

1. Name the concept in `CONTEXT.md`.
2. Add the host option, off unless the host asks.
3. Record a verdict against a Turn, with the widget in the chat panel.
4. Read kept Turns back, enough to review them.
5. Convert one to a scenario, by hand, and see what the conversion actually
   needs. Automate nothing before that.

## Acceptance

A Turn a Workflow Builder marked can be read back, reviewed, labelled with a
failure mode, and turned into a scenario that runs. An adopter who did not ask
for capture stores nothing and sees no widget.
