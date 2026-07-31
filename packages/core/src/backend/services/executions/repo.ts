/**
 * The `ExecutionRepo` aggregate: the service, its layer, and the contracts it
 * answers with. A caller after one slice's own mechanics (runs, waits,
 * node-logs, audit) may still import that file under `repo/` directly.
 */
export * from "#src/backend/services/executions/repo/index";
