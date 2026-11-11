import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { validateAgentDraft } from "@wfgraph/core/backend/agent/publication-validation";
import { authoringScenarios } from "#src/agent/authoring-scenarios";
import { assessGraphGrounding } from "#src/agent/judges/graph";

function authoringScenario(name: string) {
  const found = authoringScenarios.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`The authoring scenario "${name}" is missing`);
  }
  return found.input;
}

describe("authoring scenarios", () => {
  it("start every edit from a graph the catalog grounds", () => {
    for (const { name, input } of authoringScenarios) {
      const assessment = assessGraphGrounding({
        document: {
          nodes: [...input.document.nodes],
          edges: [...input.document.edges],
        },
        catalog: input.catalog,
        integrations: input.integrations,
      });
      expect(assessment.score, `${name}: ${assessment.rationale}`).toBe(1);
    }
  });

  it("hands the large-graph case more than sixty steps, ready to publish", () => {
    const input = authoringScenario(
      "appends a step to a graph of sixty-four steps"
    );

    expect(input.document.nodes.length).toBeGreaterThan(60);
    expect(
      validateAgentDraft({
        document: input.document,
        catalog: input.catalog,
        integrations: input.integrations,
      })
    ).toMatchObject({ draftValid: true, publishBlockers: [] });
  });

  it("answers the run question from a workflow with no runs", async () => {
    const input = authoringScenario(
      "says a workflow has not run when asked why it failed"
    );
    const operations = input.operations;
    if (operations === undefined) {
      throw new Error("The run-question scenario supplies no operations");
    }

    expect(await Effect.runPromise(operations.listRuns({ limit: 10 }))).toEqual(
      { runs: [], total: 0 }
    );
  });
});
