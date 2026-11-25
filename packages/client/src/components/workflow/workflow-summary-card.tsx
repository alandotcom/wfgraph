import { useAtom, useAtomValue } from "jotai";
import { ChevronDown, ChevronUp } from "lucide-react";
import { type ReactNode, useId } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import { edgesAtom, nodesAtom } from "#src/lib/workflow-graph-store";
import { workflowSummaryExpandedAtom } from "#src/lib/workflow-ui-store";
import {
  summarizeWorkflow,
  type WorkflowSummaryLine,
} from "@wfgraph/shared/graph/workflow-summary";

/**
 * The Draft canvas's account of what the workflow does, above the zoom
 * controls. Collapsed, it shows the first sentence of what starts a run.
 * Expanded, it shows what starts a run, each step in order with its branches,
 * and what stops a run. It reads the draft graph on the canvas, so it changes
 * as the builder edits.
 */
export function WorkflowSummaryCard() {
  const catalog = useExtensionCatalog();
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const [expanded, setExpanded] = useAtom(workflowSummaryExpandedAtom);
  const bodyId = useId();
  const summary = summarizeWorkflow({ nodes, edges, catalog });

  return (
    <section
      aria-label="What this workflow does"
      className="w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-sidebar text-xs shadow-sm"
      data-slot="workflow-summary"
    >
      <Button
        aria-controls={bodyId}
        aria-expanded={expanded}
        className="h-11 w-full justify-between rounded-b-none px-3 font-medium md:h-7"
        onClick={() => setExpanded(!expanded)}
        variant="ghost"
      >
        What this workflow does
        {expanded ? (
          <ChevronDown aria-hidden data-icon="inline-end" />
        ) : (
          <ChevronUp aria-hidden data-icon="inline-end" />
        )}
      </Button>
      <div className="border-t px-3 py-2" id={bodyId}>
        {expanded ? (
          // The height cap is a fallback for a very long workflow; an
          // ordinary one fits beside the zoom controls without scrolling.
          <div className="max-h-[min(70vh,44rem)] space-y-3 overflow-y-auto">
            <SummarySection title="When it starts">
              {summary.starts.map((sentence) => (
                <p key={sentence}>{sentence}</p>
              ))}
            </SummarySection>
            <SummarySection title="What it does">
              {summary.steps.length === 0 ? (
                <p className="text-muted-foreground">
                  No step follows the Started outlet yet.
                </p>
              ) : (
                <ol className="list-decimal space-y-1 pl-4">
                  {summary.steps.map((line) => (
                    <SummaryLine key={line.key} line={line} />
                  ))}
                </ol>
              )}
            </SummarySection>
            {summary.stops.length > 0 ? (
              <SummarySection title="What stops it">
                {summary.stops.map((sentence) => (
                  <p key={sentence}>{sentence}</p>
                ))}
              </SummarySection>
            ) : null}
          </div>
        ) : (
          <p className="line-clamp-2 text-muted-foreground">
            {summary.starts[0]}
          </p>
        )}
      </div>
    </section>
  );
}

function SummarySection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <h3 className="font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

/**
 * One line and the branches it opens, each branch indented behind a left rule
 * the way a Condition's rule groups are.
 */
function SummaryLine({ line }: { line: WorkflowSummaryLine }) {
  return (
    <li>
      {line.text}
      {line.children.length > 0 ? (
        <ul className="mt-1 ml-0.5 space-y-1 border-l pl-2.5">
          {line.children.map((child) => (
            <SummaryLine key={child.key} line={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
