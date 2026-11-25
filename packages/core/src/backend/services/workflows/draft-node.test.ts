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
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { ActionMetadata } from "@wfgraph/shared/extensions/catalog";
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

/** The send-email node holding `config` and nothing else. */
function sendEmailWith(config: Record<string, unknown>): WorkflowNode {
  return { ...sendEmail, data: { ...sendEmail.data, config } };
}

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

/** The host action the send-email node runs: no `integration`. */
const sendEmailAction: ActionMetadata = {
  id: "members/send-email",
  label: "Send Email to Member",
  description: "Sends an email to a member.",
  category: "Members",
  configFields: [
    { key: "subject", label: "Subject", type: "template-input" },
    { key: "body", label: "Body", type: "template-textarea" },
    { key: "priority", label: "Priority", type: "number" },
    { key: "tags", label: "Tags", type: "text" },
    {
      key: "testAddress",
      label: "Test address",
      type: "template-input",
      literal: true,
    },
    { key: "condition", label: "Condition", type: "template-input" },
    { key: "headers", label: "Headers", type: "key-value" },
    {
      label: "Advanced",
      type: "group",
      fields: [{ key: "replyTo", label: "Reply to", type: "template-input" }],
    },
  ],
  outputFields: [],
};

/** An integration action that declares the key its node stores. */
const integrationAction: ActionMetadata = {
  id: "mail/send",
  label: "Send Mail",
  description: "Sends an email through the mail integration.",
  category: "Mail",
  integration: "mail",
  configFields: [{ key: "subject", label: "Subject", type: "template-input" }],
  outputFields: [],
};

/**
 * A Wait entry that declares a key, so a Wait node answering no fields shows
 * the built-in check at work rather than an empty field list.
 */
const waitAction: ActionMetadata = {
  id: BUILT_IN_ACTION_IDS.wait,
  label: "Wait",
  description: "Delay execution or wait for an Event",
  category: "System",
  configFields: [{ key: "duration", label: "Duration", type: "text" }],
  outputFields: [],
};

const catalogLayer = stubExtensionCatalog({
  actions: [sendEmailAction, integrationAction, waitAction],
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
              sendEmailWith({ actionType: "members/send-email", subject: raw }),
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

  effectIt.effect(
    "leaves out a stored key the host action does not declare",
    () =>
      Effect.gen(function* () {
        const node = yield* read({ workflowId: "wf_1", nodeId: "send-1" }, () =>
          Effect.succeed(
            stored([
              sendEmailWith({
                actionType: "members/send-email",
                subject: "Welcome",
                internalNote: "draft two",
              }),
            ])
          )
        );

        assert.deepStrictEqual(node?.fields, {
          subject: {
            kind: "template",
            segments: [{ kind: "text", text: "Welcome" }],
          },
        });
      })
  );

  effectIt.effect("answers the declared fields in the declared order", () =>
    Effect.gen(function* () {
      const node = yield* read({ workflowId: "wf_1", nodeId: "send-1" }, () =>
        Effect.succeed(
          stored([
            sendEmailWith({
              headers: "[]",
              priority: 1,
              actionType: "members/send-email",
              subject: "Welcome",
            }),
          ])
        )
      );

      assert.deepStrictEqual(Object.keys(node?.fields ?? {}), [
        "subject",
        "priority",
        "headers",
      ]);
    })
  );

  effectIt.effect("answers no fields for a Lifecycle node", () =>
    Effect.gen(function* () {
      const node = yield* read({ workflowId: "wf_1", nodeId: "entry" }, () =>
        Effect.succeed(
          stored([
            {
              ...tracksMember,
              data: {
                ...tracksMember.data,
                config: {
                  ...tracksMember.data.config,
                  testPayloads: { manual: { memberId: "mem_1" } },
                },
              },
            },
          ])
        )
      );

      assert.isDefined(node);
      assert.notProperty(node, "actionId");
      assert.deepStrictEqual(node?.fields, {});
    })
  );

  effectIt.effect("answers no fields for an integration action node", () =>
    Effect.gen(function* () {
      const node = yield* read({ workflowId: "wf_1", nodeId: "send-1" }, () =>
        Effect.succeed(
          stored([
            sendEmailWith({
              actionType: "mail/send",
              integrationId: "int_1",
              subject: `Hi ${entityToken}`,
            }),
          ])
        )
      );

      assert.strictEqual(node?.actionId, "mail/send");
      assert.deepStrictEqual(node?.fields, {});
    })
  );

  effectIt.effect("answers no fields for a built-in action node", () =>
    Effect.gen(function* () {
      const node = yield* read({ workflowId: "wf_1", nodeId: "send-1" }, () =>
        Effect.succeed(
          stored([
            sendEmailWith({
              actionType: BUILT_IN_ACTION_IDS.wait,
              duration: "5",
            }),
          ])
        )
      );

      assert.strictEqual(node?.actionId, BUILT_IN_ACTION_IDS.wait);
      assert.deepStrictEqual(node?.fields, {});
    })
  );

  effectIt.effect(
    "answers no fields for an action the catalog does not hold, with its id",
    () =>
      Effect.gen(function* () {
        const node = yield* read({ workflowId: "wf_1", nodeId: "send-1" }, () =>
          Effect.succeed(
            stored([
              sendEmailWith({
                actionType: "members/archived-action",
                subject: "Welcome",
              }),
            ])
          )
        );

        assert.strictEqual(node?.actionId, "members/archived-action");
        assert.deepStrictEqual(node?.fields, {});
      })
  );

  // The engine hands both keys to the step as authored, so token text in
  // them is text the step receives rather than a reference.
  effectIt.effect(
    "answers a literal field and a condition input as stored values",
    () =>
      Effect.gen(function* () {
        const node = yield* read({ workflowId: "wf_1", nodeId: "send-1" }, () =>
          Effect.succeed(
            stored([
              sendEmailWith({
                actionType: "members/send-email",
                testAddress: `test+${stepToken}@example.com`,
                condition: entityToken,
              }),
            ])
          )
        );

        assert.deepStrictEqual(node?.fields, {
          testAddress: {
            kind: "value",
            value: `test+${stepToken}@example.com`,
          },
          condition: { kind: "value", value: entityToken },
        });
      })
  );

  effectIt.effect(
    "reads a key-value field as rows, each value split and each name as written",
    () =>
      Effect.gen(function* () {
        const node = yield* read({ workflowId: "wf_1", nodeId: "send-1" }, () =>
          Effect.succeed(
            stored([
              tracksMember,
              lookup,
              sendEmailWith({
                actionType: "members/send-email",
                headers: JSON.stringify([
                  { name: stepToken, value: `Hello ${entityToken}` },
                  { name: "X-Plain", value: "fixed" },
                ]),
              }),
            ])
          )
        );

        assert.deepStrictEqual(node?.fields, {
          headers: {
            kind: "rows",
            rows: [
              {
                name: stepToken,
                segments: [
                  { kind: "text", text: "Hello " },
                  {
                    kind: "reference",
                    source: { kind: "entity", entityType: "member" },
                    fieldPath: "firstName",
                    display: "Member.firstName",
                  },
                ],
              },
              {
                name: "X-Plain",
                segments: [{ kind: "text", text: "fixed" }],
              },
            ],
          },
        });
      })
  );

  // The engine resolves such text as one template, so the read does too.
  effectIt.effect(
    "reads a key-value field whose text holds no rows as one template",
    () =>
      Effect.gen(function* () {
        const node = yield* read({ workflowId: "wf_1", nodeId: "send-1" }, () =>
          Effect.succeed(
            stored([
              sendEmailWith({
                actionType: "members/send-email",
                headers: "not rows",
              }),
            ])
          )
        );

        assert.deepStrictEqual(node?.fields, {
          headers: {
            kind: "template",
            segments: [{ kind: "text", text: "not rows" }],
          },
        });
      })
  );

  effectIt.effect("answers a field declared inside a group", () =>
    Effect.gen(function* () {
      const node = yield* read({ workflowId: "wf_1", nodeId: "send-1" }, () =>
        Effect.succeed(
          stored([
            sendEmailWith({
              actionType: "members/send-email",
              replyTo: "team@example.com",
            }),
          ])
        )
      );

      assert.deepStrictEqual(node?.fields, {
        replyTo: {
          kind: "template",
          segments: [{ kind: "text", text: "team@example.com" }],
        },
      });
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
