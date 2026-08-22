import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { notifications as toast } from "#src/lib/notifications";
import { ApiError } from "#src/lib/rpc-client";
import { orpcQuery, refreshWorkflowList } from "#src/lib/rpc-query";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";

type CreateWorkflowDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingWorkflowNames: string[];
  /** Both callers route into the new workflow, which is all they need. */
  onCreated: (workflowId: string) => Promise<void> | void;
};

function buildNextWorkflowName(existingWorkflowNames: string[]): string {
  const existingNames = new Set(
    existingWorkflowNames.map((name) => name.toLowerCase())
  );
  const baseName = "New Workflow";

  if (!existingNames.has(baseName.toLowerCase())) {
    return baseName;
  }

  let suffix = 2;
  while (existingNames.has(`${baseName} (${suffix})`.toLowerCase())) {
    suffix += 1;
  }

  return `${baseName} (${suffix})`;
}

export function CreateWorkflowDialog({
  open,
  onOpenChange,
  existingWorkflowNames,
  onCreated,
}: CreateWorkflowDialogProps) {
  // The suggested name is computed once, when this dialog mounts. Callers give
  // it a fresh key each time they open it, so mounting is the reset. Recomputing
  // it from `existingWorkflowNames` on every render would let a background
  // refetch of the workflow list silently replace whatever the user had typed.
  const [workflowName, setWorkflowName] = useState(() =>
    buildNextWorkflowName(existingWorkflowNames)
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const create = useMutation(
    orpcQuery.workflow.create.mutationOptions({
      onSuccess: async (payload) => {
        await refreshWorkflowList(queryClient);
        await onCreated(payload.id);
        onOpenChange(false);
        toast.success("Workflow created");
      },
      onError: (error) => {
        setErrorMessage(
          error instanceof ApiError
            ? error.message
            : "Failed to create workflow"
        );
      },
      // The failure belongs beside the name field the user has to correct, so
      // it is shown inline and the mutation cache stays quiet.
      meta: { errorShownByCaller: true },
    })
  );
  const isCreating = create.isPending;

  const createWorkflow = () => {
    const normalizedName = workflowName.trim();
    if (!normalizedName) {
      setErrorMessage("Workflow name is required.");
      return;
    }

    setErrorMessage(null);
    create.mutate({
      name: normalizedName,
      graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
    });
  };

  // Escape, the backdrop, and the X are all closing intents, and this dialog is
  // the only place a create failure is reported: it takes `errorShownByCaller`,
  // so a request that rejects into a closed dialog is a request that vanishes.
  // Nothing dismisses it while one is in flight except the mutation settling.
  const handleOpenChange = (next: boolean) => {
    if (!(next || isCreating)) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog isOpen={open} onOpenChange={handleOpenChange} purpose="form">
      <Layout
        content={
          <LayoutContent>
            <VStack
              as="form"
              gap={4}
              onSubmit={(event) => {
                event.preventDefault();
                createWorkflow();
              }}
            >
              <TextInput
                hasAutoFocus
                isDisabled={isCreating}
                label="Name"
                onChange={(value) => {
                  setWorkflowName(value);
                  if (errorMessage) {
                    setErrorMessage(null);
                  }
                }}
                placeholder="Workflow name"
                status={
                  errorMessage
                    ? { type: "error", message: errorMessage }
                    : undefined
                }
                value={workflowName}
                width="100%"
              />
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end">
              <Button
                isDisabled={isCreating}
                label="Cancel"
                onClick={() => onOpenChange(false)}
                variant="secondary"
              />
              <Button
                isDisabled={isCreating}
                isLoading={isCreating}
                label={isCreating ? "Creating" : "Create workflow"}
                onClick={createWorkflow}
                variant="primary"
              />
            </HStack>
          </LayoutFooter>
        }
        header={
          <DialogHeader
            onOpenChange={isCreating ? undefined : handleOpenChange}
            subtitle="Choose a name for the new workflow."
            title="Create workflow"
          />
        }
      />
    </Dialog>
  );
}
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
