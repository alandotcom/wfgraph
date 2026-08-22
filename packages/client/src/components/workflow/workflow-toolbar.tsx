import * as stylex from "@stylexjs/stylex";
import { Banner } from "@astryxdesign/core/Banner";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { VStack } from "@astryxdesign/core/VStack";
import { spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import { useQuery } from "@tanstack/react-query";
import { UserMenu } from "#src/components/workflows/user-menu";
import {
  DuplicateButton,
  ToolbarActions,
  WorkflowMenuComponent,
} from "#src/components/workflow/workflow-toolbar-chrome";
import {
  useWorkflowActions,
  useWorkflowState,
} from "#src/components/workflow/workflow-toolbar-handlers";
import { WorkflowIssuesChip } from "#src/components/workflow/workflow-issues-chip";
import { WorkflowPublicationBadge } from "#src/components/workflow/workflow-publication-badge";
import { WorkflowSaveStatus } from "#src/components/workflow/workflow-save-status";
import { workflowPublicationQueryOptions } from "#src/lib/rpc-query";

type WorkflowToolbarProps = {
  workflowId?: string;
};

export const WorkflowToolbar = ({ workflowId }: WorkflowToolbarProps) => {
  const state = useWorkflowState();
  const actions = useWorkflowActions(state);

  const currentWorkflow = state.allWorkflows.find(
    (workflow) => workflow.id === state.currentWorkflowId
  );
  const isPublished = Boolean(currentWorkflow?.publishedVersionId);
  // Server state: draft vs published. Seeded by the route loader's getById,
  // patched by save/publish into the same cache entry — not mirrored in jotai.
  const { data: hasUnpublishedChanges = false } = useQuery({
    ...workflowPublicationQueryOptions(workflowId ?? ""),
    enabled: Boolean(workflowId),
  });

  const startContent = (
    <HStack gap={2} wrap="nowrap" xstyle={styles.nonShrinkingRow}>
      <WorkflowMenuComponent
        actions={actions}
        state={state}
        workflowId={workflowId}
      />
      {workflowId && state.workflowMode === "test" ? (
        <Token color="yellow" label="Test mode" size="sm" />
      ) : null}
      {workflowId ? (
        <WorkflowPublicationBadge
          hasUnpublishedChanges={hasUnpublishedChanges}
          isPublished={isPublished}
        />
      ) : null}
      {workflowId && !state.isOwner ? (
        <Text color="secondary" type="supporting">
          Read-only
        </Text>
      ) : null}
      <WorkflowIssuesChip onOpen={actions.handleShowIssues} />
      <WorkflowSaveStatus />
    </HStack>
  );

  const actionsContent = (
    <HStack gap={2} wrap="nowrap" xstyle={styles.nonShrinkingRow}>
      <ToolbarActions actions={actions} state={state} workflowId={workflowId} />
      {workflowId && !state.isOwner ? (
        <DuplicateButton
          isDuplicating={actions.isDuplicating}
          onDuplicate={actions.handleDuplicate}
        />
      ) : null}
      <UserMenu />
    </HStack>
  );

  return (
    <>
      <VStack gap={2} xstyle={styles.frame}>
        <Toolbar
          gap={2}
          label="Workflow navigation and status"
          size="md"
          startContent={startContent}
          variant="transparent"
          xstyle={styles.toolbar}
        />
        <Toolbar
          gap={2}
          label="Workflow actions"
          size="md"
          startContent={actionsContent}
          variant="transparent"
          xstyle={styles.toolbar}
        />
      </VStack>
      {workflowId && state.workflowMode === "test" ? (
        <Banner
          container="card"
          description="No real email or SMS is sent unless a node routes to a test recipient."
          elevation="low"
          status="warning"
          title="Test mode active"
          xstyle={styles.testModeBanner}
        />
      ) : null}
    </>
  );
};

const styles = stylex.create({
  frame: {
    insetInline: spacingVars["--spacing-4"],
    maxWidth: `calc(100% - ${spacingVars["--spacing-8"]})`,
    pointerEvents: "none",
    position: "absolute",
    top: spacingVars["--spacing-4"],
    zIndex: 10,
  },
  toolbar: {
    overflowX: "auto",
    pointerEvents: "auto",
  },
  nonShrinkingRow: {
    flexShrink: 0,
    minWidth: "max-content",
  },
  testModeBanner: {
    bottom: spacingVars["--spacing-4"],
    insetInlineStart: "50%",
    maxWidth: "40rem",
    pointerEvents: "none",
    position: "absolute",
    transform: "translateX(-50%)",
    width: `calc(100% - ${spacingVars["--spacing-8"]})`,
    zIndex: 10,
  },
});
