import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Key, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { orpcQuery } from "@/lib/rpc-query";
import { ConfirmOverlay } from "./confirm-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

type ApiKeysOverlayProps = {
  overlayId: string;
};

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Puts a value on the system clipboard and tells the user it worked.
 * Lives at module scope because it reads nothing from any component.
 */
function copyToClipboard(text: string) {
  void navigator.clipboard.writeText(text);
  toast.success("Copied to clipboard");
}

/**
 * Overlay for creating a new API key.
 * Pushed onto the stack from ApiKeysOverlay.
 */
function CreateApiKeyOverlay({
  overlayId,
  onCreated,
}: {
  overlayId: string;
  // The plaintext key, which the server returns exactly once.
  onCreated: (key: string) => void;
}) {
  const { pop } = useOverlay();
  const queryClient = useQueryClient();
  const [keyName, setKeyName] = useState("");

  const createKey = useMutation(
    orpcQuery.apiKey.create.mutationOptions({
      onSuccess: async (newKey) => {
        onCreated(newKey.key);
        toast.success("API key created successfully");
        await queryClient.invalidateQueries({
          queryKey: orpcQuery.apiKey.key(),
        });
        pop();
      },
      meta: { errorMessage: "Failed to create API key" },
    })
  );

  return (
    <Overlay
      actions={[
        {
          label: "Create",
          onClick: () => createKey.mutate({ name: keyName || null }),
          loading: createKey.isPending,
        },
      ]}
      overlayId={overlayId}
      title="Create API Key"
    >
      <p className="mb-4 text-muted-foreground text-sm">
        Create a new API key for webhook authentication
      </p>
      <div className="space-y-2">
        <Label htmlFor="key-name">Label (optional)</Label>
        <Input
          id="key-name"
          onChange={(e) => setKeyName(e.target.value)}
          placeholder="e.g., Production, Testing"
          value={keyName}
        />
      </div>
    </Overlay>
  );
}

/**
 * Main API Keys management overlay.
 */
export function ApiKeysOverlay({ overlayId }: ApiKeysOverlayProps) {
  const { push, closeAll } = useOverlay();
  const queryClient = useQueryClient();
  const { data: apiKeys = [], isPending } = useQuery({
    ...orpcQuery.apiKey.getAll.queryOptions({ input: {} }),
    meta: { errorMessage: "Failed to load API keys" },
  });

  // The one moment the plaintext key exists on the client. It is UI state, not
  // server state: the list query will never return it again.
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);

  const deleteKey = useMutation(
    orpcQuery.apiKey.delete.mutationOptions({
      onSuccess: async () => {
        toast.success("API key deleted");
        await queryClient.invalidateQueries({
          queryKey: orpcQuery.apiKey.key(),
        });
      },
      meta: { errorMessage: "Failed to delete API key" },
    })
  );

  const deletingId = deleteKey.isPending
    ? deleteKey.variables?.keyId
    : undefined;

  const openDeleteConfirm = (keyId: string) => {
    push(ConfirmOverlay, {
      title: "Delete API Key",
      message:
        "Are you sure you want to delete this API key? Any webhooks using this key will stop working immediately.",
      confirmLabel: "Delete",
      confirmVariant: "destructive" as const,
      destructive: true,
      onConfirm: () => deleteKey.mutate({ keyId }),
    });
  };

  return (
    <Overlay
      actions={[
        {
          label: "New API Key",
          variant: "outline",
          onClick: () =>
            push(CreateApiKeyOverlay, { onCreated: setNewlyCreatedKey }),
        },
        { label: "Done", onClick: closeAll },
      ]}
      overlayId={overlayId}
      title="API Keys"
    >
      <p className="-mt-2 mb-4 text-muted-foreground text-sm">
        Manage API keys for webhook authentication
      </p>

      {isPending ? (
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Newly created key warning */}
          {newlyCreatedKey && (
            <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3">
              <p className="mb-2 font-medium text-sm text-yellow-600 dark:text-yellow-400">
                Copy your API key now. You won't be able to see it again!
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-muted px-2 py-1 font-mono text-xs">
                  {newlyCreatedKey}
                </code>
                <Button
                  onClick={() => copyToClipboard(newlyCreatedKey)}
                  size="sm"
                  variant="outline"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
              <Button
                className="mt-2"
                onClick={() => setNewlyCreatedKey(null)}
                size="sm"
                variant="ghost"
              >
                Dismiss
              </Button>
            </div>
          )}

          {/* API Keys list */}
          {apiKeys.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-sm">
              <Key className="mx-auto mb-2 size-8 opacity-50" />
              <p>No API keys yet</p>
              <p className="text-xs">
                Create an API key to authenticate webhook requests
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {apiKeys.map((apiKey) => (
                <div
                  className="flex items-center justify-between rounded-md border p-3"
                  key={apiKey.id}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                        {apiKey.keyPrefix}...
                      </code>
                      {apiKey.name && (
                        <span className="truncate text-sm">{apiKey.name}</span>
                      )}
                    </div>
                    <p className="mt-1 text-muted-foreground text-xs">
                      Created {formatDate(apiKey.createdAt)}
                      {apiKey.lastUsedAt &&
                        ` · Last used ${formatDate(apiKey.lastUsedAt)}`}
                    </p>
                  </div>
                  <Button
                    disabled={deletingId === apiKey.id}
                    onClick={() => openDeleteConfirm(apiKey.id)}
                    size="sm"
                    variant="ghost"
                  >
                    {deletingId === apiKey.id ? (
                      <Spinner className="size-4" />
                    ) : (
                      <Trash2 className="size-4 text-destructive" />
                    )}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Overlay>
  );
}
