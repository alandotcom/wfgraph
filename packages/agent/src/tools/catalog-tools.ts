/**
 * The five tools that answer "what can this workflow be built out of".
 *
 * The catalog can hold hundreds of actions once a host registers its own, so
 * `list_actions` answers a filtered index of one line per action and
 * `describe_action` answers the config and output fields for the one the model
 * settled on. Handing the whole catalog over in the system prompt instead would
 * grow without bound with the host's surface.
 */

import { Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import {
  findAction,
  findEvent,
  selectableActions,
  selectableActionsByCategory,
} from "@wfgraph/shared/extensions/catalog";
import type {
  ActionMetadata,
  ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import type { ReferenceField } from "@wfgraph/shared/graph/node-references";
import { flattenConfigFields } from "@wfgraph/shared/plugins/action-fields";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { WorkflowDraft } from "#src/document";
import {
  pageResults,
  resultLimitSchema,
  resultOffsetSchema,
} from "#src/tools/result-page";

const actionSummarySchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  category: Schema.String,
  description: Schema.String,
  integration: Schema.optionalKey(Schema.String),
  /** True when running the action changes something outside the workflow. */
  sideEffect: Schema.optionalKey(Schema.Boolean),
});

const configFieldSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  type: Schema.String,
  required: Schema.optionalKey(Schema.Boolean),
  placeholder: Schema.optionalKey(Schema.String),
  example: Schema.optionalKey(Schema.String),
  defaultValue: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Set when the field takes a plain value and never a `{{...}}` reference. */
  literal: Schema.optionalKey(Schema.Boolean),
});

const referenceFieldSchema = Schema.Struct({
  path: Schema.String,
  type: Schema.optionalKey(Schema.String),
  /** The value type for an open-record field whose keys are chosen at runtime. */
  valueType: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  nullable: Schema.optionalKey(Schema.Boolean),
  enumValues: Schema.optionalKey(Schema.Array(Schema.String)),
});

const eventSummarySchema = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  integration: Schema.optionalKey(Schema.String),
});

const BUILT_IN_AUTHORING = new Map<
  string,
  { readonly description: string; readonly instructions: string }
>([
  [
    BUILT_IN_ACTION_IDS.condition,
    {
      description: "Branch based on a condition.",
      instructions:
        'Add the node, connect its inputs, then call set_condition. Connect outgoing branches with sourceHandle "true" or "false".',
    },
  ],
  [
    BUILT_IN_ACTION_IDS.eventSplit,
    {
      description: "Send a run down the branch belonging to its Event.",
      instructions:
        'The node has no config. Connect each outgoing branch with sourceHandle "event:<Event name>". The Event must reach the split.',
    },
  ],
  [
    BUILT_IN_ACTION_IDS.wait,
    {
      description:
        "Wait for a duration, until a date/time, or until an Event arrives.",
      instructions:
        "Add and connect the node, then call set_wait. Use duration timing for a relative delay. Use until timing with a timestamp from list_references and an optional negative or positive offset. Use list_events before Event mode. Match a Wait Event to the current run with an exact list_references token. Integration-owned Events take a Connection ID from list_integrations. Event waits also need a timeout.",
    },
  ],
]);

function toActionSummary(action: ActionMetadata) {
  return omitUndefined({
    id: action.id,
    label: action.label,
    category: action.category,
    description: action.description,
    integration: action.integration,
    sideEffect: action.sideEffect,
  });
}

/**
 * One output or Event payload field, in the shape `describe_action` and
 * `describe_event` both return.
 */
function toReferenceField(field: ReferenceField) {
  return omitUndefined({
    path: field.path,
    type: field.type,
    valueType: field.valueType,
    description: field.description,
    nullable: field.nullable,
    enumValues: field.enumValues,
  });
}

/** Case-insensitive substring match over the text a person would search by. */
function matchesQuery(action: ActionMetadata, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return [action.id, action.label, action.description, action.category].some(
    (field) => field.toLowerCase().includes(needle)
  );
}

function searchActions(
  actions: readonly ActionMetadata[],
  filter: {
    readonly query?: string | undefined;
    readonly category?: string | undefined;
    readonly integration?: string | undefined;
  }
): ActionMetadata[] {
  return actions.filter((action) => {
    if (filter.category !== undefined && action.category !== filter.category) {
      return false;
    }
    if (
      filter.integration !== undefined &&
      action.integration !== filter.integration
    ) {
      return false;
    }
    return matchesQuery(action, filter.query ?? "");
  });
}

function matchesEventQuery(
  event: ExtensionCatalog["events"][number],
  query: string
): boolean {
  const needle = query.trim().toLowerCase();
  return (
    needle.length === 0 ||
    [event.name, event.label, event.description ?? ""].some((field) =>
      field.toLowerCase().includes(needle)
    )
  );
}

function toEventSummary(event: ExtensionCatalog["events"][number]) {
  return omitUndefined({
    name: event.name,
    label: event.label,
    description: event.description,
    integration: event.integration,
  });
}

export const ListActions = Tool.make("list_actions", {
  description:
    "Search the action catalog. Answers one summary line per match. Call describe_action for the config fields of an action you mean to add.",
  parameters: Schema.Struct({
    query: Schema.optionalKey(Schema.String).annotate({
      description:
        "Case-insensitive text matched against an action's id, label, description and category. Omit to list everything.",
    }),
    category: Schema.optionalKey(Schema.String).annotate({
      description:
        "Exact category name from the categories field or an action summary.",
    }),
    integration: Schema.optionalKey(Schema.String).annotate({
      description:
        "Exact integration type, to list only that integration's actions.",
    }),
    offset: Schema.optionalKey(resultOffsetSchema),
    limit: Schema.optionalKey(resultLimitSchema),
  }),
  success: Schema.Struct({
    actions: Schema.Array(actionSummarySchema),
    /** A bounded index of selectable categories for follow-up filtering. */
    categories: Schema.Array(Schema.String),
    totalCategories: Schema.Number,
    categoriesTruncated: Schema.Boolean,
    totalInCatalog: Schema.Number,
    totalMatches: Schema.Number,
    truncated: Schema.Boolean,
    nextOffset: Schema.optionalKey(Schema.Number),
  }),
});

export const DescribeAction = Tool.make("describe_action", {
  description:
    "The full definition of one action or built-in step: its config fields, output fields, and any special authoring instructions. Read this before add_node or update_node.",
  parameters: Schema.Struct({
    actionId: Schema.String.annotate({
      description:
        "An action id returned by list_actions, or a built-in step named in the system instructions.",
    }),
  }),
  success: Schema.Struct({
    action: actionSummarySchema,
    /** Field groups are flattened, because a group is a form layout and nothing else. */
    configFields: Schema.Array(configFieldSchema),
    outputFields: Schema.Array(referenceFieldSchema),
    /** True when the action needs a connected integration before it can run. */
    needsIntegration: Schema.Boolean,
    authoringInstructions: Schema.optionalKey(Schema.String),
  }),
  failure: Schema.Struct({ reason: Schema.String }),
  failureMode: "return",
});

export const ListEvents = Tool.make("list_events", {
  description:
    "Search Event summaries registered by the host. Call describe_event for payload fields and correlation details before authoring with an Event.",
  parameters: Schema.Struct({
    query: Schema.optionalKey(Schema.String).annotate({
      description:
        "Case-insensitive text matched against an Event's name, label, and description.",
    }),
    integration: Schema.optionalKey(Schema.String).annotate({
      description: "Exact integration type for integration-owned Events.",
    }),
    offset: Schema.optionalKey(resultOffsetSchema),
    limit: Schema.optionalKey(resultLimitSchema),
  }),
  success: Schema.Struct({
    events: Schema.Array(eventSummarySchema),
    totalMatches: Schema.Number,
    truncated: Schema.Boolean,
    nextOffset: Schema.optionalKey(Schema.Number),
  }),
});

export const DescribeEvent = Tool.make("describe_event", {
  description:
    "The full definition of one Event, including payload fields, correlation path, and integration ownership. Read this before configuring Lifecycle rules or an Event Wait.",
  parameters: Schema.Struct({
    eventName: Schema.String.annotate({
      description: "The exact Event name returned by list_events.",
    }),
  }),
  success: Schema.Struct({
    name: Schema.String,
    label: Schema.String,
    description: Schema.optionalKey(Schema.String),
    integration: Schema.optionalKey(Schema.String),
    correlationPath: Schema.optionalKey(Schema.String),
    payloadFields: Schema.Array(referenceFieldSchema),
  }),
  failure: Schema.Struct({ reason: Schema.String }),
  failureMode: "return",
});

export const ListIntegrations = Tool.make("list_integrations", {
  description:
    "Every integration the host has registered, and which of them the operator has already connected. An action whose integration has no connection can still be added; it will report a blocking issue until one exists.",
  success: Schema.Struct({
    integrations: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        label: Schema.String,
        description: Schema.String,
        /** The stored connection ids, for an action's integrationId config key. */
        connectionIds: Schema.Array(Schema.String),
      })
    ),
  }),
});

export const catalogToolHandlers = Effect.gen(function* () {
  const draft = yield* WorkflowDraft;
  const { catalog, integrations } = draft;

  return {
    list_actions: (input: {
      readonly query?: string | undefined;
      readonly category?: string | undefined;
      readonly integration?: string | undefined;
      readonly offset?: number | undefined;
      readonly limit?: number | undefined;
    }) =>
      Effect.succeed(
        (() => {
          const selectable = selectableActions(catalog);
          const matches = searchActions(selectable, input);
          const page = pageResults(matches, input);
          const categories = Object.keys(selectableActionsByCategory(catalog));
          return omitUndefined({
            actions: page.items.map(toActionSummary),
            categories: categories.slice(0, 50),
            totalCategories: categories.length,
            categoriesTruncated: categories.length > 50,
            totalInCatalog: catalog.actions.length,
            totalMatches: page.total,
            truncated: page.nextOffset !== undefined,
            nextOffset: page.nextOffset,
          });
        })()
      ),

    describe_action: (input: { readonly actionId: string }) => {
      const action = findAction(catalog, input.actionId);
      const builtIn = BUILT_IN_AUTHORING.get(input.actionId);
      if (!action && !builtIn) {
        return Effect.fail({
          reason: `No action with id ${input.actionId}. Call list_actions to see what exists.`,
        });
      }

      return Effect.succeed(
        omitUndefined({
          action: action
            ? toActionSummary(action)
            : {
                id: input.actionId,
                label: input.actionId,
                category: "System",
                description: builtIn?.description ?? input.actionId,
              },
          configFields: flattenConfigFields(action?.configFields ?? []).map(
            (field) =>
              omitUndefined({
                key: field.key,
                label: field.label,
                type: field.type,
                required: field.required,
                placeholder: field.placeholder,
                example: field.example,
                defaultValue: field.defaultValue,
                options: field.options?.map((option) => option.value),
                literal: field.literal,
              })
          ),
          outputFields: (action?.outputFields ?? []).map(toReferenceField),
          needsIntegration: action?.integration !== undefined,
          authoringInstructions: builtIn?.instructions,
        })
      );
    },

    list_events: (input: {
      readonly query?: string | undefined;
      readonly integration?: string | undefined;
      readonly offset?: number | undefined;
      readonly limit?: number | undefined;
    }) => {
      const matches = catalog.events.filter(
        (event) =>
          (input.integration === undefined ||
            event.integration === input.integration) &&
          matchesEventQuery(event, input.query ?? "")
      );
      const page = pageResults(matches, input);
      return Effect.succeed(
        omitUndefined({
          events: page.items.map(toEventSummary),
          totalMatches: page.total,
          truncated: page.nextOffset !== undefined,
          nextOffset: page.nextOffset,
        })
      );
    },

    describe_event: (input: { readonly eventName: string }) => {
      const event = findEvent(catalog, input.eventName);
      if (!event) {
        return Effect.fail({
          reason: `No Event named ${input.eventName}. Call list_events to see what exists.`,
        });
      }

      return Effect.succeed(
        omitUndefined({
          ...toEventSummary(event),
          correlationPath: event.correlationPath,
          payloadFields: event.payloadFields.map(toReferenceField),
        })
      );
    },

    list_integrations: () =>
      Effect.succeed({
        integrations: catalog.integrations.map((integration) => ({
          type: integration.type,
          label: integration.label,
          description: integration.description,
          connectionIds: integrations
            .filter((stored) => stored.type === integration.type)
            .map((stored) => stored.id),
        })),
      }),
  };
});
