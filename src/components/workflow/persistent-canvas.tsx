import { useRouterState } from "@tanstack/react-router";
import { WorkflowCanvas } from "./workflow-canvas";

export function PersistentCanvas() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  // Show canvas on homepage and workflow pages
  const showCanvas = pathname === "/" || pathname.startsWith("/workflows/");

  if (!showCanvas) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-0">
      <WorkflowCanvas />
    </div>
  );
}
