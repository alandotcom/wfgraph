import { Copy } from "lucide-react";
import { useId } from "react";
import { toast } from "sonner";
import { Button } from "#src/components/ui/button";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import { getWebhookIntake } from "#src/lib/extensions";
import { connectionWebhookUrl } from "@wfgraph/shared/extensions/webhook-url";

/**
 * The Connection-addressed URL a vendor POSTs to.
 *
 * Shown wherever a builder names that Connection for an integration Event, not
 * only on the Connection dialog: the URL is what they paste into Resend, and
 * the Lifecycle Node is where they pick the Events.
 */
export function WebhookUrlField({
  type,
  helpText,
  connectionId,
}: {
  type: string;
  helpText: string | undefined;
  connectionId: string;
}) {
  const inputId = useId();
  const intake = getWebhookIntake();

  if (!intake) {
    return (
      <div className="space-y-1">
        <Label>Webhook URL</Label>
        <p className="text-muted-foreground text-xs">
          This host has no publicUrl, so a webhook URL cannot be copied. Set
          publicUrl on createWfGraphApp.
        </p>
      </div>
    );
  }

  const url = connectionWebhookUrl({
    publicUrl: intake.publicUrl,
    apiBasePath: intake.apiBasePath,
    type,
    connectionId,
  });

  const copyUrl = () => {
    void navigator.clipboard.writeText(url);
    toast.success("Webhook URL copied");
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>Webhook URL</Label>
      <div className="flex gap-2">
        <Input id={inputId} readOnly value={url} />
        <Button
          aria-label="Copy webhook URL"
          onClick={copyUrl}
          size="icon"
          type="button"
          variant="outline"
        >
          <Copy className="size-4" />
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {helpText ??
          "Paste this URL into the vendor's webhook settings for this Connection."}
      </p>
    </div>
  );
}
