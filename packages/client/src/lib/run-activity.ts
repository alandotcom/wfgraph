/**
 * A run's activity entry in the words the Runs view uses elsewhere. The server
 * stores each entry with a sentence written when it happened, and some of
 * those sentences use engine terms ("delay node", "completed with errors",
 * "real recipients"). The entries a run always has are reworded here from
 * their type and the run; any other entry keeps its stored sentence.
 */

import { isJsonObject, readJsonValue } from "@wfgraph/shared/types/json";
import type {
  ExecutionEvent,
  WorkflowExecution,
} from "#src/lib/execution-logs";

export function runActivitySentence(input: {
  event: Pick<ExecutionEvent, "eventType" | "message" | "metadata">;
  run: Pick<WorkflowExecution, "startSource" | "startEventName">;
  /** The label the editor gives an Event name. */
  eventLabel: (eventName: string) => string;
  /** The name of a node in the run, or null when the run cannot name it. */
  nodeName: (nodeId: string) => string | null;
}): string {
  const { event, run } = input;
  switch (event.eventType) {
    case "run_started":
      if (run.startSource === "event" && run.startEventName) {
        return `Started by ${input.eventLabel(run.startEventName)}`;
      }
      if (run.startSource === "schedule") {
        return "Started by its schedule";
      }
      return run.startSource === "manual" ? "Started manually" : event.message;
    case "run_completed":
      return "Run completed";
    case "run_failed":
      return "Run failed";
    case "run_waiting": {
      const metadata = readJsonValue(event.metadata);
      const nodeId =
        isJsonObject(metadata) && typeof metadata.nodeId === "string"
          ? metadata.nodeId
          : null;
      const name = nodeId === null ? null : input.nodeName(nodeId);
      return name === null ? event.message : `Waiting at ${name}`;
    }
    default:
      return event.message;
  }
}
