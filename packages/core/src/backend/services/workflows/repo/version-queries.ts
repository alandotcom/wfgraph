import { and, count, desc, eq, inArray, lt, min, or, sql } from "drizzle-orm";
import type { Database } from "#src/backend/lib/effect/database";
import {
  workflowExecutions,
  workflowVersions,
  workflows,
} from "#src/backend/lib/db/schema";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import { workflowVersionUsageRow } from "#src/backend/services/workflows/repo/version-row";

/** A null here means a published-only query accidentally returned a snapshot. */
function publishedVersionNumber(value: number | null): number {
  if (value === null) {
    throw new Error("A published workflow version carries no version number");
  }
  return value;
}

/** The immutable-version reads belonging to the PostgreSQL workflow repository. */
export function makeWorkflowVersionQueries(database: Database["Service"]) {
  return {
    findLatestVersion: (workflowId: string) =>
      database.query(async (db) => {
        const [row] = await db
          .select({ version: workflowVersions.version })
          .from(workflowVersions)
          .where(
            and(
              eq(workflowVersions.workflowId, workflowId),
              eq(workflowVersions.kind, "published")
            )
          )
          .orderBy(desc(workflowVersions.version))
          .limit(1);

        return row ? { version: publishedVersionNumber(row.version) } : null;
      }),

    listVersionHistoryPage: (input: {
      workflowId: string;
      limit: number;
      cursor?: { version: number };
    }) =>
      database.query(async (db) => {
        const rows = await db
          .select({
            id: workflowVersions.id,
            version: workflowVersions.version,
            publishedAt: workflowVersions.publishedAt,
            isCurrent: sql<boolean>`${workflows.id} is not null`,
          })
          .from(workflowVersions)
          .leftJoin(
            workflows,
            and(
              eq(workflows.id, input.workflowId),
              eq(workflows.publishedVersionId, workflowVersions.id)
            )
          )
          .where(
            and(
              eq(workflowVersions.workflowId, input.workflowId),
              eq(workflowVersions.kind, "published"),
              input.cursor
                ? lt(workflowVersions.version, input.cursor.version)
                : undefined
            )
          )
          .orderBy(desc(workflowVersions.version))
          .limit(input.limit + 1);

        return rows.map((row) => ({
          ...row,
          version: publishedVersionNumber(row.version),
        }));
      }),

    listVersionUsage: (workflowId: string) =>
      database.query((db) => {
        const activeVersions = db
          .select({
            versionId: workflowExecutions.workflowVersionId,
            activeRunCount: count(workflowExecutions.id).as("active_run_count"),
            oldestActiveRunAt: min(workflowExecutions.startedAt).as(
              "oldest_active_run_at"
            ),
          })
          .from(workflowExecutions)
          .where(
            and(
              eq(workflowExecutions.workflowId, workflowId),
              inArray(workflowExecutions.status, [
                ...IN_FLIGHT_EXECUTION_STATUSES,
              ])
            )
          )
          .groupBy(workflowExecutions.workflowVersionId)
          .as("active_version_usage");
        // `published_version_id` is null before the first publish. SQL equality
        // would then produce null rather than the boolean the repository promises.
        const isCurrent = sql<boolean>`coalesce(${workflowVersions.id} = ${workflows.publishedVersionId}, false)`;

        return db
          .select({
            id: workflowVersions.id,
            kind: workflowVersions.kind,
            version: workflowVersions.version,
            graph: workflowVersions.graph,
            catalogFingerprint: workflowVersions.catalogFingerprint,
            publishedAt: workflowVersions.publishedAt,
            isCurrent,
            activeRunCount: sql<number>`coalesce(${activeVersions.activeRunCount}, 0)::int`,
            oldestActiveRunAt: activeVersions.oldestActiveRunAt,
          })
          .from(workflowVersions)
          .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
          .leftJoin(
            activeVersions,
            eq(activeVersions.versionId, workflowVersions.id)
          )
          .where(
            and(
              eq(workflowVersions.workflowId, workflowId),
              or(
                eq(workflowVersions.id, workflows.publishedVersionId),
                sql`${activeVersions.versionId} is not null`
              )
            )
          )
          .orderBy(
            desc(isCurrent),
            sql`case when ${workflowVersions.kind} = 'published' then ${workflowVersions.version} end desc nulls last`,
            sql`case when ${workflowVersions.kind} = 'draft_snapshot' then ${workflowVersions.publishedAt} end desc nulls last`,
            sql`case when ${workflowVersions.kind} = 'draft_snapshot' then ${workflowVersions.id} end desc nulls last`
          )
          .then((rows) => rows.map(workflowVersionUsageRow));
      }),
  };
}
