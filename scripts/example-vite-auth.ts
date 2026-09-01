import type { Plugin } from "vite";

/**
 * Protects the example app's Vite history fallback with the host's demo session.
 * The production client bundle has no Vite server, so this plugin belongs to the
 * development harness rather than the client package.
 */
export function exampleAuthGuard(appOrigin: string): Plugin {
  return {
    name: "wfgraph-example-auth",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost")
          .pathname;
        const isSpaNavigation =
          request.method === "GET" &&
          (request.headers.accept ?? "").includes("text/html") &&
          (pathname === "/" ||
            pathname === "/workflows" ||
            pathname.startsWith("/workflows/"));
        if (!isSpaNavigation) {
          next();
          return;
        }

        try {
          const session = await fetch(`${appOrigin}/login/session`, {
            headers: request.headers.cookie
              ? { cookie: request.headers.cookie }
              : {},
          });
          if (session.status === 401) {
            response.statusCode = 302;
            response.setHeader("Location", "/login");
            response.end();
            return;
          }
        } catch {
          // Let Vite answer while the app starts; its API failure screen remains
          // more useful than turning a transient startup race into a redirect.
        }
        next();
      });
    },
  };
}
