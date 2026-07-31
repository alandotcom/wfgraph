import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#src/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#src/components/ui/dialog";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import { ApiError } from "#src/lib/rpc-client";
import { orpcQuery, refreshWorkflowList } from "#src/lib/rpc-query";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";

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
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent showCloseButton={!isCreating}>
        <DialogHeader>
          <DialogTitle>Create Workflow</DialogTitle>
          <DialogDescription>
            Choose a name for the new workflow.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="create-workflow-name">Name</Label>
          <Input
            aria-invalid={errorMessage ? true : undefined}
            autoFocus
            disabled={isCreating}
            id="create-workflow-name"
            onChange={(event) => {
              setWorkflowName(event.target.value);
              if (errorMessage) {
                setErrorMessage(null);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                createWorkflow();
              }
            }}
            placeholder="Workflow name"
            value={workflowName}
          />
          {errorMessage ? (
            <p className="text-destructive text-xs">{errorMessage}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            disabled={isCreating}
            onClick={() => {
              onOpenChange(false);
            }}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={isCreating} onClick={createWorkflow} type="button">
            {isCreating ? "Creating..." : "Create Workflow"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
