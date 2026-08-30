/**
 * The four tools that answer "what can this workflow be built out of".
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
  actionsByCategory,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import type {
  ActionMetadata,
  ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { flattenConfigFields } from "@wfgraph/shared/plugins/action-fields";
import { WorkflowDraft } from "#src/document";

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
  description: Schema.optionalKey(Schema.String),
  nullable: Schema.optionalKey(Schema.Boolean),
  enumValues: Schema.optionalKey(Schema.Array(Schema.String)),
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
      description: "Delay execution or wait for an Event.",
      instructions:
        "Add and connect the node, then call set_wait. Use delay mode for a duration. Use list_events before Event mode; Event waits carry waitFor subscriptions and a timeout.",
    },
  ],
]);

function toActionSummary(action: ActionMetadata) {
  return {
    id: action.id,
    label: action.label,
    category: action.category,
    description: action.description,
    ...(action.integration === undefined
      ? {}
      : { integration: action.integration }),
    ...(action.sideEffect === undefined
      ? {}
      : { sideEffect: action.sideEffect }),
  };
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
  catalog: ExtensionCatalog,
  filter: {
    readonly query?: string | undefined;
    readonly category?: string | undefined;
    readonly integration?: string | undefined;
  }
): ActionMetadata[] {
  return catalog.actions.filter((action) => {
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

export const ListActions = Tool.make("list_actions", {
  description:
    "Search the action catalog. Answers one summary line per match. Call describe_action for the config fields of an action you mean to add.",
  parameters: Schema.Struct({
    query: Schema.optionalKey(Schema.String).annotate({
      description:
        "Case-insensitive text matched against an action's id, label, description and category. Omit to list everything.",
    }),
    category: Schema.optionalKey(Schema.String).annotate({
      description: "Exact category name, as listed in the categories field.",
    }),
    integration: Schema.optionalKey(Schema.String).annotate({
      description:
        "Exact integration type, to list only that integration's actions.",
    }),
  }),
  success: Schema.Struct({
    actions: Schema.Array(actionSummarySchema),
    /** Every category in the catalog, so a follow-up call can filter by one. */
    categories: Schema.Array(Schema.String),
    totalInCatalog: Schema.Number,
  }),
});

export const DescribeAction = Tool.make("describe_action", {
  description:
    "The full definition of one action or built-in step: its config fields, output fields, and any special authoring instructions. Read this before add_node or update_node.",
  parameters: Schema.Struct({
    actionId: Schema.String.annotate({
      description:
        "The action id from the system prompt or exactly as list_actions returned it.",
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
    "Every Event the host has registered, with the payload fields each one carries. Events are what start and cancel a workflow through set_lifecycle_rules, and what a Wait node in event mode listens for.",
  success: Schema.Struct({
    events: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        label: Schema.String,
        description: Schema.optionalKey(Schema.String),
        correlationPath: Schema.optionalKey(Schema.String),
        payloadFields: Schema.Array(referenceFieldSchema),
      })
    ),
  }),
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
    }) =>
      Effect.succeed({
        actions: searchActions(catalog, input).map(toActionSummary),
        categories: Object.keys(actionsByCategory(catalog)),
        totalInCatalog: catalog.actions.length,
      }),

    describe_action: (input: { readonly actionId: string }) => {
      const action = findAction(catalog, input.actionId);
      const builtIn = BUILT_IN_AUTHORING.get(input.actionId);
      if (!action && !builtIn) {
        return Effect.fail({
          reason: `No action with id ${input.actionId}. Call list_actions to see what exists.`,
        });
      }

      return Effect.succeed({
        action: action
          ? toActionSummary(action)
          : {
              id: input.actionId,
              label: input.actionId,
              category: "System",
              description: builtIn?.description ?? input.actionId,
            },
        configFields: flattenConfigFields(action?.configFields ?? []).map(
          (field) => ({
            key: field.key,
            label: field.label,
            type: field.type,
            ...(field.required === undefined
              ? {}
              : { required: field.required }),
            ...(field.placeholder === undefined
              ? {}
              : { placeholder: field.placeholder }),
            ...(field.example === undefined ? {} : { example: field.example }),
            ...(field.defaultValue === undefined
              ? {}
              : { defaultValue: field.defaultValue }),
            ...(field.options === undefined
              ? {}
              : { options: field.options.map((option) => option.value) }),
            ...(field.literal === undefined ? {} : { literal: field.literal }),
          })
        ),
        outputFields: (action?.outputFields ?? []).map((field) => ({
          path: field.path,
          ...(field.type === undefined ? {} : { type: field.type }),
          ...(field.description === undefined
            ? {}
            : { description: field.description }),
          ...(field.nullable === undefined ? {} : { nullable: field.nullable }),
          ...(field.enumValues === undefined
            ? {}
            : { enumValues: field.enumValues }),
        })),
        needsIntegration: action?.integration !== undefined,
        ...(builtIn === undefined
          ? {}
          : { authoringInstructions: builtIn.instructions }),
      });
    },

    list_events: () =>
      Effect.succeed({
        events: catalog.events.map((event) => ({
          name: event.name,
          label: event.label,
          ...(event.description === undefined
            ? {}
            : { description: event.description }),
          ...(event.correlationPath === undefined
            ? {}
            : { correlationPath: event.correlationPath }),
          payloadFields: event.payloadFields.map((field) => ({
            path: field.path,
            ...(field.type === undefined ? {} : { type: field.type }),
            ...(field.description === undefined
              ? {}
              : { description: field.description }),
            ...(field.nullable === undefined
              ? {}
              : { nullable: field.nullable }),
            ...(field.enumValues === undefined
              ? {}
              : { enumValues: field.enumValues }),
          })),
        })),
      }),

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
