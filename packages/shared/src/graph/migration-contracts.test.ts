import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  workflowMigrationInputSchema,
  workflowMigrationOutcomeSchema,
  workflowMigrationPreviewPayloadSchema,
} from "#src/graph/migration-contracts";
import { rejectUnknownKeys } from "#src/types/schema";

describe("workflow migration contracts", () => {
  it("accepts a preview report and rejects an unknown refusal reason", () => {
    const decode = Schema.decodeUnknownResult(
      workflowMigrationPreviewPayloadSchema,
      rejectUnknownKeys
    );
    const report = {
      targetVersionId: "version_2",
      targetVersionNumber: 2,
      eligible: [
        {
          executionId: "execution_1",
          fromVersionNumber: 1,
          parkedNodeIds: ["wait_1"],
        },
      ],
      refused: [],
      alreadyCurrentCount: 0,
    };

    expect(Result.isSuccess(decode(report))).toBe(true);
    expect(
      Result.isSuccess(
        decode({
          ...report,
          refused: [
            {
              executionId: "execution_2",
              fromVersionNumber: null,
              reason: "draft_run",
            },
          ],
        })
      )
    ).toBe(true);
    expect(
      Result.isFailure(
        decode({
          ...report,
          refused: [
            {
              executionId: "execution_2",
              fromVersionNumber: 1,
              reason: "not_requested_version",
            },
          ],
        })
      )
    ).toBe(true);
  });

  it("keeps a migrate outcome's fields to the status it carries", () => {
    const decode = Schema.decodeUnknownResult(
      workflowMigrationOutcomeSchema,
      rejectUnknownKeys
    );

    expect(
      Result.isSuccess(
        decode({
          executionId: "execution_1",
          status: "migrated",
          signaled: false,
        })
      )
    ).toBe(true);
    expect(
      Result.isSuccess(
        decode({
          executionId: "execution_1",
          status: "refused",
          reason: "not_requested_version",
        })
      )
    ).toBe(true);
    expect(
      Result.isSuccess(
        decode({ executionId: "execution_1", status: "already_current" })
      )
    ).toBe(true);
    expect(
      Result.isFailure(
        decode({ executionId: "execution_1", status: "migrated" })
      )
    ).toBe(true);
  });

  it("requires a target version on a migrate request", () => {
    const decode = Schema.decodeUnknownResult(
      workflowMigrationInputSchema,
      rejectUnknownKeys
    );

    expect(
      Result.isSuccess(
        decode({
          workflowId: "workflow_1",
          targetVersionId: "version_2",
          executionIds: ["execution_1"],
        })
      )
    ).toBe(true);
    expect(
      Result.isFailure(
        decode({ workflowId: "workflow_1", executionIds: ["execution_1"] })
      )
    ).toBe(true);
  });

  it("requires at least one run id without exposing a persistence batch limit", () => {
    const decode = Schema.decodeUnknownResult(
      workflowMigrationInputSchema,
      rejectUnknownKeys
    );
    const request = (count: number) => ({
      workflowId: "workflow_1",
      targetVersionId: "version_2",
      executionIds: Array.from(
        { length: count },
        (_, index) => `execution_${index}`
      ),
    });

    expect(Result.isFailure(decode(request(0)))).toBe(true);
    expect(Result.isSuccess(decode(request(501)))).toBe(true);
  });
});
