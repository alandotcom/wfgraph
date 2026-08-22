import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { colorVars, spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { EyeOff } from "lucide-react";
import { memo } from "react";
import {
  groupOutletHandle,
  isGroupNode,
} from "@wfgraph/shared/graph/node-group";
import type { WorkflowNodeData } from "#src/lib/workflow-graph-types";

type GroupNodeProps = NodeProps & { data?: WorkflowNodeData; id: string };

export const GroupNode = memo(({ data, selected, id }: GroupNodeProps) => {
  if (!data || !isGroupNode({ data })) return null;
  const isDisabled = data.enabled === false;

  return (
    <div
      {...stylex.props(
        styles.frame,
        selected && styles.selected,
        isDisabled && styles.disabled
      )}
      data-testid={`group-node-${id}`}
    >
      <Handle position={Position.Top} type="target" />
      <HStack align="center" gap={2} xstyle={styles.header}>
        {isDisabled ? (
          <span {...stylex.props(styles.disabledBadge)}>
            <Icon icon={EyeOff} size="sm" />
          </span>
        ) : null}
        <Text size="sm" weight="medium">
          {data.label || "Group"}
        </Text>
      </HStack>
      <Handle
        id={groupOutletHandle({ data, id })}
        position={Position.Bottom}
        type="source"
      />
    </div>
  );
});

GroupNode.displayName = "GroupNode";

const styles = stylex.create({
  frame: {
    backgroundColor: colorVars["--color-background-muted"],
    border: `1.5px solid ${colorVars["--color-border"]}`,
    borderRadius: 8,
    display: "flex",
    flexDirection: "column",
    height: "100%",
    width: "100%",
  },
  selected: { borderColor: colorVars["--color-accent"] },
  disabled: { opacity: 0.5 },
  header: {
    borderBottom: `1px solid ${colorVars["--color-border"]}`,
    flexShrink: 0,
    height: 36,
    paddingInline: spacingVars["--spacing-3"],
  },
  disabledBadge: {
    alignItems: "center",
    backgroundColor: colorVars["--color-text-secondary"],
    borderRadius: 999,
    color: colorVars["--color-background-card"],
    display: "flex",
    padding: spacingVars["--spacing-1"],
  },
});
