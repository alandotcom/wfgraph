import { useRouterState } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";
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
    <div {...stylex.props(styles.canvas)}>
      <WorkflowCanvas />
    </div>
  );
}

const styles = stylex.create({
  canvas: { inset: 0, position: "fixed", zIndex: 0 },
});
