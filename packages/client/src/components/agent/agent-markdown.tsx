/**
 * The assistant's prose.
 *
 * Markdown, because a model writes lists and code spans whatever it is asked
 * for, and a wall of asterisks reads as a bug. The prose styling itself is one
 * CSS file the editor owns, applied through the `typeset` classes.
 */

import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";

export function AgentMarkdown() {
  return (
    <div className="typeset typeset-chat text-sm">
      <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} />
    </div>
  );
}
