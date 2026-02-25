import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiError, api, type SavedWorkflow } from "@/lib/rpc-client";

type CreateWorkflowDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingWorkflowNames: string[];
  onCreated: (workflow: SavedWorkflow) => Promise<void> | void;
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
  const defaultName = useMemo(
    () => buildNextWorkflowName(existingWorkflowNames),
    [existingWorkflowNames]
  );
  const [workflowName, setWorkflowName] = useState(defaultName);
  const [isCreating, setIsCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setWorkflowName(defaultName);
    setErrorMessage(null);
  }, [defaultName, open]);

  const createWorkflow = async () => {
    const normalizedName = workflowName.trim();
    if (!normalizedName) {
      setErrorMessage("Workflow name is required.");
      return;
    }

    setIsCreating(true);
    setErrorMessage(null);

    try {
      const createdWorkflow = await api.workflow.create({
        name: normalizedName,
        nodes: [],
        edges: [],
      });

      await onCreated(createdWorkflow);
      onOpenChange(false);
      toast.success("Workflow created");
    } catch (error) {
      console.error("Failed to create workflow:", error);
      const message =
        error instanceof ApiError ? error.message : "Failed to create workflow";
      setErrorMessage(message);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Workflow</DialogTitle>
          <DialogDescription>
            Choose a name for the new workflow before creating it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Input
            autoFocus
            disabled={isCreating}
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
          <Button
            disabled={isCreating}
            onClick={() => {
              createWorkflow();
            }}
            type="button"
          >
            {isCreating ? "Creating..." : "Create Workflow"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
