import type { NodeProps } from "@xyflow/react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

type AddNodeData = {
  onClick?: () => void;
};

export function AddNode({ data }: NodeProps & { data?: AddNodeData }) {
  return (
    <div className="flex items-center justify-center rounded-lg border border-border border-dashed bg-background/50 p-8 backdrop-blur-sm">
      <Button className="gap-2 shadow-lg" onClick={data.onClick} size="default">
        <Plus className="size-4" />
        Add a Step
      </Button>
    </div>
  );
}
