import { describe, expect, it } from "vitest";
import {
  describeEval,
  describeFailingScores,
  scoreEvalRun,
} from "#src/eval/describe-eval";
import type { Harness, Judge } from "#src/eval/types";

type Output = { reply: string };

const echoHarness: Harness<string, Output> = {
  name: "echo",
  run: async (input, { setArtifact }) => {
    if (input === "throw") {
      throw new Error("harness exploded");
    }
    setArtifact("seen", input);
    return {
      output: { reply: input },
      events: [
        { type: "message", role: "user", content: input },
        { type: "message", role: "assistant", content: `said ${input}` },
      ],
      usage: {
        provider: "test",
        model: "echo",
        inputTokens: 1,
        outputTokens: 2,
        reasoningTokens: 0,
        totalTokens: 3,
        toolCalls: 0,
        metadata: {},
      },
      errors: [],
    };
  },
};

const repliesHello: Judge<string, Output> = {
  name: "RepliesHello",
  assess: ({ output }) =>
    output.reply === "hello"
      ? { score: 1, rationale: "Replied hello." }
      : { score: 0, rationale: "Did not reply hello." },
};

const neverSatisfied: Judge<string, Output> = {
  name: "NeverSatisfied",
  assess: () => ({ score: 0.25, rationale: "Advisory only." }),
};

describe("scoreEvalRun", () => {
  it("scores gating judges ahead of advisory ones and marks each", () => {
    const scores = scoreEvalRun(
      { judges: [repliesHello], advisoryJudges: [neverSatisfied] },
      { input: "hello", output: { reply: "hello" } }
    );

    expect(scores).toEqual([
      {
        judge: "RepliesHello",
        gating: true,
        score: 1,
        rationale: "Replied hello.",
      },
      {
        judge: "NeverSatisfied",
        gating: false,
        score: 0.25,
        rationale: "Advisory only.",
      },
    ]);
  });
});

describe("describeFailingScores", () => {
  it("passes a case whose only low score is advisory", () => {
    const scores = scoreEvalRun(
      { judges: [repliesHello], advisoryJudges: [neverSatisfied] },
      { input: "hello", output: { reply: "hello" } }
    );

    expect(describeFailingScores(scores, [])).toBeUndefined();
  });

  it("names each failing gating judge, its rationale and the final reply", () => {
    const scores = scoreEvalRun(
      { judges: [repliesHello] },
      { input: "bye", output: { reply: "bye" } }
    );

    const message = describeFailingScores(scores, [
      { type: "message", role: "assistant", content: "first" },
      { type: "message", role: "assistant", content: "last" },
    ]);

    expect(message).toContain("1 of 1 gating judges scored below 1.");
    expect(message).toContain("RepliesHello [0.00]: Did not reply hello.");
    expect(message).toContain("Final reply: last");
  });
});

describeEval(
  "describeEval",
  {
    harness: echoHarness,
    judges: [repliesHello],
    advisoryJudges: [neverSatisfied],
  },
  (evalCase) => {
    evalCase(
      "records the run, its scores and its artifacts on the task",
      async ({ run, task }) => {
        const result = await run("hello");

        expect(result.output).toEqual({ reply: "hello" });
        expect(task.meta.eval).toMatchObject({
          harness: "echo",
          output: { reply: "hello" },
          artifacts: { seen: "hello" },
          usage: { model: "echo", totalTokens: 3 },
          errors: [],
        });
        expect(task.meta.eval?.scores.map((score) => score.judge)).toEqual([
          "RepliesHello",
          "NeverSatisfied",
        ]);
      }
    );

    evalCase(
      "fails the case when a gating judge scores below 1",
      async ({ run, task }) => {
        await expect(run("bye")).rejects.toThrow(
          "RepliesHello [0.00]: Did not reply hello."
        );
        expect(task.meta.eval?.output).toEqual({ reply: "bye" });
      }
    );

    evalCase(
      "records a harness failure and rethrows it",
      async ({ run, task }) => {
        await expect(run("throw")).rejects.toThrow("harness exploded");
        expect(task.meta.eval).toMatchObject({
          harness: "echo",
          scores: [],
          errors: ["harness exploded"],
        });
        expect(task.meta.eval?.output).toBeUndefined();
      }
    );
  }
);

describeEval(
  "describeEval with skip",
  { harness: echoHarness, judges: [repliesHello], skip: true },
  (evalCase) => {
    evalCase("never runs", () => {
      expect.unreachable("A skipped eval suite ran a case.");
    });
  }
);
