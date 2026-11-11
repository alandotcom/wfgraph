/**
 * The assistant's prose.
 *
 * Markdown, because a model writes lists and code spans whatever it is asked
 * for, and a wall of asterisks reads as a bug. The prose styling itself is one
 * CSS file the editor owns, applied through the `typeset` classes.
 */

import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type * as React from "react";
import remarkGfm from "remark-gfm";

/**
 * An image is named, never loaded. A browser fetches an `<img>` the moment it
 * renders, so an address the model was talked into writing (by text injected
 * into a node description, say) would carry whatever the address encodes to
 * another origin with no click. The alt text stands in for the picture.
 *
 * A table scrolls inside its own box rather than widening the panel, which is
 * what `.typeset-scroll` in `typeset.css` is for. The card clips its overflow,
 * so an unwrapped table loses its right-hand columns instead of reaching for a
 * scrollbar.
 */
const markdownComponents = {
  img: ({ alt }: { alt?: string | undefined }) => (
    <span className="text-muted-foreground">[image: {alt ?? ""}]</span>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="typeset-scroll">
      <table>{children}</table>
    </div>
  ),
};

export function AgentMarkdown() {
  return (
    <div className="typeset typeset-chat">
      <MarkdownTextPrimitive
        components={markdownComponents}
        remarkPlugins={[remarkGfm]}
      />
    </div>
  );
}
