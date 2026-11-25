import { useAtomValue, useSetAtom } from "jotai";
import { compact } from "es-toolkit/array";
import { ExternalLink } from "lucide-react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  currentWorkflowIdAtom,
  flushPendingSaveAtom,
} from "#src/lib/workflow-save-store";
import { findAction } from "@wfgraph/shared/extensions/catalog";
import { fillActionLinkUrl } from "@wfgraph/shared/extensions/action-links";
import { cn } from "@wfgraph/shared/utils";

/**
 * The Action Links a host action declares, drawn for one node of the open
 * workflow, or nothing when the action has none to draw. Each opens the
 * host's page in a new tab with the workflow's and the node's ids filled into
 * its URL. Every reader sees them, since the host's page authorizes its own.
 *
 * A link whose URL cannot be filled for this node, such as one for a node
 * whose id is `..`, is left out.
 *
 * Following a link sends any edit still waiting on the autosave timer, so the
 * page is more likely to read the draft the builder sees. The navigation does
 * not wait for that save, which is why a host page re-reads the draft.
 */
export function ActionLinks({
  actionId,
  nodeId,
  className,
}: {
  actionId: string;
  nodeId: string;
  /** Classes for the list, such as the space it keeps from what precedes it. */
  className?: string | undefined;
}) {
  const catalog = useExtensionCatalog();
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const flushPendingSave = useSetAtom(flushPendingSaveAtom);
  const links = findAction(catalog, actionId)?.links;

  if (!links || workflowId === null) {
    return null;
  }
  const filledLinks = compact(
    links.map((link) => {
      const href = fillActionLinkUrl(link.url, { workflowId, nodeId });
      return href === undefined ? undefined : { ...link, href };
    })
  );
  if (filledLinks.length === 0) {
    return null;
  }

  return (
    <ul className={cn("space-y-1.5", className)}>
      {/* `defineAction` refuses two links with one label. */}
      {filledLinks.map((link) => (
        <li key={link.label}>
          <a
            className="inline-flex items-center gap-1.5 text-info text-sm underline-offset-2 hover:underline"
            href={link.href}
            // A middle click opens the page as well, and arrives as an
            // auxclick rather than a click.
            onAuxClick={() => flushPendingSave()}
            onClick={() => flushPendingSave()}
            rel="noopener noreferrer"
            target="_blank"
          >
            <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
            {link.label}
          </a>
        </li>
      ))}
    </ul>
  );
}
