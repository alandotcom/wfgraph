import { useRouterState } from "@tanstack/react-router";
import { WorkflowCanvas } from "./workflow-canvas";

const WORKFLOW_EDITOR_PATH_PATTERN = /^\/workflows\/[^/]+$/;

export function PersistentCanvas() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  const showCanvas = WORKFLOW_EDITOR_PATH_PATTERN.test(pathname);

  if (!showCanvas) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-0">
      <WorkflowCanvas />
    </div>
  );
}
