import { useAtom, useAtomValue } from "jotai";
import type { KeyboardEvent } from "react";
import { AgentPanel } from "#src/components/agent/agent-panel";
import { ColumnHeader } from "#src/components/workflow/columns/editor-columns";
import { canUseBuildAgent } from "#src/lib/authorization";
import { isAgentEnabled } from "#src/lib/extensions";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { type DetailsTab, detailsTabAtom } from "#src/lib/workflow-ui-store";
import { cn } from "@wfgraph/shared/utils";
import { DetailsPanel } from "./details-panel";

const TAB_LABELS: Record<DetailsTab, string> = {
  details: "Details",
  agent: "Agent",
};

/**
 * The editor's right column: a header holding the Details and Agent tabs, and
 * the tab's body. Details shows what the selection shows. Agent holds the build
 * agent, which stays mounted under Details so a turn in progress keeps going.
 * Without a configured model, or for a person who may not use the agent, the
 * header names Details alone.
 */
export function DetailsColumn() {
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const [tab, setTab] = useAtom(detailsTabAtom);
  const offersAgent =
    workflowId !== null && isAgentEnabled() && canUseBuildAgent();
  const shown: DetailsTab = offersAgent ? tab : "details";
  const tabs: readonly DetailsTab[] = offersAgent
    ? ["details", "agent"]
    : ["details"];

  // Left and Right move between the two tabs, which is how a tab list reads
  // from the keyboard.
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const next = shown === "details" ? "agent" : "details";
    if (tabs.includes(next)) {
      setTab(next);
      document.getElementById(`details-tab-${next}`)?.focus();
    }
  };

  return (
    <>
      <ColumnHeader side="details">
        <div aria-label="Details column" className="flex gap-3" role="tablist">
          {tabs.map((item) => (
            <button
              aria-controls={`details-tabpanel-${item}`}
              aria-selected={shown === item}
              className={cn(
                "-mb-px h-10 border-b-2 px-0.5 font-medium text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                shown === item
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
              id={`details-tab-${item}`}
              key={item}
              onClick={() => setTab(item)}
              onKeyDown={onTabKeyDown}
              role="tab"
              tabIndex={shown === item ? 0 : -1}
              type="button"
            >
              {TAB_LABELS[item]}
            </button>
          ))}
        </div>
      </ColumnHeader>
      <div
        aria-labelledby="details-tab-details"
        className={cn(
          "min-h-0 flex-1 flex-col",
          shown === "details" ? "flex" : "hidden"
        )}
        id="details-tabpanel-details"
        role="tabpanel"
      >
        <DetailsPanel />
      </div>
      {offersAgent ? (
        <div
          aria-labelledby="details-tab-agent"
          className={cn(
            "min-h-0 flex-1 flex-col",
            shown === "agent" ? "flex" : "hidden"
          )}
          id="details-tabpanel-agent"
          role="tabpanel"
        >
          <AgentPanel workflowId={workflowId} />
        </div>
      ) : null}
    </>
  );
}
