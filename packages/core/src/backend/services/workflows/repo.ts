import { and, desc, eq, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  type Workflow,
  type WorkflowMode,
  type WorkflowVisibility,
  workflows,
} from "#src/backend/lib/db/schema";
import { Database, type DatabaseError } from "#src/backend/lib/effect/database";
import { CURRENT_WORKFLOW_NAME } from "#src/backend/lib/workflow-constants";
import type { WorkflowUpdateData } from "#src/backend/services/workflows/mappers";
import type { SerializedWorkflowGraph } from "@rova/shared/workflow/types";

/**
 * Every database question the workflow services ask about workflows themselves.
 *
 * The domain code above it never names a table or a column, which is what lets a
 * test answer these directly instead of standing up a database, and a query
 * failure arrives as a typed `DatabaseError` rather than a rejected promise, the
 * way ADR-0005 describes.
 *
 * These write their own Drizzle against the handle the `Database` service owns,
 * as the API key repository does, because no `backend/lib/db` module holds the
 * workflow queries.
 */
export class WorkflowRepo extends Context.Service<
  WorkflowRepo,
  {
    /** Most recently updated first, which is the order the list screen shows. */
    readonly listNewestFirst: () => Effect.Effect<Workflow[], DatabaseError>;
    readonly findById: (
      workflowId: string
    ) => Effect.Effect<Workflow | null, DatabaseError>;
    /**
     * Whether the workflow is there at all. Separate from `findById` because the
     * paths that only need to answer "not found" have no use for a graph column
     * that can run to megabytes.
     */
    readonly existsById: (
      workflowId: string
    ) => Effect.Effect<boolean, DatabaseError>;
    /**
     * Whether any workflow already holds this name, compared the way the unique
     * index does, which is case-insensitively.
     */
    readonly hasWithName: (
      name: string
    ) => Effect.Effect<boolean, DatabaseError>;
    /** The same question asked from a workflow that may legally hold the name. */
    readonly hasOtherWithName: (input: {
      name: string;
      excludingWorkflowId: string;
    }) => Effect.Effect<boolean, DatabaseError>;
    /**
     * Store a new workflow. `mode` and `visibility` are left to their column
     * defaults unless a caller carries them over from a source workflow, which
     * duplication does and creation does not.
     */
    readonly insert: (input: {
      id: string;
      name: string;
      description?: string | null;
      graph: SerializedWorkflowGraph;
      mode?: WorkflowMode;
      visibility?: WorkflowVisibility;
    }) => Effect.Effect<Workflow, DatabaseError>;
    /**
     * Whether the workflow is paused, or null when it is gone. The bulk
     * lifecycle path reads this before writing so that a pause that changes
     * nothing costs no update.
     */
    readonly findPausedById: (
      workflowId: string
    ) => Effect.Effect<{ id: string; isPaused: boolean } | null, DatabaseError>;
    readonly setPaused: (input: {
      workflowId: string;
      isPaused: boolean;
    }) => Effect.Effect<void, DatabaseError>;
    /** Null when the row was gone by the time the update ran. */
    readonly update: (
      workflowId: string,
      updates: WorkflowUpdateData
    ) => Effect.Effect<Workflow | null, DatabaseError>;
    readonly deleteById: (
      workflowId: string
    ) => Effect.Effect<void, DatabaseError>;
    /**
     * The single workflow the editor autosaves into, newest first because the
     * name is only unique through an index the autosave path predates.
     */
    readonly findCurrent: () => Effect.Effect<Workflow | null, DatabaseError>;
    readonly insertCurrent: (input: {
      id: string;
      graph: SerializedWorkflowGraph;
    }) => Effect.Effect<Workflow | null, DatabaseError>;
  }
>()("WorkflowRepo") {}

export const WorkflowRepoLayer: Layer.Layer<WorkflowRepo, never, Database> =
  Layer.effect(
    WorkflowRepo,
    Effect.gen(function* () {
      const database = yield* Database;

      const findCurrent = () =>
        database.query(async (db) => {
          const [currentWorkflow] = await db
            .select()
            .from(workflows)
            .where(eq(workflows.name, CURRENT_WORKFLOW_NAME))
            .orderBy(desc(workflows.updatedAt))
            .limit(1);

          return currentWorkflow ?? null;
        });

      return {
        listNewestFirst: () =>
          database.query((db) =>
            db.select().from(workflows).orderBy(desc(workflows.updatedAt))
          ),

        findById: (workflowId) =>
          database.query(async (db) => {
            const workflow = await db.query.workflows.findFirst({
              where: eq(workflows.id, workflowId),
            });

            return workflow ?? null;
          }),

        existsById: (workflowId) =>
          database.query(async (db) => {
            const workflow = await db.query.workflows.findFirst({
              where: eq(workflows.id, workflowId),
              columns: { id: true },
            });

            return workflow !== undefined;
          }),

        hasWithName: (name) =>
          database.query(async (db) => {
            const conflict = await db.query.workflows.findFirst({
              where: sql`lower(${workflows.name}) = lower(${name})`,
              columns: { id: true },
            });

            return conflict !== undefined;
          }),

        hasOtherWithName: (input) =>
          database.query(async (db) => {
            const conflict = await db.query.workflows.findFirst({
              where: and(
                sql`lower(${workflows.name}) = lower(${input.name})`,
                ne(workflows.id, input.excludingWorkflowId)
              ),
              columns: { id: true },
            });

            return conflict !== undefined;
          }),

        insert: (input) =>
          database.query(async (db) => {
            const [inserted] = await db
              .insert(workflows)
              .values({
                id: input.id,
                name: input.name,
                description: input.description,
                graph: input.graph,
                mode: input.mode,
                visibility: input.visibility,
              })
              .returning();

            return inserted;
          }),

        findPausedById: (workflowId) =>
          database.query(async (db) => {
            const workflow = await db.query.workflows.findFirst({
              where: eq(workflows.id, workflowId),
              columns: { id: true, isPaused: true },
            });

            return workflow ?? null;
          }),

        setPaused: (input) =>
          database.query(async (db) => {
            await db
              .update(workflows)
              .set({ isPaused: input.isPaused, updatedAt: new Date() })
              .where(eq(workflows.id, input.workflowId));
          }),

        update: (workflowId, updates) =>
          database.query(async (db) => {
            const updated = await db
              .update(workflows)
              .set(updates)
              .where(eq(workflows.id, workflowId))
              .returning();

            return updated.at(0) ?? null;
          }),

        deleteById: (workflowId) =>
          database.query(async (db) => {
            await db.delete(workflows).where(eq(workflows.id, workflowId));
          }),

        findCurrent,

        insertCurrent: (input) =>
          database.query(async (db) => {
            const saved = await db
              .insert(workflows)
              .values({
                id: input.id,
                name: CURRENT_WORKFLOW_NAME,
                description: "Auto-saved current workflow",
                graph: input.graph,
              })
              .returning();

            return saved.at(0) ?? null;
          }),
      };
    })
  );
