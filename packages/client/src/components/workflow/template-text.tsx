import { Fragment, type ReactNode } from "react";
import { currentTokenDisplay } from "@wfgraph/shared/graph/node-display";
import { parseTemplate } from "@wfgraph/shared/graph/node-references";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { cn } from "@wfgraph/shared/utils";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { TEMPLATE_BADGE_TONE } from "#src/components/ui/template-badge-dom";

/**
 * Read-only text with each template reference drawn as the badge the Draft
 * editor draws: the source's current name and the path, in the editor's colors,
 * and in red when the graph no longer offers that source. `nodes` is the graph
 * the text belongs to, which can be a published version's graph. The badge is
 * inline, so a long reference wraps with the text around it.
 */
export function TemplateText({
  text,
  nodes,
}: {
  text: string;
  nodes: readonly WorkflowNode[];
}) {
  const catalog = useExtensionCatalog();
  // Each segment is keyed by where it starts in `text`.
  let start = 0;
  const parts: ReactNode[] = [];
  for (const segment of parseTemplate(text)) {
    const key = start;
    if (segment.kind === "literal") {
      start += segment.text.length;
      parts.push(<Fragment key={key}>{segment.text}</Fragment>);
      continue;
    }
    start += segment.token.raw.length;
    const display = currentTokenDisplay(segment.token, nodes, catalog);
    parts.push(
      <span
        className={cn(
          "rounded border px-1 font-mono text-xs box-decoration-clone",
          display.sourceIsLive
            ? TEMPLATE_BADGE_TONE.live
            : TEMPLATE_BADGE_TONE.broken
        )}
        data-slot="template-reference"
        key={key}
      >
        {display.text}
      </span>
    );
  }
  return parts;
}
