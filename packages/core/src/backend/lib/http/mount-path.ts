/**
 * Path arithmetic for a Rova app mounted somewhere other than the root.
 *
 * The host tells `createRovaApp` where it mounted us via `basePath`, and every
 * URL Rova builds or matches is derived from that one answer. Rova used to
 * deduce the mount point per request by subtracting Hono's local path from the
 * full URL, which silently produced the wrong prefix under any host that
 * rewrites the request URL on mount (Express `app.use("/rova", ...)` does).
 */

// A mount path travels into URLs and into a filesystem join, so it is kept to
// characters that are inert in both.
const SAFE_PATH_RE = /^[a-zA-Z0-9/_.-]*$/;
const TRAILING_SLASHES_RE = /\/+$/;
// Matches the SPA's `<base>` tag in whatever form the client bundler emitted it.
// Bun's HTML bundler writes `<base href="/" />`, so an exact-string replace of
// `<base href="/">` matched nothing and a sub-path mount was silently served a
// client that built every URL from the root.
const CLIENT_BASE_TAG_RE = /<base\b[^>]*>/i;

/**
 * Turn a host-supplied mount path into the prefix every Rova URL is built from:
 * the empty string when Rova owns the root, otherwise a leading slash with no
 * trailing one, as in "/workflows".
 */
export function normalizeBasePath(basePath: string): "" | `/${string}` {
  const trimmed = basePath.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(
    TRAILING_SLASHES_RE,
    ""
  );

  if (
    withoutTrailingSlash.length < 2 ||
    !SAFE_PATH_RE.test(withoutTrailingSlash) ||
    withoutTrailingSlash.includes("//") ||
    withoutTrailingSlash.includes("..")
  ) {
    throw new Error(
      `createRovaApp received an unusable basePath: ${JSON.stringify(basePath)}. Use an absolute path such as "/workflows".`
    );
  }

  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the leading slash is added above and survives the trailing-slash trim
  return withoutTrailingSlash as `/${string}`;
}

/**
 * Strip the mount prefix off an incoming pathname, so the routing that follows
 * only reasons about paths relative to Rova. Null means the request landed
 * outside the mount entirely.
 */
export function toMountRelativePath(
  pathname: string,
  basePath: string
): string | null {
  if (!basePath) {
    return pathname;
  }
  if (pathname === basePath) {
    return "/";
  }
  if (pathname.startsWith(`${basePath}/`)) {
    return pathname.slice(basePath.length);
  }
  return null;
}

/**
 * Point the SPA's `<base href>` at the mount point.
 *
 * The client reads this tag back to build its own asset and RPC URLs
 * (`client/lib/base-path.ts`), so this is the one channel the mount point
 * travels to the browser through. Null means the bundle carries no `<base>`
 * tag, which leaves the browser with no way to learn where Rova is mounted.
 */
export function rewriteClientBaseHref(
  html: string,
  basePath: string
): string | null {
  if (!CLIENT_BASE_TAG_RE.test(html)) {
    return null;
  }

  return html.replace(CLIENT_BASE_TAG_RE, `<base href="${basePath}/" />`);
}
