import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { api } from "@/client/lib/rpc-client";

export default function WorkflowsPage() {
  const navigate = useNavigate();

  useEffect(() => {
    const redirectToWorkflow = async () => {
      try {
        const workflows = await api.workflow.getAll();
        // Filter out the auto-save workflow
        const filtered = workflows.filter((w) => w.name !== "__current__");

        if (filtered.length > 0) {
          // Sort by updatedAt descending to get most recent
          const mostRecent = filtered.sort(
            (a, b) =>
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          )[0];
          await navigate({
            to: "/workflows/$workflowId",
            params: { workflowId: mostRecent.id },
            replace: true,
          });
        } else {
          // No workflows, redirect to homepage
          await navigate({ to: "/", replace: true });
        }
      } catch (error) {
        console.error("Failed to load workflows:", error);
        await navigate({ to: "/", replace: true });
      }
    };

    redirectToWorkflow();
  }, [navigate]);

  return null;
}
