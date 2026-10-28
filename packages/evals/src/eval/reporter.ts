/**
 * Prints one block per eval case once the run ends: its judge scores, what the
 * run cost, the tools it called, and its final reply. Cases finish concurrently,
 * so the blocks are sorted by name rather than printed as each one lands.
 */
import { styleText } from "node:util";
import type { Reporter, TestCase, Vitest } from "vitest/node";
import { compareText } from "@wfgraph/shared/types/string";
import type { EvalCaseRecord, TranscriptEvent } from "#src/eval/types";

type ReportedCase = {
  name: string;
  state: "passed" | "failed" | "skipped" | "pending";
  record: EvalCaseRecord;
};

/** Tool names in call order, a run of one name collapsed to `name ×n`. */
function describeToolActivity(events: readonly TranscriptEvent[]): string {
  const calls = events.flatMap((event) => {
    if (event.type !== "tool_result") {
      return [];
    }
    return ["error" in event ? `${event.name} (refused)` : event.name];
  });
  const runs: Array<{ name: string; count: number }> = [];
  for (const name of calls) {
    const last = runs.at(-1);
    if (last?.name === name) {
      last.count += 1;
    } else {
      runs.push({ name, count: 1 });
    }
  }
  return runs
    .map((run) => (run.count > 1 ? `${run.name} ×${run.count}` : run.name))
    .join(", ");
}

/** The report block for one case, as the lines the terminal prints. */
export function formatEvalCase(reported: ReportedCase): string[] {
  const { record } = reported;
  const mark =
    reported.state === "passed"
      ? styleText("green", "✓")
      : styleText("red", "✗");
  const seconds = `${(record.durationMs / 1000).toFixed(1)}s`;
  const lines = [`${mark} ${reported.name} ${styleText("dim", seconds)}`];

  if (record.usage) {
    const { usage } = record;
    lines.push(
      `  ${usage.provider}/${usage.model}: ${usage.totalTokens} tokens (${usage.inputTokens} in, ${usage.outputTokens} out, ${usage.reasoningTokens} reasoning), ${usage.toolCalls} tool calls`
    );
  }
  for (const score of record.scores) {
    const label = score.gating ? score.judge : `${score.judge} (advisory)`;
    const value = score.score.toFixed(2);
    lines.push(
      `  ${score.score < 1 ? styleText("yellow", value) : value} ${label}`
    );
    if (score.score < 1) {
      lines.push(`       ${score.rationale}`);
    }
  }
  const tools = describeToolActivity(record.events);
  if (tools.length > 0) {
    lines.push(`  tools: ${tools}`);
  }
  for (const error of record.errors) {
    lines.push(`  ${styleText("red", "error:")} ${error}`);
  }
  const reply = record.events.findLast(
    (event) => event.type === "message" && event.role === "assistant"
  );
  if (reply?.type === "message") {
    lines.push(`  reply: ${reply.content.replaceAll("\n", "\n         ")}`);
  }
  return lines;
}

export class EvalReporter implements Reporter {
  private vitest: Vitest | undefined;
  private readonly cases: ReportedCase[] = [];

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
    this.cases.length = 0;
  }

  onTestCaseResult(testCase: TestCase): void {
    const record = testCase.meta().eval;
    if (record) {
      this.cases.push({
        name: testCase.fullName,
        state: testCase.result().state,
        record,
      });
    }
  }

  onTestRunEnd(): void {
    if (this.cases.length === 0) {
      return;
    }
    const blocks = this.cases
      .toSorted((left, right) => compareText(left.name, right.name))
      .map((reported) => formatEvalCase(reported).join("\n"));
    this.vitest?.logger.log(`\nEval cases\n\n${blocks.join("\n\n")}\n`);
  }
}
