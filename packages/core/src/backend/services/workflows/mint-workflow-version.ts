/**
 * Optimistic mint of the next workflow version number.
 *
 * The unique index on `(workflow_id, version)` is the condition: claim
 * latest+1 with on-conflict-do-nothing; on a miss we are behind — reuse
 * matching content or take the next free number. Contention is assumed rare.
 */

import { and, desc, eq } from "drizzle-orm";
import type { RovaDatabase, RovaTransaction } from "#src/backend/lib/db/index";
import {
  type WorkflowVersion,
  workflowVersions,
} from "#src/backend/lib/db/schema";
import type { SerializedWorkflowGraph } from "@rova/shared/graph/types";

export type MintWorkflowVersionInput = {
  workflowId: string;
  versionId: string;
  graph: SerializedWorkflowGraph;
  catalogFingerprint: string;
  graphDigest: string;
};

type Tx = RovaDatabase | RovaTransaction;

async function findVersionByContent(
  tx: Tx,
  input: MintWorkflowVersionInput
): Promise<WorkflowVersion | null> {
  const [row] = await tx
    .select()
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workflowId, input.workflowId),
        eq(workflowVersions.graphDigest, input.graphDigest),
        eq(workflowVersions.catalogFingerprint, input.catalogFingerprint)
      )
    )
    .orderBy(desc(workflowVersions.version))
    .limit(1);
  return row ?? null;
}

async function findLatestVersionNumber(
  tx: Tx,
  workflowId: string
): Promise<number> {
  const [latest] = await tx
    .select({ version: workflowVersions.version })
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, workflowId))
    .orderBy(desc(workflowVersions.version))
    .limit(1);
  return latest?.version ?? 0;
}

async function tryClaim(
  tx: Tx,
  input: MintWorkflowVersionInput,
  version: number
): Promise<WorkflowVersion | null> {
  const [claimed] = await tx
    .insert(workflowVersions)
    .values({
      id: input.versionId,
      workflowId: input.workflowId,
      version,
      graph: input.graph,
      catalogFingerprint: input.catalogFingerprint,
      graphDigest: input.graphDigest,
    })
    .onConflictDoNothing({
      target: [workflowVersions.workflowId, workflowVersions.version],
    })
    .returning();
  return claimed ?? null;
}

/**
 * Reuse a content match when one exists, otherwise claim the next free version
 * number. Every insert is conditioned on the unique index; a conflict means we
 * are behind and the caller retries once.
 */
export async function mintWorkflowVersion(
  tx: Tx,
  input: MintWorkflowVersionInput
): Promise<WorkflowVersion> {
  const existing = await findVersionByContent(tx, input);
  if (existing) {
    return existing;
  }

  const first = await tryClaim(
    tx,
    input,
    (await findLatestVersionNumber(tx, input.workflowId)) + 1
  );
  if (first) {
    return first;
  }

  const reused = await findVersionByContent(tx, input);
  if (reused) {
    return reused;
  }

  const second = await tryClaim(
    tx,
    input,
    (await findLatestVersionNumber(tx, input.workflowId)) + 1
  );
  if (second) {
    return second;
  }

  const reusedAgain = await findVersionByContent(tx, input);
  if (reusedAgain) {
    return reusedAgain;
  }

  throw new Error("workflow version mint exhausted retries");
}
