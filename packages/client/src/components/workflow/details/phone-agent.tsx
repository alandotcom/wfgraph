import { useAtom, useAtomValue } from "jotai";
import { ArrowLeft } from "lucide-react";
import { AgentPanel } from "#src/components/agent/agent-panel";
import { Button } from "#src/components/ui/button";
import { canUseBuildAgent } from "#src/lib/authorization";
import { isAgentEnabled } from "#src/lib/extensions";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { detailsTabAtom } from "#src/lib/workflow-ui-store";

/**
 * The build agent on a phone: while the Agent tab is chosen, it covers the
 * outline or the canvas under a header whose Back returns to them. The command
 * palette's Agent command and "Describe it to the agent" choose the tab.
 */
export function PhoneAgent() {
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const [tab, setTab] = useAtom(detailsTabAtom);
  if (
    tab !== "agent" ||
    workflowId === null ||
    !isAgentEnabled() ||
    !canUseBuildAgent()
  ) {
    return null;
  }
  return (
    <section
      aria-label="Agent"
      className="absolute inset-0 z-20 flex flex-col bg-sidebar"
      data-slot="phone-agent"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-2">
        <Button
          aria-label="Back"
          onClick={() => setTab("details")}
          size="icon"
          type="button"
          variant="ghost"
        >
          <ArrowLeft />
        </Button>
        <h2 className="font-medium text-sm">Agent</h2>
      </div>
      <AgentPanel workflowId={workflowId} />
    </section>
  );
}
