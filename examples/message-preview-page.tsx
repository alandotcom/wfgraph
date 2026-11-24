/** @jsxImportSource hono/jsx */
/* oxlint-disable react/react-in-jsx-scope, react/jsx-key -- this file uses Hono's JSX runtime, which renders once on the server and reads no keys. */

import type { WfGraphDraftField, WfGraphDraftNode } from "@wfgraph/core";

/**
 * Reloads the page whenever its tab is shown again. The editor starts a save
 * when the link is followed and does not wait for it, so a builder who edits
 * the message and comes back sees the newest saved draft.
 */
const reloadWhenShown = `document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") location.reload();
});`;

const previewCss = String.raw`
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0 auto; max-width: 40rem; padding: 1.5rem; line-height: 1.5; }
  h2 { margin: 1.25rem 0 .25rem; font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; opacity: .7; }
  .value { margin: 0; white-space: pre-wrap; }
  .reference { border-radius: .25rem; padding: 0 .25rem; background: rgb(59 130 246 / .15); font-family: ui-monospace, monospace; font-size: .875em; }
`;

/**
 * One config value as text. A reference shows as a bracketed placeholder,
 * such as [Patient.status], where a real preview would put the value this
 * app holds for it.
 */
function FieldValue({ field }: { field: WfGraphDraftField }) {
  if (field.kind === "value") {
    return <p class="value">{JSON.stringify(field.value)}</p>;
  }
  return (
    <p class="value">
      {field.segments.map((segment) =>
        segment.kind === "text" ? (
          segment.text
        ) : (
          <span class="reference">[{segment.display}]</span>
        )
      )}
    </p>
  );
}

export function MessagePreviewPage({ node }: { node: WfGraphDraftNode }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Preview: {node.label}</title>
        <style>{previewCss}</style>
        <script dangerouslySetInnerHTML={{ __html: reloadWhenShown }} />
      </head>
      <body>
        <h1>{node.label}</h1>
        <p>Draft revision {node.revision}</p>
        {Object.entries(node.fields).map(([key, field]) => (
          <section>
            <h2>{key}</h2>
            <FieldValue field={field} />
          </section>
        ))}
      </body>
    </html>
  );
}
