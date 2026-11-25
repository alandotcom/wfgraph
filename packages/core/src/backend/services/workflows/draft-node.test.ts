import { inspect } from "node:util";
import { assert, describe, it as effectIt } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  AppLogger,
  type EffectLogger,
} from "#src/backend/lib/effect/app-logger";
import type { Workflow } from "#src/backend/lib/db/schema";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { InternalFailure } from "#src/backend/lib/effect/failures";
import {
  makeRecordingLogger,
  SilentAppLoggerLayer,
  stubExtensionCatalog,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { readDraftNode } from "#src/backend/services/workflows/draft-node";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import {
  ENTITY_STATE_SOURCE_ID,
  formatTemplateToken,
} from "@wfgraph/shared/graph/node-references";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";

/** The Lifecycle node of a workflow that tracks the member Entity. */
const tracksMember: WorkflowNode = {
  id: "entry",
  type: "lifecycle",
  position: { x: 0, y: -100 },
  data: {
    label: "Members",
    type: "lifecycle",
    config: {
      lifecycleRules: {
        startEvents: [],
        cancelEvents: [],
        concurrency: "unlimited",
        trackedEntity: { type: "member", bindings: {} },
      },
    },
  },
};

const lookup: WorkflowNode = {
  id: "lookup-1",
  type: "action",
  position: { x: 0, y: 0 },
  data: {
    label: "Find Member",
    type: "action",
    config: { actionType: "members/find" },
  },
};

/** Tokens as the editor writes them, so the parser reads the real grammar. */
const stepToken = formatTemplateToken({
  nodeId: "lookup-1",
  // The label baked in when the reference was written. The step has since
  // been renamed, and the answer carries its current name.
  nodeLabel: "Lookup",
  fieldPath: "email",
});
const entityToken = formatTemplateToken({
  nodeId: ENTITY_STATE_SOURCE_ID,
  sourceType: "member",
  // The label baked in when the reference was written, which the catalog's
  // label for the tracked Entity replaces.
  nodeLabel: "Person",
  fieldPath: "firstName",
});

const sendEmail: WorkflowNode = {
  id: "send-1",
  type: "action",
  position: { x: 0, y: 100 },
  data: {
    label: "Welcome email",
    type: "action",
    config: {
      actionType: "members/send-email",
      subject: "Welcome",
      body: `Hi ${entityToken}, we wrote to ${stepToken}.`,
      priority: 2,
      tags: ["welcome"],
    },
  },
};

function stored(nodes: WorkflowNode[]): Workflow {
  return {
    id: "wf_1",
    name: "Member welcome",
    description: null,
    graph: createSerializedWorkflowGraph({ nodes, edges: [] }),
    draftRevision: 4,
    isPaused: false,
    mode: "live",
    visibility: "private",
    publishedVersionId: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
  };
}

const catalogLayer = stubExtensionCatalog({
  entities: [
    {
      type: "member",
      label: "Member",
      stateFields: [{ path: "firstName", type: "string" }],
      stateSchemaDigest: "digest",
    },
  ],
});

function read(
  input: { workflowId: string; nodeId: string },
  findById: (
    workflowId: string
  ) => Effect.Effect<Workflow | null, DatabaseError>
) {
  return readDraftNode(input).pipe(
    Effect.provide(
      Layer.mergeAll(
        SilentAppLoggerLayer,
        catalogLayer,
        stubWorkflowRepo({ findById })
      )
    )
  );
}

describe("readDraftNode", () => {
  effectIt.effect(
    "reads each config string as text and references, at the stored revision",
    () =>
      Effect.gen(function* () {
        const node = yield* read({ workflowId: "wf_1", nodeId: "send-1" }, () =>
          Effect.succeed(stored([tracksMember, lookup, sendEmail]))
        );

        assert.deepStrictEqual(node, {
          workflowId: "wf_1",
          nodeId: "send-1",
          label: "Welcome email",
          actionId: "members/send-email",
          revision: 4,
          fields: {
            subject: {
              kind: "template",
              segments: [{ kind: "text", text: "Welcome" }],
            },
            body: {
              kind: "template",
              segments: [
                { kind: "text", text: "Hi " },
                {
                  kind: "reference",
                  source: { kind: "entity", entityType: "member" },
                  fieldPath: "firstName",
                  display: "Member.firstName",
                },
                { kind: "text", text: ", we wrote to " },
                {
                  kind: "reference",
                  source: { kind: "step", nodeId: "lookup-1" },
                  fieldPath: "email",
                  display: "Find Member.email",
                },
                { kind: "text", text: "." },
              ],
            },
            priority: { kind: "value", value: 2 },
            tags: { kind: "value", value: ["welcome"] },
          },
        });
      })
  );

  effectIt.effect(
    "keeps the written label for a reference to a step that is gone",
    () =>
      Effect.gen(function* () {
        const node = yield* read({ workflowId: "wf_1", nodeId: "send-1" }, () =>
          Effect.succeed(stored([sendEmail]))
        );

        const body = node?.fields.body;
        assert.strictEqual(body?.kind, "template");
        const reference =
          body?.kind === "template" ? body.segments[3] : undefined;
        assert.deepStrictEqual(reference, {
          kind: "reference",
          source: { kind: "step", nodeId: "lookup-1" },
          fieldPath: "email",
          display: "Lookup.email",
        });
      })
  );

  // The editor draws such a token as a broken badge holding its stored label,
  // since the run has no state of that Entity type to read.
  effectIt.effect(
    "keeps the written label for an Entity the workflow does not track",
    () =>
      Effect.gen(function* () {
        const node = yield* read({ workflowId: "wf_1", nodeId: "send-1" }, () =>
          Effect.succeed(stored([lookup, sendEmail]))
        );

        const body = node?.fields.body;
        const reference =
          body?.kind === "template" ? body.segments[1] : undefined;
        assert.deepStrictEqual(reference, {
          kind: "reference",
          source: { kind: "entity", entityType: "member" },
          fieldPath: "firstName",
          display: "Person.firstName",
        });
      })
  );

  effectIt.effect(
    "answers an Entity reference with no readable type as its raw text",
    () =>
      Effect.gen(function* () {
        const raw = `{{@${ENTITY_STATE_SOURCE_ID}:Member.firstName}}`;
        const node = yield* read({ workflowId: "wf_1", nodeId: "send-1" }, () =>
          Effect.succeed(
            stored([
              {
                ...sendEmail,
                data: {
                  ...sendEmail.data,
                  config: { actionType: "members/send-email", subject: raw },
                },
              },
            ])
          )
        );

        assert.deepStrictEqual(node?.fields, {
          subject: {
            kind: "template",
            segments: [{ kind: "text", text: raw }],
          },
        });
      })
  );

  effectIt.effect("leaves actionId off a node that is not an action", () =>
    Effect.gen(function* () {
      const node = yield* read({ workflowId: "wf_1", nodeId: "group-1" }, () =>
        Effect.succeed(
          stored([
            {
              id: "group-1",
              type: "group",
              position: { x: 0, y: 0 },
              data: { label: "Lookups", type: "group", config: {} },
            },
          ])
        )
      );

      assert.isDefined(node);
      assert.notProperty(node, "actionId");
      assert.deepStrictEqual(node?.fields, {});
    })
  );

  effectIt.effect("answers null for a workflow that does not exist", () =>
    Effect.gen(function* () {
      const node = yield* read(
        { workflowId: "missing", nodeId: "send-1" },
        () => Effect.succeed(null)
      );

      assert.isNull(node);
    })
  );

  // The repository stub kills the test on any query, which is what holds the
  // read to answering before it reaches storage.
  effectIt.effect.each([
    { workflowId: "wf\u0000", nodeId: "send-1" },
    { workflowId: "wf_1", nodeId: "send\u0000" },
  ])("answers null without a query for an id holding a NUL byte", (input) =>
    Effect.gen(function* () {
      const node = yield* readDraftNode(input).pipe(
        Effect.provide(
          Layer.mergeAll(SilentAppLoggerLayer, catalogLayer, stubWorkflowRepo())
        )
      );

      assert.isNull(node);
    })
  );

  effectIt.effect("answers null for a node the draft does not hold", () =>
    Effect.gen(function* () {
      const node = yield* read({ workflowId: "wf_1", nodeId: "missing" }, () =>
        Effect.succeed(stored([sendEmail]))
      );

      assert.isNull(node);
    })
  );

  effectIt.effect("fails as internal when storage refuses the read", () =>
    Effect.gen(function* () {
      const failure = yield* read(
        { workflowId: "wf_1", nodeId: "send-1" },
        () =>
          Effect.fail(
            new DatabaseError({ cause: new Error("connection reset") })
          )
      ).pipe(Effect.flip);

      assert.instanceOf(failure, InternalFailure);
      assert.strictEqual(failure.error, "Failed to read the draft node");
    })
  );

  // A stored graph that no longer decodes is a fault for whoever operates the
  // app, so it is logged once with the ids, and the record names no stored value.
  effectIt.effect(
    "logs one record and fails as internal when the stored graph does not decode",
    () =>
      Effect.gen(function* () {
        const recorder = makeRecordingLogger();
        const fields: unknown[] = [];
        const logger: EffectLogger = {
          ...recorder.logger,
          with: (properties) => {
            fields.push(properties);
            return logger;
          },
        };
        const workflow = stored([sendEmail]);
        const unreadable: Workflow = {
          ...workflow,
          graph: {
            ...workflow.graph,
            nodes: workflow.graph.nodes.map((node) => ({
              ...node,
              secret: "hunter2",
            })),
          },
        };

        const failure = yield* readDraftNode({
          workflowId: "wf_1",
          nodeId: "send-1",
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(AppLogger, { get: () => logger }),
              catalogLayer,
              stubWorkflowRepo({ findById: () => Effect.succeed(unreadable) })
            )
          ),
          Effect.flip
        );

        assert.instanceOf(failure, InternalFailure);
        assert.strictEqual(failure.error, "Workflow graph is invalid");
        assert.deepStrictEqual(fields, [
          { workflowId: "wf_1", nodeId: "send-1" },
        ]);
        assert.lengthOf(recorder.lines, 1);
        assert.match(
          recorder.lines[0]?.message ?? "",
          /^Workflow graph is invalid: /u
        );
        assert.notInclude(inspect(recorder.lines, { depth: null }), "hunter2");
      })
  );
});
