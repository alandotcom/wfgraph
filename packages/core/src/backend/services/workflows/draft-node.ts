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
import { isBuiltInActionId } from "@wfgraph/shared/actions/built-in-actions";
import {
  type ExtensionCatalog,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import {
  currentTokenDisplayText,
  getNodeDisplayName,
} from "@wfgraph/shared/graph/node-display";
import {
  isEntityStateSourceId,
  parseTemplate,
  type TemplateToken,
} from "@wfgraph/shared/graph/node-references";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import {
  flattenConfigFields,
  literalFieldKeys,
  templateJsonFieldShapes,
} from "@wfgraph/shared/plugins/action-fields";
import {
  readConfigValue,
  type TemplateConfigRules,
} from "@wfgraph/shared/plugins/template-config";
import {
  type JsonObject,
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
       * What the builder sees in the editor, such as "Member.firstName": the
       * source's current name and the path.
       */
      display: string;
    };

/** One row of a key-value field. */
export type WfGraphDraftRow = {
  /** The row's name as written. The engine resolves no reference in it. */
  name: string;
  /** The row's value, read as a template. */
  segments: readonly WfGraphDraftSegment[];
};

/**
 * One input of a host action, read the way the engine reads it when the step
 * runs. `template` is a string the engine resolves references in, `rows` is a
 * `key-value` field whose row values it resolves one at a time, and `value` is
 * handed to the step as stored, such as a value that is not a string or a
 * string under a `literal` field.
 */
export type WfGraphDraftField =
  | { kind: "template"; segments: readonly WfGraphDraftSegment[] }
  | { kind: "rows"; rows: readonly WfGraphDraftRow[] }
  | { kind: "value"; value: JsonValue };

/** The saved draft a node's references are named against. */
type DraftWorkflow = {
  nodes: readonly WorkflowNode[];
  catalog: ExtensionCatalog;
};

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
  /**
   * For a node running a host action, one entry per input the action declares
   * and the node stores, in the declared order. Empty for any other node,
   * including an integration action, a built-in such as Wait, and an action
   * the catalog does not hold.
   */
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
 * A reference as the editor's badge shows it, or a text segment holding the
 * raw token when no source can be named for it.
 */
function referenceSegment(
  token: TemplateToken,
  workflow: DraftWorkflow
): WfGraphDraftSegment {
  const source = referenceSource(token);
  if (!source) {
    return { kind: "text", text: token.raw };
  }
  return {
    kind: "reference",
    source,
    fieldPath: token.fieldPath,
    display: currentTokenDisplayText(token, workflow.nodes, workflow.catalog),
  };
}

/** A template string as text and reference segments. */
function templateSegments(
  text: string,
  workflow: DraftWorkflow
): WfGraphDraftSegment[] {
  return parseTemplate(text).map((segment) =>
    segment.kind === "literal"
      ? { kind: "text", text: segment.text }
      : referenceSegment(segment.token, workflow)
  );
}

function draftField(
  key: string,
  value: JsonValue,
  rules: TemplateConfigRules,
  workflow: DraftWorkflow
): WfGraphDraftField {
  const reading = readConfigValue(key, value, rules);
  if (reading.kind === "template") {
    return {
      kind: "template",
      segments: templateSegments(reading.value, workflow),
    };
  }
  if (reading.kind === "key-value") {
    return {
      kind: "rows",
      rows: reading.rows.map((row) => ({
        name: row.name,
        segments: templateSegments(row.value, workflow),
      })),
    };
  }
  // The `stored` reading. The `provider-fields` reading needs a field type
  // that a host action's `configFields` type excludes.
  return { kind: "value", value };
}

function draftFields(
  actionId: string | undefined,
  config: JsonObject,
  workflow: DraftWorkflow
): Record<string, WfGraphDraftField> {
  const action =
    actionId === undefined || isBuiltInActionId(actionId)
      ? undefined
      : findAction(workflow.catalog, actionId);
  if (!action || action.integration !== undefined) {
    return {};
  }
  const rules: TemplateConfigRules = {
    literalKeys: new Set(literalFieldKeys(action.configFields)),
    jsonShapes: new Map(templateJsonFieldShapes(action.configFields)),
  };
  return Object.fromEntries(
    flattenConfigFields(action.configFields).flatMap((field) => {
      const value = Object.hasOwn(config, field.key)
        ? config[field.key]
        : undefined;
      return value === undefined
        ? []
        : [[field.key, draftField(field.key, value, rules, workflow)]];
    })
  );
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

    const actionId = actionTypeOf(node);
    const draftNode: WfGraphDraftNode = omitUndefined({
      workflowId: workflow.id,
      nodeId: node.id,
      label: getNodeDisplayName(catalog, node),
      actionId,
      revision: workflow.draftRevision,
      fields: draftFields(
        actionId,
        readJsonObjectLeniently(node.data.config) ?? {},
        { nodes, catalog }
      ),
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
