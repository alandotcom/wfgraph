/**
 * Whether a browser request that another site started should be refused.
 *
 * A browser attaches the host's session cookie to a form posted from a sibling
 * subdomain, and from any site when the cookie is `SameSite=None`, so an
 * operator write cannot rest on the cookie alone. A request whose
 * `Sec-Fetch-Site` is `cross-site` or `same-site` is refused unless its
 * `Origin` is one of `allowedOrigins`. A request carrying `Origin` but no
 * `Sec-Fetch-Site`, which is an older browser, is held to the same origin
 * list. A request carrying neither header comes from no browser and passes,
 * as does every `GET`, `HEAD` and `OPTIONS`.
 */
export function isCrossSiteWrite(
  request: Request,
  allowedOrigins: readonly string[]
): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) {
    return false;
  }
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") {
    return false;
  }
  const origin = request.headers.get("origin");
  if (origin !== null && allowedOrigins.includes(origin)) {
    return false;
  }
  if (site === "cross-site" || site === "same-site") {
    return true;
  }
  return site === null && origin !== null;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** The answer a refused cross-site write gets. */
export const CROSS_SITE_BODY = {
  error: "Cross-site request refused",
} as const;
