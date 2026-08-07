/**
 * The instrumentation scope every Workflow Graph span arrives under: the engine's own,
 * and the service spans `effect/tracer.ts` bridges. One scope is what lets a
 * reader of the trace treat both halves as one library.
 */
export const TRACER_NAME = "wfgraph-workflows";
export const TRACER_VERSION = "0.1.0";
