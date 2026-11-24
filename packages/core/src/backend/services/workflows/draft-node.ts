/**
 * One node of a workflow's saved draft, for a host's own page; like every
 * `app.workflows` read it applies no `auth`. Answers null when the workflow or
 * the node does not exist. Fails with `InternalFailure`, after one error
 * record, when storage refuses the read or the stored graph does not decode.
 */

import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { Extensions } from "#src/backend/lib/effect/extensions";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  findEntity,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import {
  ACTION_TYPE_CONFIG_KEY,
  actionTypeOf,
} from "@wfgraph/shared/graph/node-config";
import { getNodeDisplayName } from "@wfgraph/shared/graph/node-display";
import {
  isEntityStateSourceId,
  parseTemplate,
  type TemplateToken,
  templateTokenDisplayText,
} from "@wfgraph/shared/graph/node-references";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import {
  type JsonValue,
  readJsonObjectLeniently,
} from "@wfgraph/shared/types/json";
import { getErrorMessage } from "@wfgraph/shared/utils";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

/** What a template reference reads from. */
export type WfGraphDraftReferenceSource =
  | {
      /** A step of the same workflow, by node id. */
      kind: "step";
      nodeId: string;
    }
  | {
      /** The current state of the run's Entity, by the `defineEntity` type. */
      kind: "entity";
      entityType: string;
    };

/** One run of a template string: text as written, or a reference. */
export type WfGraphDraftSegment =
  | { kind: "text"; text: string }
  | {
      kind: "reference";
      source: WfGraphDraftReferenceSource;
      /** Dotted path into the source's value; "" when it names the whole value. */
      fieldPath: string;
      /**
       * What the builder sees in the editor, such as "Donor.firstName": the
       * source's current name and the path.
       */
      display: string;
    };

/**
 * One top-level config value. A string is a template, read as segments; any
 * other value is passed on unchanged.
 */
export type WfGraphDraftField =
  | { kind: "template"; segments: readonly WfGraphDraftSegment[] }
  | { kind: "value"; value: JsonValue };

/** One node of a workflow's saved draft. */
export type WfGraphDraftNode = {
  workflowId: string;
  nodeId: string;
  /** The node's name as the editor shows it. */
  label: string;
  /** The action the node runs. Absent for a node that is not an action. */
  actionId?: string;
  /**
   * The draft revision the node was read at. Every save of the draft raises
   * it, so a page that reads again can tell a newer save apart.
   */
  revision: number;
  /** One entry per top-level config key, the stored action id excluded. */
  fields: Record<string, WfGraphDraftField>;
};

/**
 * What a token reads from, or undefined for an Entity token whose type could
 * not be decoded, since no source can be named for it.
 */
function referenceSource(
  token: TemplateToken
): WfGraphDraftReferenceSource | undefined {
  if (!isEntityStateSourceId(token.nodeId)) {
    return { kind: "step", nodeId: token.nodeId };
  }
  return token.sourceType === undefined
    ? undefined
    : { kind: "entity", entityType: token.sourceType };
}

/**
 * The name the editor's badge shows for a reference's source: the step's
 * current name, or the Entity's catalog label, falling back to the label
 * written into the token when the step or the Entity type is gone.
 */
function sourceLabel(
  token: TemplateToken,
  source: WfGraphDraftReferenceSource,
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): string {
  if (source.kind === "entity") {
    return findEntity(catalog, source.entityType)?.label ?? token.nodeLabel;
  }
  const node = nodes.find((candidate) => candidate.id === source.nodeId);
  return node ? getNodeDisplayName(catalog, node) : token.nodeLabel;
}

/**
 * A reference as the editor's badge shows it, or a text segment holding the
 * raw token when no source can be named for it.
 */
function referenceSegment(
  token: TemplateToken,
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): WfGraphDraftSegment {
  const source = referenceSource(token);
  if (!source) {
    return { kind: "text", text: token.raw };
  }
  return {
    kind: "reference",
    source,
    fieldPath: token.fieldPath,
    display: templateTokenDisplayText({
      nodeLabel: sourceLabel(token, source, nodes, catalog),
      fieldPath: token.fieldPath,
    }),
  };
}

function draftField(
  value: JsonValue,
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): WfGraphDraftField {
  if (typeof value !== "string") {
    return { kind: "value", value };
  }
  return {
    kind: "template",
    segments: parseTemplate(value).map((segment) =>
      segment.kind === "literal"
        ? { kind: "text", text: segment.text }
        : referenceSegment(segment.token, nodes, catalog)
    ),
  };
}

/** The logger a failed read writes its one record to, the ids as fields. */
function loggerFor(input: { workflowId: string; nodeId: string }) {
  return Effect.map(AppLogger, (appLogger) =>
    appLogger
      .get("workflow")
      .with({ workflowId: input.workflowId, nodeId: input.nodeId })
  );
}

export const readDraftNode = Effect.fn("readDraftNode")(
  function* (input: { workflowId: string; nodeId: string }) {
    // PostgreSQL fails a query whose text parameter holds a NUL byte, and no
    // id it stores can hold one, so such an id names nothing.
    if (
      input.workflowId.includes("\u0000") ||
      input.nodeId.includes("\u0000")
    ) {
      return null;
    }
    const repo = yield* WorkflowRepo;
    const { catalog } = yield* Extensions;

    // One row holds the graph and the revision it was saved at, so the two
    // always describe the same save.
    const workflow = yield* repo.findById(input.workflowId);
    if (!workflow) {
      return null;
    }
    const { nodes } = yield* Effect.try({
      try: () => toWorkflowGraphData(workflow.graph),
      // A decode failure's issue can hold the value it rejected, so the log
      // record and the host receive its message alone, which quotes no value.
      catch: (cause) => ({ cause: new Error(getErrorMessage(cause)) }),
    }).pipe(
      Effect.catch(
        internalFailureFromCause(loggerFor(input), "Workflow graph is invalid")
      )
    );
    const node = nodes.find((candidate) => candidate.id === input.nodeId);
    if (!node) {
      return null;
    }

    const config = readJsonObjectLeniently(node.data.config) ?? {};
    const fields = Object.fromEntries(
      Object.entries(config)
        .filter(([key]) => key !== ACTION_TYPE_CONFIG_KEY)
        .map(([key, value]) => [key, draftField(value, nodes, catalog)])
    );

    const draftNode: WfGraphDraftNode = omitUndefined({
      workflowId: workflow.id,
      nodeId: node.id,
      label: getNodeDisplayName(catalog, node),
      actionId: actionTypeOf(node),
      revision: workflow.draftRevision,
      fields,
    });
    return draftNode;
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(input),
          "Failed to read the draft node"
        )
      )
    )
);
