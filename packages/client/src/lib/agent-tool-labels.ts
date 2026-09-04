/**
 * What each of the agent's tool calls is called in the panel.
 *
 * A row names the work rather than the function: `list_actions` with a query
 * reads "Searched actions for “slack”", so five searches in a row are five
 * distinguishable lines instead of five copies of a tool name.
 *
 * A read tool answers no sentence of its own, so its phrase is what the row
 * says both while it runs and after: past tense, because the row is a record by
 * the time anyone opens it.
 *
 * A write tool does answer one, and the server builds it from the draft it just
 * changed ("Connected Lifecycle to Notify the team."). That sentence is the row
 * once the call settles, so the phrases here for a write are present tense and
 * only ever seen in flight. Resolving a node id to its label a second time in
 * the browser would be a second rule on a second source of truth.
 *
 * The arguments arrive as JSON the model filled in, so nothing here may assume a
 * key is present or holds the type its schema declares.
 */

import { type JsonObject, readJsonObject } from "@wfgraph/shared/types/json";
import { asNonEmptyString, isBlank } from "@wfgraph/shared/types/string";

/**
 * How much of a model-written value a row quotes.
 *
 * Long enough for a real search term, short enough that the row stays on one
 * line in the narrowest panel the user can drag.
 */
const MAX_QUOTED_LENGTH = 40;

/** One argument as a string, or nothing when the model left it out. */
function text(input: JsonObject | null, key: string): string | undefined {
  return asNonEmptyString(input?.[key]);
}

/** How many entries an array argument holds, or nothing when it is not one. */
function count(input: JsonObject | null, key: string): number | undefined {
  const value = input?.[key];
  return Array.isArray(value) ? value.length : undefined;
}

/**
 * One value the model wrote, in typographic quotes and cut to one line.
 *
 * The ellipsis goes inside the quotes so the reader can tell a truncated value
 * from a complete one that happens to end in a full stop.
 */
function quoted(value: string): string {
  const cut =
    value.length > MAX_QUOTED_LENGTH
      ? `${value.slice(0, MAX_QUOTED_LENGTH).trimEnd()}…`
      : value;

  return `“${cut}”`;
}

/** "1 step" or "3 steps", so a row never reads "1 steps". */
function steps(total: number): string {
  return total === 1 ? "1 step" : `${total} steps`;
}

/** The catalog searches, which all take the same three narrowing arguments. */
function catalogSearchLabel(input: {
  readonly args: JsonObject | null;
  readonly plural: string;
}): string {
  const query = text(input.args, "query");
  if (query) {
    return `Searched ${input.plural} for ${quoted(query)}`;
  }

  const listed =
    text(input.args, "category") ?? text(input.args, "integration");

  return listed
    ? `Listed ${listed} ${input.plural}`
    : `Listed the ${input.plural}`;
}

/**
 * A tool this table does not know, named as readably as its id allows.
 *
 * A tool added later reads as "Read nodes" rather than as a blank row, which is
 * the failure this exists to avoid. Sentence case rather than `startCase`,
 * which would title-case it into "Read Nodes" and read as a heading beside the
 * rows around it.
 */
function unknownToolLabel(toolName: string): string {
  const words = toolName.replaceAll("_", " ").trim();
  return isBlank(words)
    ? "Called a tool"
    : words.charAt(0).toUpperCase() + words.slice(1);
}

/** The phrase the panel shows for one tool call. */
export function agentToolLabel(input: {
  readonly toolName: string;
  /** The arguments the model wrote, unnarrowed: nothing here trusts their shape. */
  readonly args: unknown;
}): string {
  const { toolName } = input;
  // One decode per row: `readJsonObject` walks the whole argument tree, and a
  // label reads up to three keys out of it.
  const args = readJsonObject(input.args);

  switch (toolName) {
    case "read_workflow":
      return "Read the workflow";

    case "read_nodes": {
      const total = count(args, "nodeIds");
      return total === undefined ? "Read the steps" : `Read ${steps(total)}`;
    }

    case "validate_workflow":
      return "Checked the workflow";

    case "list_actions":
      return catalogSearchLabel({ args, plural: "actions" });

    case "describe_action": {
      const actionId = text(args, "actionId");
      return actionId ? `Read the ${actionId} action` : "Read an action";
    }

    case "list_events":
      return catalogSearchLabel({ args, plural: "Events" });

    case "describe_event": {
      const eventName = text(args, "eventName");
      return eventName ? `Read the ${eventName} Event` : "Read an Event";
    }

    case "list_integrations":
      return "Listed the integrations";

    case "list_references": {
      // A read, so no server sentence follows it. The node is named by id
      // rather than label: this file holds no canvas, and the id is what the
      // model wrote.
      const nodeId = text(args, "nodeId") ?? "a step";
      const query = text(args, "query");
      if (query) {
        return `Searched what ${nodeId} can read for ${quoted(query)}`;
      }
      return `Read what ${nodeId} can reference`;
    }

    case "add_node": {
      const label = text(args, "label");
      return label ? `Adding ${label}` : "Adding a step";
    }

    case "update_node":
      return "Updating a step";

    case "delete_node":
      return "Deleting a step";

    case "connect_nodes":
      return "Connecting two steps";

    case "disconnect_nodes":
      return "Disconnecting two steps";

    case "insert_node_on_edge": {
      const label = text(args, "label");
      return label ? `Inserting ${label}` : "Inserting a step";
    }

    case "revert_draft":
      return "Undoing its edits";

    case "set_lifecycle_rules":
      return "Setting the Lifecycle Rules";

    case "set_condition":
      return "Setting a test";

    case "set_wait":
      return "Setting a wait";

    default:
      return unknownToolLabel(toolName);
  }
}
