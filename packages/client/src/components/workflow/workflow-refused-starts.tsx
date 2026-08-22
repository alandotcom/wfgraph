import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { List } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { Ban } from "lucide-react";
import type { RefusedStart } from "#src/lib/execution-logs";
import { getRelativeTime } from "@wfgraph/shared/utils/time";

export function WorkflowRefusedStarts({
  refusedStarts,
}: {
  refusedStarts: RefusedStart[];
}) {
  if (refusedStarts.length === 0) return null;

  return (
    <Card padding={3}>
      <VStack gap={2}>
        <HStack align="center" gap={2}>
          <Icon icon={Ban} size="sm" />
          <Text size="sm" weight="medium">
            Refused Starts
          </Text>
        </HStack>
        <List density="compact" hasDividers>
          {refusedStarts.map((refusal) => (
            <li key={refusal.id}>
              <HStack align="start" gap={3} justify="between">
                <Text size="sm">{refusal.message}</Text>
                <Text color="secondary" size="sm">
                  {getRelativeTime(refusal.createdAt)}
                </Text>
              </HStack>
            </li>
          ))}
        </List>
      </VStack>
    </Card>
  );
}
