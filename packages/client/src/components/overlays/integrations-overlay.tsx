import { Search } from "lucide-react";
import { useCallback, useState } from "react";
import { IntegrationsManager } from "#src/components/settings/integrations-manager";
import { AddConnectionOverlay } from "./add-connection-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

type IntegrationsOverlayProps = {
  overlayId: string;
};

export function IntegrationsOverlay({ overlayId }: IntegrationsOverlayProps) {
  const { push, closeAll } = useOverlay();
  const [filter, setFilter] = useState("");

  const handleAddConnection = () => {
    push(AddConnectionOverlay, {});
  };

  const handleClose = useCallback(() => closeAll(), [closeAll]);

  return (
    <Overlay
      actions={[
        {
          label: "Add Connection",
          variant: "secondary",
          onClick: handleAddConnection,
        },
        { label: "Done", onClick: handleClose },
      ]}
      overlayId={overlayId}
      title="Connections"
    >
      <Text color="secondary">
        Manage API keys and credentials used by your workflows
      </Text>

      <VStack gap={4}>
        <TextInput
          isLabelHidden
          label="Filter connections"
          onChange={setFilter}
          placeholder="Filter connections..."
          startIcon={<Icon icon={Search} size="sm" />}
          value={filter}
          width="100%"
        />
        <div {...stylex.props(styles.list)}>
          <IntegrationsManager filter={filter} />
        </div>
      </VStack>
    </Overlay>
  );
}

const styles = stylex.create({
  list: {
    maxHeight: 300,
    overflowY: "auto",
  },
});
import * as stylex from "@stylexjs/stylex";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
