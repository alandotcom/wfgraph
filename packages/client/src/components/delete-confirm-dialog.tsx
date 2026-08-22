import { AlertDialog } from "@astryxdesign/core/AlertDialog";

interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  title?: string;
  description?: string;
  /** Wording on the button that goes through with it. */
  confirmLabel?: string;
}

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title = "Delete",
  description = "Are you sure? This action cannot be undone.",
  confirmLabel = "Delete",
}: DeleteConfirmDialogProps) {
  return (
    <AlertDialog
      actionLabel={confirmLabel}
      description={description}
      isOpen={open}
      onAction={onConfirm}
      onOpenChange={onOpenChange}
      title={title}
    />
  );
}
