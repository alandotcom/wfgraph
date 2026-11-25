/**
 * `workflows` on what `createWfGraphApp` and `createWfGraphRunner` answer:
 * reads of saved workflows for a host's own server code that apply no `auth`.
 * Each rejects with an `Error` whose `cause` holds the storage failure or the
 * defect, such as a read after dispose, and no message quotes a stored value.
 */

import { Exit } from "effect";
import { hostRejection } from "#src/backend/host-rejection";
import type { WfGraphRuntime } from "#src/backend/runtime";
import {
  readDraftNode,
  type WfGraphDraftNode,
} from "#src/backend/services/workflows/draft-node";

export type {
  WfGraphDraftField,
  WfGraphDraftNode,
  WfGraphDraftReferenceSource,
  WfGraphDraftRow,
  WfGraphDraftSegment,
} from "#src/backend/services/workflows/draft-node";

export type WfGraphWorkflows = {
  /**
   * One node of a workflow's saved draft. For a node running a host action,
   * `fields` holds each declared input the node stores, read the way the
   * engine reads it, with templates as text and references; any other node
   * answers no fields. Answers null when the workflow or the node does not
   * exist. Reads what the last save stored, so an edit the editor has not
   * saved yet is missing.
   *
   * Applies no `auth`, and the editor shows an Action Link to every reader,
   * viewers included. A host calls it only after authorizing the request it
   * serves, or its page hands any visitor the draft of every workflow whose
   * ids they can guess.
   */
  readDraftNode: (input: {
    workflowId: string;
    nodeId: string;
  }) => Promise<WfGraphDraftNode | null>;
};

/** The host's workflow reads over `runtime`. */
export function createHostWorkflows(runtime: WfGraphRuntime): WfGraphWorkflows {
  return {
    readDraftNode: async (input) => {
      const exit = await runtime.runPromiseExit(readDraftNode(input));
      if (Exit.isSuccess(exit)) return exit.value;
      throw hostRejection(exit.cause, "Could not read the draft node");
    },
  };
}
