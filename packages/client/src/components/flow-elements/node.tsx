import { Handle, Position } from "@xyflow/react";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { AnimatedBorder } from "@/components/ui/animated-border";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { cn } from "@/shared/utils";

export type NodeProps = ComponentProps<typeof Card> & {
  handles: {
    target: boolean | NodeHandleConfig[];
    source: boolean | NodeHandleConfig[];
  };
  status?: "idle" | "running" | "success" | "error" | "cancelled";
};

type NodeHandleConfig = {
  id?: string;
  position: Position;
  style?: CSSProperties;
};

function renderHandles(
  handleType: "source" | "target",
  config: boolean | NodeHandleConfig[]
): ReactNode {
  if (config === false) {
    return null;
  }

  if (config === true) {
    return (
      <Handle
        position={handleType === "source" ? Position.Bottom : Position.Top}
        type={handleType}
      />
    );
  }

  return config.map((handleConfig) => {
    const fallbackKey = [
      handleType,
      handleConfig.position,
      handleConfig.style?.top,
      handleConfig.style?.right,
      handleConfig.style?.bottom,
      handleConfig.style?.left,
    ].join(":");

    return (
      <Handle
        id={handleConfig.id}
        key={handleConfig.id ?? fallbackKey}
        position={handleConfig.position}
        style={handleConfig.style}
        type={handleType}
      />
    );
  });
}

export const Node = ({ handles, className, status, ...props }: NodeProps) => (
  <Card
    className={cn(
      "node-container relative size-full h-auto w-sm gap-0 overflow-visible rounded-md bg-card p-0 transition-all duration-200",
      status === "success" && "border-2 border-green-500",
      status === "error" && "border-2 border-red-500",
      status === "cancelled" && "border-2 border-slate-500",
      className
    )}
    {...props}
  >
    {status === "running" && <AnimatedBorder />}
    {renderHandles("target", handles.target)}
    {renderHandles("source", handles.source)}
    {props.children}
  </Card>
);

export type NodeTitleProps = ComponentProps<typeof CardTitle>;

export const NodeTitle = (props: NodeTitleProps) => <CardTitle {...props} />;

export type NodeDescriptionProps = ComponentProps<typeof CardDescription>;

export const NodeDescription = (props: NodeDescriptionProps) => (
  <CardDescription {...props} />
);
