/**
 * The build agent in the details column's Agent tab: a "New conversation"
 * control over the thread.
 *
 * The details column keeps this mounted under either tab, so switching to
 * Details mid-turn hides the conversation and ends nothing. The thread is kept
 * in this browser per workflow until "New conversation" clears it. The agent's
 * edits are already saved to the draft, so the record of what it changed stays
 * readable beside the graph it changed.
 *
 * Absent entirely when the host configured no model: the runtime says so, and a
 * disabled control the user cannot enable is worse than no control.
 */
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { SquarePenIcon } from "lucide-react";
import { useAtomValue } from "jotai";
import { useCallback } from "react";
import { AgentThread } from "#src/components/agent/agent-thread";
import { forgetAgentThread } from "#src/components/agent/thread-storage";
import { useAgentRuntime } from "#src/components/agent/use-agent-runtime";
import { Button } from "#src/components/ui/button";
import { canUseBuildAgent } from "#src/lib/authorization";
import { isGeneratingAtom } from "#src/lib/workflow-ui-store";

function WorkflowAgentPanel({ workflowId }: { workflowId: string }) {
  const runtime = useAgentRuntime(workflowId);
  const isGenerating = useAtomValue(isGeneratingAtom);
  // The stored copy goes first, so nothing the reset leaves behind can be
  // loaded back into the new thread.
  const onNewConversation = useCallback(() => {
    forgetAgentThread(workflowId);
    runtime.thread.reset();
  }, [runtime, workflowId]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div
        aria-label="Build agent"
        className="flex min-h-0 flex-1 flex-col bg-card"
        data-slot="agent-panel"
        role="region"
      >
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3">
          {isGenerating ? (
            <span
              className="shimmer text-muted-foreground text-xs motion-reduce:animate-none"
              role="status"
            >
              Working
            </span>
          ) : (
            <span />
          )}
          <Button
            disabled={isGenerating}
            onClick={onNewConversation}
            size="sm"
            type="button"
            variant="ghost"
          >
            <SquarePenIcon />
            New conversation
          </Button>
        </div>
        <AgentThread />
      </div>
    </AssistantRuntimeProvider>
  );
}

export function AgentPanel({ workflowId }: { workflowId: string }) {
  if (!canUseBuildAgent()) {
    return null;
  }
  return <WorkflowAgentPanel key={workflowId} workflowId={workflowId} />;
}
