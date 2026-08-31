/**
 * The Connection-addressed webhook URL an operator pastes into a vendor.
 *
 * Built from the host's `publicUrl` and API mount, so a proxy in front of
 * Workflow Graph still produces the origin the vendor will POST to. Absent
 * `publicUrl`, the editor cannot copy a URL and says so rather than offering
 * `window.location`.
 */

export function connectionWebhookUrl(input: {
  readonly publicUrl: string;
  readonly apiBasePath: string;
  readonly type: string;
  readonly connectionId: string;
}): string {
  const base = input.apiBasePath.endsWith("/")
    ? input.apiBasePath.slice(0, -1)
    : input.apiBasePath;
  return `${input.publicUrl}${base}/webhooks/${encodeURIComponent(input.type)}/${encodeURIComponent(input.connectionId)}`;
}
