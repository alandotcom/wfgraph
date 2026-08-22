import { useSetAtom } from "jotai";
import { useState } from "react";
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
import { renameWorkflowAtom } from "#src/lib/workflow-save-store";

type RenameWorkflowDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The name the field starts on. Callers remount this dialog to reset it. */
  currentName: string;
  /**
   * Every other workflow's name. The server rejects a duplicate
   * case-insensitively before applying any part of the patch, so a name checked
   * here never reaches the queue.
   */
  otherWorkflowNames: string[];
};

/**
 * Rename the open workflow.
 *
 * The field answers what it can answer without asking: an empty name, and a
 * name another workflow already has. Anything the server refuses is reported
 * where every other failed save is -- the toast and the status strip -- and the
 * name on screen goes back to what it was. This dialog keeps nothing of its own
 * to say about it, which is what stops one failure being reported twice.
 */
export function RenameWorkflowDialog({
  open,
  onOpenChange,
  currentName,
  otherWorkflowNames,
}: RenameWorkflowDialogProps) {
  // Read once, on mount: a rename landing elsewhere would otherwise replace
  // what the user is typing. Callers give the dialog a fresh key per open.
  const [workflowName, setWorkflowName] = useState(currentName);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const renameWorkflow = useSetAtom(renameWorkflowAtom);

  const submitRename = async () => {
    const normalizedName = workflowName.trim();
    if (!normalizedName) {
      setErrorMessage("Workflow name is required.");
      return;
    }

    if (normalizedName === currentName) {
      onOpenChange(false);
      return;
    }

    const taken = otherWorkflowNames.some(
      (name) => name.toLowerCase() === normalizedName.toLowerCase()
    );
    if (taken) {
      setErrorMessage(`"${normalizedName}" is already taken.`);
      return;
    }

    setErrorMessage(null);
    setIsRenaming(true);
    // Immediate, so this waits on a request rather than on the autosave
    // debounce. The dialog is shut while it is in flight, and holding it shut
    // for a second of debounce first is a second of a dialog refusing Escape.
    await renameWorkflow(normalizedName);
    setIsRenaming(false);
    onOpenChange(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!(next || isRenaming)) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent showCloseButton={!isRenaming}>
        <DialogHeader>
          <DialogTitle>Rename Workflow</DialogTitle>
          <DialogDescription>
            The name identifies this workflow everywhere it is listed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="rename-workflow-name">Name</Label>
          <Input
            aria-invalid={errorMessage ? true : undefined}
            autoFocus
            disabled={isRenaming}
            id="rename-workflow-name"
            onChange={(event) => {
              setWorkflowName(event.target.value);
              if (errorMessage) {
                setErrorMessage(null);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitRename();
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
            disabled={isRenaming}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={isRenaming}
            onClick={() => void submitRename()}
            type="button"
          >
            {isRenaming ? "Renaming..." : "Rename"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
