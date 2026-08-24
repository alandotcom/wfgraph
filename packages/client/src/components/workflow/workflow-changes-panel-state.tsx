import { Button } from "#src/components/ui/button";

export function PanelState({
  label,
  actionLabel,
  onAction,
}: {
  label: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
      role="status"
    >
      <p className="text-muted-foreground text-sm">{label}</p>
      {actionLabel && onAction ? (
        <Button onClick={onAction} size="sm" type="button" variant="outline">
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
