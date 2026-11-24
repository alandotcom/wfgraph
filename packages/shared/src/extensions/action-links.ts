/**
 * Action Links: pages of the host's own that a host action names for the
 * editor to link to from Canvas Reveal, at Browse and at Focus.
 *
 * `defineAction` checks each link's URL with `actionLinkUrlProblem` when the
 * host declares it. The editor fills the URL's placeholders when it draws the
 * link. Workflow Graph never requests the URL itself.
 */

/**
 * One link a host action declares. `url` may hold the placeholders
 * `{workflowId}` and `{nodeId}`.
 */
export type ActionLink = {
  readonly label: string;
  readonly url: string;
};

/**
 * The placeholders an Action Link's URL may hold, each paired with the id the
 * editor writes in its place: the open workflow's id for `{workflowId}` and
 * the selected node's id for `{nodeId}`.
 */
const ACTION_LINK_PLACEHOLDERS = [
  ["{workflowId}", "workflowId"],
  ["{nodeId}", "nodeId"],
] as const;

/**
 * What `actionLinkUrlProblem` writes in place of every placeholder before it
 * parses a URL. It is lower-case letters, which a URL parser keeps as they
 * are in a host, a user name and a password, so finding it in one of those
 * finds the placeholder there.
 */
const PLACEHOLDER_SENTINEL = "wfgraphplaceholder";

const PLACEHOLDER_BEFORE_PATH =
  "the url holds a placeholder before its path, in the host, the port or the user info";

/**
 * Why `url` cannot be an Action Link's URL, or undefined when it can. The
 * sentence names the rule and never quotes the URL.
 *
 * A URL is an absolute path on the host's own origin, starting with a single
 * `/`, or a URL starting `http://` or `https://`, in any letter case.
 *
 * - A C0 control character or DEL is refused anywhere, because a browser
 *   drops a tab or a newline before parsing, which can turn `/<tab>/evil.example`
 *   into a URL on another origin.
 * - A relative URL is refused because the browser would resolve it against the
 *   editor's own route. `https:/preview` is relative in that sense too: on an
 *   https page a browser reads it as the path `/preview`.
 * - A path starting `//` or `/\` is refused because a browser reads either as
 *   another origin. Once those and the control characters are refused, every
 *   other path resolves to the origin it is resolved against.
 * - A placeholder is allowed only in the path, query or fragment of an
 *   `http(s)` URL, so a node id never chooses the host or the port. The
 *   parser decides where the host ends, and a browser skips extra slashes
 *   after the scheme, which is why the check parses the URL rather than
 *   reading the characters after `//`.
 */
export function actionLinkUrlProblem(url: string): string | undefined {
  // eslint-disable-next-line eslint/no-control-regex -- control characters are what it looks for
  if (/[\u0000-\u001f\u007f]/u.test(url)) {
    return "the url holds a control character, such as a tab or a newline";
  }
  const filled = fillPlaceholdersWith(url, PLACEHOLDER_SENTINEL);
  if (/[{}]/u.test(filled)) {
    return "the url holds a placeholder other than {workflowId} and {nodeId}";
  }
  if (url.startsWith("/")) {
    return /^\/[/\\]/u.test(url)
      ? "the url starts with // or /\\, which a browser reads as another origin"
      : undefined;
  }
  if (!/^https?:\/\//iu.test(url)) {
    return "the url is neither an absolute path starting with / nor a URL starting http:// or https://";
  }
  if (!URL.canParse(filled)) {
    // A path, query or fragment takes letters anywhere, so a URL that parses
    // once its placeholders are gone has them where letters are refused,
    // such as the port.
    return URL.canParse(fillPlaceholdersWith(url, ""))
      ? PLACEHOLDER_BEFORE_PATH
      : "the url is not one a browser can parse";
  }
  const parsed = new URL(filled);
  return [parsed.host, parsed.username, parsed.password].some((part) =>
    part.includes(PLACEHOLDER_SENTINEL)
  )
    ? PLACEHOLDER_BEFORE_PATH
    : undefined;
}

/** `url` with every placeholder replaced by `value`. */
function fillPlaceholdersWith(url: string, value: string): string {
  return ACTION_LINK_PLACEHOLDERS.reduce(
    (remaining, [placeholder]) => remaining.replaceAll(placeholder, value),
    url
  );
}

/**
 * Ids a browser would read as a step within the path when one fills a whole
 * path segment. The URL parser also reads `%2E` as a dot, so no encoding of
 * these ids survives as the id itself.
 */
const DOT_SEGMENT_IDS: ReadonlySet<string> = new Set([".", ".."]);

/** Whether `fillActionLinkUrl` can write `id` into a URL intact. */
function fillableId(id: string): boolean {
  return id !== "" && !DOT_SEGMENT_IDS.has(id) && id.isWellFormed();
}

/**
 * An Action Link's URL with `{workflowId}` and `{nodeId}` replaced by the
 * given ids, each encoded with `encodeURIComponent`, so an id holding `/`,
 * `?`, `#` or `&` cannot add a path segment or a query parameter of its own.
 *
 * Answers undefined, and the editor then draws no link, when either id:
 *
 * - is `.` or `..`, because in a path such as `/a/{nodeId}/b` that id would
 *   move the link to `/b`;
 * - is empty, because in a path such as `/{nodeId}/b` it would leave `//b`,
 *   which a browser reads as another origin;
 * - is not well-formed UTF-16, because `encodeURIComponent` throws on a lone
 *   surrogate.
 */
export function fillActionLinkUrl(
  url: string,
  ids: { workflowId: string; nodeId: string }
): string | undefined {
  if (!(fillableId(ids.workflowId) && fillableId(ids.nodeId))) {
    return undefined;
  }
  return ACTION_LINK_PLACEHOLDERS.reduce(
    (remaining, [placeholder, key]) =>
      remaining.replaceAll(placeholder, encodeURIComponent(ids[key])),
    url
  );
}
