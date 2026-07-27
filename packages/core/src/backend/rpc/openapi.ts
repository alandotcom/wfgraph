import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import type { RpcContext } from "./context";
import { rpcRouter } from "./router";

export const openApiRestHandler = new OpenAPIHandler<RpcContext>(rpcRouter);

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
  return new OpenAPIHandler<RpcContext>(rpcRouter, {
    plugins: [
      new OpenAPIReferencePlugin<RpcContext>({
        schemaConverters: [new ZodToJsonSchemaConverter()],
        specPath: "/openapi.json",
        docsPath: "/docs",
        docsProvider: "scalar",
        docsTitle: "Workflow API Docs",
        specGenerateOptions: {
          info: {
            title: "Workflow API",
            version: "0.1.0",
            description: "OpenAPI specification generated from oRPC contracts.",
          },
          servers: [{ url: restBasePath }],
        },
      }),
    ],
  });
}
