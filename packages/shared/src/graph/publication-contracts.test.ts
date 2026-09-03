import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  workflowComparisonInputSchema,
  workflowComparisonPayloadSchema,
  workflowPublishInputSchema,
  workflowVersionHistoryInputSchema,
  workflowVersionUsageItemSchema,
} from "#src/graph/publication-contracts";
import { createSerializedWorkflowGraph } from "#src/graph/graph";
import { rejectUnknownKeys } from "#src/types/schema";

const emptyGraph = createSerializedWorkflowGraph({ nodes: [], edges: [] });

describe("workflow publication contracts", () => {
  it("accepts a bounded version-history page request", () => {
    const decode = Schema.decodeUnknownResult(
      workflowVersionHistoryInputSchema,
      rejectUnknownKeys
    );

    expect(
      Result.isSuccess(
        decode({
          workflowId: "workflow_1",
          limit: 50,
          cursor: { version: 12 },
        })
      )
    ).toBe(true);
    expect(
      Result.isFailure(decode({ workflowId: "workflow_1", limit: 101 }))
    ).toBe(true);
  });

  it("keeps version numbers consistent with the version kind", () => {
    const decode = Schema.decodeUnknownResult(
      workflowVersionUsageItemSchema,
      rejectUnknownKeys
    );
    const item = {
      id: "version_1",
      publishedAt: "2026-08-23T12:00:00.000Z",
      isCurrent: true,
      activeRunCount: 0,
      oldestActiveRunAt: null,
      actionIds: [],
      missingActionIds: [],
      catalogMatches: true,
    };

    expect(
      Result.isSuccess(decode({ ...item, kind: "published", version: 1 }))
    ).toBe(true);
    expect(
      Result.isSuccess(
        decode({ ...item, kind: "draft_snapshot", version: null })
      )
    ).toBe(true);
    expect(
      Result.isFailure(decode({ ...item, kind: "published", version: null }))
    ).toBe(true);
    expect(
      Result.isFailure(decode({ ...item, kind: "draft_snapshot", version: 1 }))
    ).toBe(true);
  });

  it("requires the reviewed publication pointer when publishing", () => {
    const decode = Schema.decodeUnknownResult(
      workflowPublishInputSchema,
      rejectUnknownKeys
    );

    expect(
      Result.isFailure(decode({ workflowId: "workflow_1", graph: emptyGraph }))
    ).toBe(true);
    expect(
      Result.isSuccess(
        decode({
          workflowId: "workflow_1",
          graph: emptyGraph,
          expectedPublishedVersionId: null,
          expectedDraftRevision: 1,
        })
      )
    ).toBe(true);
  });

  it("represents redacted field changes separately from graph structure", () => {
    const decode = Schema.decodeUnknownResult(
      workflowComparisonPayloadSchema,
      rejectUnknownKeys
    );

    const result = decode({
      baseVersion: {
        id: "version_7",
        version: 7,
        publishedAt: "2026-08-23T12:00:00.000Z",
        isCurrent: true,
      },
      proposedVersion: 8,
      baseGraph: emptyGraph,
      draftGraph: emptyGraph,
      hasChanges: true,
      nodeChanges: [
        {
          nodeId: "email",
          kind: "modified",
          fields: [
            {
              path: ["data", "config", "apiKey"],
              kind: "modified",
              before: "[REDACTED]",
              after: "[REDACTED]",
            },
          ],
        },
      ],
      edgeChanges: [{ edgeId: "email-to-wait", kind: "removed" }],
    });

    expect(Result.isSuccess(result)).toBe(true);
  });

  it("rejects comparison fields with an empty machine path", () => {
    const decode = Schema.decodeUnknownResult(
      workflowComparisonPayloadSchema,
      rejectUnknownKeys
    );

    const result = decode({
      baseVersion: {
        id: "version_7",
        version: 7,
        publishedAt: "2026-08-23T12:00:00.000Z",
        isCurrent: true,
      },
      proposedVersion: 8,
      baseGraph: emptyGraph,
      draftGraph: emptyGraph,
      hasChanges: true,
      nodeChanges: [
        {
          nodeId: "email",
          kind: "modified",
          fields: [{ path: [], kind: "removed", before: "Subject" }],
        },
      ],
      edgeChanges: [],
    });

    expect(Result.isFailure(result)).toBe(true);
  });

  it("represents a first publication with no immutable base", () => {
    const firstPublicationInput: unknown = {
      workflowId: "workflow_1",
      draftGraph: emptyGraph,
    };
    const firstPublicationOutput: unknown = {
      baseVersion: null,
      proposedVersion: 1,
      baseGraph: emptyGraph,
      draftGraph: emptyGraph,
      hasChanges: false,
      nodeChanges: [],
      edgeChanges: [],
    };
    const input = Schema.decodeUnknownResult(
      workflowComparisonInputSchema,
      rejectUnknownKeys
    )(firstPublicationInput);
    const output = Schema.decodeUnknownResult(
      workflowComparisonPayloadSchema,
      rejectUnknownKeys
    )(firstPublicationOutput);

    expect(Result.isSuccess(input)).toBe(true);
    expect(Result.isSuccess(output)).toBe(true);
  });
});
