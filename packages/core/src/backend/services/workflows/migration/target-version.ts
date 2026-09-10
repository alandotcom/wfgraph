/**
 * Resolves the version a Migration moves runs onto.
 *
 * The target defaults to the workflow's current publication. A version named by
 * the caller has to be a published version of that same workflow, because a
 * draft snapshot belongs to the one run that froze it.
 */

import { Effect } from "effect";
import { InvalidInput, NotFound } from "#src/backend/lib/effect/failures";
import {
  asPublishedVersion,
  WorkflowRepo,
} from "#src/backend/services/workflows/repo";

export const resolveTargetVersion = Effect.fn("resolveTargetVersion")(
  function* (input: {
    workflowId: string;
    targetVersionId?: string | undefined;
  }) {
    const repo = yield* WorkflowRepo;

    // One read of the workflow, without its draft graph, carrying the version
    // its published pointer names. That pointer is the default target, and its
    // absence is what tells an unpublished workflow from a missing one.
    const found = yield* repo.findByIdWithPublishedVersionForRun(
      input.workflowId
    );
    if (!found) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    if (input.targetVersionId === undefined) {
      if (!found.publishedVersion) {
        return yield* new NotFound({
          error: "This workflow has no published version",
        });
      }
      return found.publishedVersion;
    }

    const version = yield* repo.findVersionById(input.targetVersionId);
    if (!version) {
      return yield* new NotFound({ error: "Workflow version not found" });
    }
    if (version.workflowId !== input.workflowId) {
      return yield* new InvalidInput({
        error: "That version belongs to another workflow",
      });
    }

    const published = asPublishedVersion(version);
    if (!published) {
      return yield* new InvalidInput({
        error: "A run can only be migrated onto a published version",
      });
    }

    return published;
  }
);
