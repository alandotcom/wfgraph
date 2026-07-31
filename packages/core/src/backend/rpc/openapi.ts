import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferenceHandlerPlugin } from "@orpc/openapi/plugins";
import { EffectSchemaToJsonSchemaConverter } from "@orpc/experimental-effect";
import type { RpcContext } from "#src/backend/rpc/context";
import { rpcRouter } from "#src/backend/rpc/router";

export const openApiRestHandler = new OpenAPIHandler<RpcContext>(rpcRouter);

/**
 * Turns the contract's Effect schemas into the JSON Schemas the document needs.
 * The converter recognises a schema by its Standard Schema vendor, which is why
 * the contracts hand oRPC the bridged schema rather than a plain validator. The
 * generator holds no request state, so one instance serves every handler built
 * below.
 */
const openApiGenerator = new OpenAPIGenerator({
  converters: [new EffectSchemaToJsonSchemaConverter()],
});

/**
 * Build the handler behind `/openapi.json` and `/docs`.
 *
 * This is a factory rather than a module-level singleton because the spec has to
 * advertise the REST base URL, and that is only known once the host has said
 * where it mounted Rova. A hardcoded "/api/rest" sent every generated client and
 * every "Try it" button in the docs panel to a path that 404s under a sub-path
 * mount.
 */
export function createOpenApiReferenceHandler(
  restBasePath: `/${string}`
): OpenAPIHandler<RpcContext> {
  // The reference plugin re-evaluates `spec` on every /openapi.json and /docs
  // request, so handing it a thunk would re-run the full schema-to-JSON-Schema
  // conversion per hit.
  const document = openApiGenerator.generate(rpcRouter, {
    base: {
      info: {
        title: "Workflow API",
        version: "0.1.0",
        description: "OpenAPI specification generated from oRPC contracts.",
      },
      servers: [{ url: restBasePath }],
    },
  });

  return new OpenAPIHandler<RpcContext>(rpcRouter, {
    plugins: [
      new OpenAPIReferenceHandlerPlugin<RpcContext, "scalar">({
        spec: document,
        specPath: "/openapi.json",
        docsPath: "/docs",
        provider: "scalar",
        docsTitle: "Workflow API Docs",
      }),
    ],
  });
}
