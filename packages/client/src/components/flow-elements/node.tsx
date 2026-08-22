import * as stylex from "@stylexjs/stylex";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { colorVars, spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import { Handle, Position } from "@xyflow/react";
import { Ban, Check, Loader2, XCircle } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { AnimatedBorder } from "#src/components/flow-elements/animated-border";

export type NodeProps = {
  children?: ReactNode;
  className?: string;
  "data-testid"?: string;
  handles: { target: boolean | NodeHandleConfig[]; source: boolean | NodeHandleConfig[] };
  status?: "idle" | "running" | "success" | "error" | "cancelled";
  style?: CSSProperties;
  xstyle?: stylex.StyleXStyles;
};

const STATUS_CHIP = {
  running: { label: "Running", Icon: Loader2, style: "statusRunning" },
  success: { label: "Succeeded", Icon: Check, style: "statusSuccess" },
  error: { label: "Failed", Icon: XCircle, style: "statusError" },
  cancelled: { label: "Cancelled", Icon: Ban, style: "statusCancelled" },
} as const;

const NodeStatusChip = ({ status }: { status?: NodeProps["status"] }) => {
  if (!status || status === "idle") return null;
  const chip = STATUS_CHIP[status];
  return (
    <HStack align="center" gap={1} xstyle={[styles.statusChip, styles[chip.style]]}>
      <Icon icon={chip.Icon} size="sm" />
      <Text size="sm" weight="medium">{chip.label}</Text>
    </HStack>
  );
};

type NodeHandleConfig = {
  id?: string;
  position: Position;
  style?: CSSProperties;
  className?: string;
};

function renderHandles(handleType: "source" | "target", config: boolean | NodeHandleConfig[]): ReactNode {
  if (config === false) return null;
  if (config === true) return <Handle position={handleType === "source" ? Position.Bottom : Position.Top} type={handleType} />;
  return config.map((handleConfig) => {
    const fallbackKey = [handleType, handleConfig.position, handleConfig.style?.top, handleConfig.style?.right, handleConfig.style?.bottom, handleConfig.style?.left].join(":");
    return <Handle className={handleConfig.className} id={handleConfig.id} key={handleConfig.id ?? fallbackKey} position={handleConfig.position} style={handleConfig.style} type={handleType} />;
  });
}

export const Node = ({ handles, status, style, xstyle, children, className, "data-testid": testId }: NodeProps) => (
  <Card className={className ? `node-container ${className}` : "node-container"} data-testid={testId} padding={0} style={style} xstyle={[styles.node, status && status !== "idle" && styles[status], xstyle]}>
    {status === "running" ? <AnimatedBorder /> : null}
    <NodeStatusChip status={status} />
    {renderHandles("target", handles.target)}
    {renderHandles("source", handles.source)}
    {children}
  </Card>
);

export const NodeTitle = ({ children, xstyle }: { children: ReactNode; xstyle?: stylex.StyleXStyles }) => (
  <Text size="sm" weight="medium" xstyle={[styles.nodeText, xstyle]}>{children}</Text>
);

export const NodeDescription = ({ children, xstyle }: { children: ReactNode; xstyle?: stylex.StyleXStyles }) => (
  <Text color="secondary" size="sm" xstyle={[styles.nodeText, xstyle]}>{children}</Text>
);

export const NodeBody = ({ children, xstyle }: { children: ReactNode; xstyle?: stylex.StyleXStyles }) => (
  <div {...stylex.props(styles.body, xstyle)}>{children}</div>
);

const styles = stylex.create({
  node: {
    alignItems: "center",
    backgroundColor: colorVars["--color-background-card"],
    borderColor: colorVars["--color-border"],
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1.5,
    boxShadow: "none",
    display: "flex",
    flexDirection: "column",
    gap: 0,
    justifyContent: "center",
    overflow: "visible",
    position: "relative",
  },
  running: { borderColor: colorVars["--color-accent"] },
  success: { borderColor: colorVars["--color-text-green"], borderWidth: 2 },
  error: { borderColor: colorVars["--color-error"], borderWidth: 2 },
  cancelled: { borderColor: colorVars["--color-text-secondary"], borderWidth: 2 },
  statusChip: {
    borderRadius: 4,
    paddingBlock: 2,
    paddingInline: spacingVars["--spacing-2"],
    position: "absolute",
    right: spacingVars["--spacing-2"],
    top: spacingVars["--spacing-2"],
    zIndex: 10,
  },
  statusRunning: { backgroundColor: colorVars["--color-accent-muted"] },
  statusSuccess: { backgroundColor: colorVars["--color-neutral"] },
  statusError: { backgroundColor: colorVars["--color-neutral"] },
  statusCancelled: { backgroundColor: colorVars["--color-neutral"] },
  body: {
    alignItems: "center",
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-1"],
    justifyContent: "center",
    paddingBlock: spacingVars["--spacing-2"],
    paddingInline: spacingVars["--spacing-3"],
    textAlign: "center",
    width: "100%",
  },
  nodeText: { maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" },
});
