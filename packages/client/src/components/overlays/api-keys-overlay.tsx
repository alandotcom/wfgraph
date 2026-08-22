import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Key, Trash2 } from "lucide-react";
import { useState } from "react";
import { notifications as toast } from "#src/lib/notifications";
import { orpcQuery } from "#src/lib/rpc-query";
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
      <Text color="secondary">
        Create a new API key for webhook authentication
      </Text>
      <TextInput
        isOptional
        label="Label"
        onChange={setKeyName}
        placeholder="e.g., Production, Testing"
        value={keyName}
        width="100%"
      />
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
          variant: "secondary",
          onClick: () =>
            push(CreateApiKeyOverlay, { onCreated: setNewlyCreatedKey }),
        },
        { label: "Done", onClick: closeAll },
      ]}
      overlayId={overlayId}
      title="API Keys"
    >
      <Text color="secondary">Manage API keys for webhook authentication</Text>

      {isPending ? (
        <Spinner label="Loading API keys" />
      ) : (
        <VStack gap={4}>
          {/* Newly created key warning */}
          {newlyCreatedKey && (
            <Banner
              description={
                <HStack align="center" gap={2}>
                  <code {...stylex.props(styles.keyValue)}>
                    {newlyCreatedKey}
                  </code>
                  <IconButton
                    icon={<Icon icon={Copy} size="sm" />}
                    label="Copy API key"
                    onClick={() => copyToClipboard(newlyCreatedKey)}
                    size="sm"
                    variant="ghost"
                  />
                </HStack>
              }
              endContent={
                <Button
                  label="Dismiss"
                  onClick={() => setNewlyCreatedKey(null)}
                  size="sm"
                  variant="ghost"
                />
              }
              status="warning"
              title="Copy your API key now. You will not be able to see it again."
            />
          )}

          {/* API Keys list */}
          {apiKeys.length === 0 ? (
            <EmptyState
              description="Create an API key to authenticate webhook requests."
              icon={<Icon icon={Key} size="lg" />}
              isCompact
              title="No API keys yet"
            />
          ) : (
            <List density="balanced" hasDividers>
              {apiKeys.map((apiKey) => (
                <ListItem
                  description={
                    <Text color="secondary" type="supporting">
                      Created {formatDate(apiKey.createdAt)}
                      {apiKey.lastUsedAt &&
                        ` · Last used ${formatDate(apiKey.lastUsedAt)}`}
                    </Text>
                  }
                  endContent={
                    <IconButton
                      icon={<Icon icon={Trash2} size="sm" />}
                      isDisabled={deletingId === apiKey.id}
                      isLoading={deletingId === apiKey.id}
                      label={`Delete ${apiKey.name ?? apiKey.keyPrefix}`}
                      onClick={() => openDeleteConfirm(apiKey.id)}
                      size="sm"
                      variant="ghost"
                    />
                  }
                  key={apiKey.id}
                  label={apiKey.name ?? `${apiKey.keyPrefix}…`}
                  startContent={
                    <code {...stylex.props(styles.keyPrefix)}>
                      {apiKey.keyPrefix}...
                    </code>
                  }
                />
              ))}
            </List>
          )}
        </VStack>
      )}
    </Overlay>
  );
}

const styles = stylex.create({
  keyValue: {
    backgroundColor: colorVars["--color-neutral"],
    borderRadius: radiusVars["--radius-element"],
    flex: 1,
    fontFamily: "monospace",
    fontSize: 12,
    minWidth: 0,
    overflowWrap: "anywhere",
    paddingBlock: spacingVars["--spacing-1"],
    paddingInline: spacingVars["--spacing-2"],
  },
  keyPrefix: {
    backgroundColor: colorVars["--color-neutral"],
    borderRadius: radiusVars["--radius-element"],
    fontFamily: "monospace",
    fontSize: 12,
    paddingBlock: spacingVars["--spacing-0-5"],
    paddingInline: spacingVars["--spacing-1"],
  },
});
import * as stylex from "@stylexjs/stylex";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import {
  colorVars,
  radiusVars,
  spacingVars,
} from "@astryxdesign/core/theme/tokens.stylex";
