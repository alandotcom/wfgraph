import { Effect } from "effect";
import { and, eq } from "drizzle-orm";
import type { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import { encodeJson } from "#src/backend/persistence/sqlite/database";
import {
  workflowExecutionEvents,
  workflowExecutions,
} from "#src/backend/persistence/sqlite/schema";
import { makeSqliteRunsMethods } from "#src/backend/persistence/sqlite/executions/runs";
import { makeSqliteNodeLogsMethods } from "#src/backend/persistence/sqlite/executions/logs";
import { makeSqliteWaitsMethods } from "#src/backend/persistence/sqlite/executions/waits";
import { makeSqliteAuditMethods } from "#src/backend/persistence/sqlite/executions/audit";
import { makeSqliteFencedWrites } from "#src/backend/persistence/sqlite/executions/fenced-writes";
import { makeSqliteExecutorStateMethods } from "#src/backend/persistence/sqlite/executions/executor-state";
import { makeSqliteClaimsMethods } from "#src/backend/persistence/sqlite/executions/claims";
import { makeSqliteInboxMethods } from "#src/backend/persistence/sqlite/executions/inbox";
import { makeSqliteRetentionMethods } from "#src/backend/persistence/sqlite/executions/retention";
import { makeSqliteCronMethods } from "#src/backend/persistence/sqlite/executions/cron";
import {
  makeSqlitePassWrites,
  makeSqliteScheduleMethods,
} from "#src/backend/persistence/sqlite/executions/schedule";
import {
  admitStart,
  findAdmissionRefusal,
  findStartRefusal,
} from "#src/backend/persistence/sqlite/executions/admission";
import { deleteWorkflowHistory } from "#src/backend/persistence/sqlite/executions/history";

export function makeSqliteExecutionRepo(
  store: SqliteDatabase
): ExecutionRepo["Service"] {
  return {
    ...makeSqliteRunsMethods(store),
    ...makeSqliteNodeLogsMethods(store),
    ...makeSqliteWaitsMethods(store),
    ...makeSqliteAuditMethods(store),
    ...makeSqliteScheduleMethods(store),
    ...makeSqliteExecutorStateMethods(store),
    ...makeSqliteClaimsMethods(store),
    ...makeSqliteInboxMethods(store),
    ...makeSqliteRetentionMethods(store),
    ...makeSqliteCronMethods(store),
    fenced: makeSqliteFencedWrites(store),
    fencedPass: (fence) => makeSqlitePassWrites(store, fence),
    startForEntity: (input) =>
      store.write((database) => admitStart(database, input)),
    findAdmissionRefusal: (input) =>
      store.read((database) => findStartRefusal(database, input)),
    recordAdmissionRefusal: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const existingExecution = yield* database
            .select({ id: workflowExecutions.id })
            .from(workflowExecutions)
            .where(
              and(
                eq(workflowExecutions.workflowId, input.workflowId),
                eq(workflowExecutions.deliveryId, input.deliveryId)
              )
            )
            .get();
          if (existingExecution) {
            return {
              kind: "started" as const,
              executionId: existingExecution.id,
            };
          }

          const existingRefusal = yield* findAdmissionRefusal(database, {
            workflowId: input.workflowId,
            decisionId: input.decisionId,
          });
          if (existingRefusal) {
            return { kind: "refused" as const, reason: existingRefusal };
          }

          yield* database.insert(workflowExecutionEvents).values({
            id: input.decisionId,
            workflowId: input.workflowId,
            executionId: null,
            eventType: "run_refused",
            message: input.message,
            metadata: encodeJson({
              ...input.metadata,
              deliveryId: input.deliveryId,
            }),
            createdAt: Date.now(),
          });
          return { kind: "refused" as const, reason: input.reason };
        })
      ),
    deleteAllForWorkflow: (workflowId) =>
      deleteWorkflowHistory(store, workflowId),
  };
}
