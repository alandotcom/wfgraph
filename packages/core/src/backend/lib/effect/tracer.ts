import { Layer } from "effect";
import { trace } from "@opentelemetry/api";
// By subpath, because the package's own entry re-exports OtelLogger, which
// imports @opentelemetry/sdk-logs at module scope. Workflow Graph does not
// install it: the SDK is the host's.
import * as OtelTracer from "@effect/opentelemetry/OtelTracer";
import { TRACER_NAME, TRACER_VERSION } from "#src/backend/lib/telemetry";

/**
 * Effect's spans, sent to whichever OpenTelemetry provider the host registered.
 *
 * Every `Effect.fn("name")` across the services and every engine
 * `Effect.withSpan` opens on Effect's tracer. Replacing the `Tracer` reference
 * for the whole Layer graph is what exports them in one trace tree.
 *
 * Workflow Graph starts no SDK, exporter or processor. What this reads is the global proxy
 * provider `@opentelemetry/api` always answers with, and that proxy resolves its
 * delegate once per span: a host registering after Workflow Graph has booted is still
 * traced, and a host registering nothing gets no-op spans.
 */
export const TracerBridgeLayer: Layer.Layer<never> =
  OtelTracer.layerWithoutOtelTracer.pipe(
    Layer.provide(
      Layer.sync(OtelTracer.OtelTracer, () =>
        trace.getTracer(TRACER_NAME, TRACER_VERSION)
      )
    )
  );
