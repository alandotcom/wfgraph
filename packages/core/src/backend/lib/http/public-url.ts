/**
 * Normalize the origin providers use to reach this app.
 *
 * Provider registrations compare callback URLs exactly, so this value comes from
 * host configuration rather than proxy headers on whichever request starts a flow.
 */
export function resolvePublicUrl(
  value: string | undefined
): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `Workflow Graph's publicUrl must be an absolute URL, for example "https://workflows.example.com".`
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Workflow Graph's publicUrl must be an http or https URL.`);
  }

  const isLoopback =
    parsed.hostname === "localhost" ||
    parsed.hostname.endsWith(".localhost") ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol === "http:" && !isLoopback) {
    throw new Error(
      `Workflow Graph's publicUrl must use HTTPS or a loopback HTTP origin.`
    );
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `Workflow Graph's publicUrl names the origin alone, for example "https://workflows.example.com". Put the mount path in basePath.`
    );
  }

  return parsed.origin;
}
