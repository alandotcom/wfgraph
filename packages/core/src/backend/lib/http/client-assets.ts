/**
 * Serving the workflow-builder SPA and its assets off disk.
 *
 * The client is a single-page app: a handful of real files under a client
 * directory, plus a set of routes that have no file behind them and have to
 * fall back to index.html so the router in the browser can take over.
 */

import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, posix } from "node:path";
import { rewriteClientBaseHref } from "#src/backend/lib/http/mount-path";
import { getAppLogger } from "#src/backend/lib/logger";

const clientLogger = getAppLogger("http", "client");

const CONTENT_TYPE_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const CLIENT_ENTRY_FILE = "index.html";

// Paths the browser router owns. They carry no file, so they get index.html.
// The list mirrors the routes declared in packages/client/src/router.tsx, which
// is where a new page is added; the two have to agree or a route the browser
// knows would 404 on a fresh page load.
const SPA_PATHS = new Set(["/", "/workflows"]);

function getContentType(filePath: string): string {
  return (
    CONTENT_TYPE_MAP[extname(filePath).toLowerCase()] ??
    "application/octet-stream"
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * True for a path the browser router owns, so the answer is index.html rather
 * than a file lookup.
 *
 * Workflow Graph is the only place this rule is applied. Development serves the editor
 * from Vite's own dev server, whose history fallback answers a page view
 * without asking anything here, so the rule has one implementation and one
 * caller.
 */
function isSpaPath(pathname: string): boolean {
  return SPA_PATHS.has(pathname) || pathname.startsWith("/workflows/");
}

/**
 * Map a request path onto a file inside the client directory, or null when it
 * points outside. Both the URL-decoded path and the joined result are checked,
 * so neither an encoded `..` nor a symlink-free escape gets through.
 */
function resolveClientAssetPath(
  clientDir: string,
  pathname: string
): string | null {
  if (pathname === "/") {
    return null;
  }

  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relativePath = decoded.startsWith("/") ? decoded.slice(1) : decoded;
  if (!relativePath) {
    return null;
  }

  const normalized = posix.normalize(relativePath);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return null;
  }

  const resolved = join(clientDir, normalized);
  if (!normalize(resolved).startsWith(normalize(clientDir))) {
    return null;
  }

  return resolved;
}

export type ServeClientAssetOptions = {
  clientDir: string;
  /** Mount prefix, "" for the root. Reaches the browser via `<base href>`. */
  basePath: string;
  /** Request path relative to the mount point, so always leading-slashed. */
  pathname: string;
};

export async function serveClientAsset(
  options: ServeClientAssetOptions
): Promise<Response> {
  const { clientDir, basePath, pathname } = options;

  if (!isSpaPath(pathname)) {
    const assetPath = resolveClientAssetPath(clientDir, pathname);
    if (assetPath && (await fileExists(assetPath))) {
      const content = await readFile(assetPath);
      return new Response(content, {
        headers: { "content-type": getContentType(assetPath) },
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const indexPath = join(clientDir, CLIENT_ENTRY_FILE);
  if (!(await fileExists(indexPath))) {
    // Name the directory that was searched, since "build the client" is only
    // actionable once an operator knows where the server expected to find it.
    clientLogger.error("Client bundle entrypoint is missing", { indexPath });
    return Response.json(
      { error: `Client bundle is missing its entrypoint at ${indexPath}.` },
      { status: 503 }
    );
  }

  const html = await readFile(indexPath, "utf-8");
  const rewritten = rewriteClientBaseHref(html, basePath);
  if (rewritten === null) {
    clientLogger.error("Client bundle has no <base> tag", { indexPath });
    return Response.json(
      {
        error:
          "Client bundle has no <base> tag, so the browser cannot resolve its own URLs. Rebuild the client.",
      },
      { status: 503 }
    );
  }

  return new Response(rewritten, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
