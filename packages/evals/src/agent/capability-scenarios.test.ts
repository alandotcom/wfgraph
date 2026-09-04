/**
 * Each capability scenario is solvable, and its expectations agree with each other.
 *
 * A reference solution is the graph the scenario is asking for, built by hand.
 * Holding it to the judges that read the finished document proves two things no
 * model run can prove cheaply: the task can be satisfied at all, and no two
 * expectations contradict. A scenario that fails here is a broken scenario, not
 * a weak agent, which is the distinction a live run cannot make for you.
 *
 * The trajectory judges are absent on purpose. They score how the agent worked,
 * and a hand-built document has no trajectory to score.
 */

import { describe, expect, it } from "vitest";
import { capabilityScenarios } from "#src/agent/capability-scenarios";
import { assessGraphGrounding } from "#src/agent/judges/graph";
import { assessResolvableReferences } from "#src/agent/judges/resolvable-references";
import { assessScenarioSemantics } from "#src/agent/judges/semantics";

describe.each(capabilityScenarios)(
  "reference solution for $name",
  ({ input, reference }) => {
    it("satisfies every scenario expectation", () => {
      const assessment = assessScenarioSemantics(input, reference);
      // The rationale is the assertion message, so a failure names the
      // expectation that broke rather than only reporting a zero.
      expect(assessment.score, assessment.rationale).toBe(1);
    });

    it("names only actions, Events and connections the catalog holds", () => {
      const assessment = assessGraphGrounding({
        document: reference,
        catalog: input.catalog,
        integrations: input.integrations,
      });
      expect(assessment.score, assessment.rationale).toBe(1);
    });

    it("reads only paths its own steps can address", () => {
      const assessment = assessResolvableReferences({
        document: reference,
        catalog: input.catalog,
      });
      expect(assessment.score, assessment.rationale).toBe(1);
    });
  }
);
