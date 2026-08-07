import { Layer } from "effect";
// By subpath, because the package's own entry re-exports NodeSdk and WebSdk,
// which import @opentelemetry/sdk-trace-node and -web at module scope. Workflow Graph
// installs neither: the SDK is the host's.
import * as OtelTracer from "@effect/opentelemetry/OtelTracer";
import * as Resource from "@effect/opentelemetry/Resource";
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
    Layer.provide(OtelTracer.layerGlobalTracer),
    // The Resource is read for `service.name` and `service.version` alone, which
    // name the instrumentation scope. What describes the service itself is the
    // host's own Resource, carried by the provider.
    Layer.provide(
      Resource.layer({
        serviceName: TRACER_NAME,
        serviceVersion: TRACER_VERSION,
      })
    )
  );
