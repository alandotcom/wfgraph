import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import type { RpcContext } from "./context";
import { rpcRouter } from "./router";

const openApiReferencePlugin = new OpenAPIReferencePlugin<RpcContext>({
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
    servers: [{ url: "/api/rest" }],
  },
});

export const openApiRestHandler = new OpenAPIHandler<RpcContext>(rpcRouter);
export const openApiReferenceHandler = new OpenAPIHandler<RpcContext>(
  rpcRouter,
  {
    plugins: [openApiReferencePlugin],
  }
);
