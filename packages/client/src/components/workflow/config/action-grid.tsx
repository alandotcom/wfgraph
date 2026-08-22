import * as stylex from "@stylexjs/stylex";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import {
  Eye,
  EyeOff,
  Grid3X3,
  List,
  Search,
  Settings,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { IntegrationIcon } from "#src/components/integration-icon";
import { hasTouchSupport } from "#src/hooks/use-touch";
import {
  selectableActions,
  type ActionMetadata,
} from "@wfgraph/shared/extensions/catalog";

function useAllActions(): readonly ActionMetadata[] {
  const catalog = useExtensionCatalog();
  return useMemo(() => selectableActions(catalog), [catalog]);
}

type ActionGridProps = {
  onSelectAction: (actionType: string) => void;
  disabled?: boolean;
  isNewlyCreated?: boolean;
};

function ActionIcon({ action }: { action: ActionMetadata }) {
  if (action.integration) {
    return <IntegrationIcon integration={action.integration} />;
  }
  return (
    <Icon
      color="secondary"
      icon={action.category === "System" ? Settings : Zap}
      size="md"
    />
  );
}

const HIDDEN_GROUPS_KEY = "workflow-action-grid-hidden-groups";
const VIEW_MODE_KEY = "workflow-action-grid-view-mode";
type ViewMode = "list" | "grid";

function getInitialHiddenGroups(): Set<string> {
  try {
    const stored = localStorage.getItem(HIDDEN_GROUPS_KEY);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

function getInitialViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export function ActionGrid({
  onSelectAction,
  disabled,
  isNewlyCreated,
}: ActionGridProps) {
  const [filter, setFilter] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set()
  );
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(
    getInitialHiddenGroups
  );
  const [showHidden, setShowHidden] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(getInitialViewMode);
  const actions = useAllActions();

  const toggleViewMode = () => {
    const next = viewMode === "list" ? "grid" : "list";
    setViewMode(next);
    localStorage.setItem(VIEW_MODE_KEY, next);
  };

  const toggleGroup = (category: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const toggleHideGroup = (category: string) => {
    setHiddenGroups((current) => {
      const next = new Set(current);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      localStorage.setItem(HIDDEN_GROUPS_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const groupedActions = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const filtered = actions.filter(
      (action) =>
        !query ||
        action.label.toLowerCase().includes(query) ||
        action.description.toLowerCase().includes(query) ||
        action.category.toLowerCase().includes(query)
    );
    const groups = Map.groupBy(filtered, (action) => action.category);
    const categories = [...groups.keys()].toSorted((a, b) => {
      if (a === "System") return -1;
      if (b === "System") return 1;
      return a.localeCompare(b);
    });
    return {
      filtered,
      groups: categories.map((category) => ({
        category,
        actions: groups.get(category) ?? [],
      })),
    };
  }, [actions, filter]);

  const visibleGroups = groupedActions.groups.filter(
    (group) => showHidden || !hiddenGroups.has(group.category)
  );
  const visibleActions = groupedActions.filtered.filter(
    (action) => showHidden || !hiddenGroups.has(action.category)
  );

  return (
    <VStack gap={3} xstyle={styles.frame}>
      <HStack gap={2} xstyle={styles.controls}>
        <TextInput
          data-testid="action-search-input"
          hasAutoFocus={isNewlyCreated === true && !hasTouchSupport()}
          isDisabled={disabled}
          isLabelHidden
          label="Search actions"
          onChange={setFilter}
          placeholder="Search actions"
          startIcon={<Icon icon={Search} size="sm" />}
          value={filter}
          width="100%"
        />
        <IconButton
          icon={<Icon icon={viewMode === "list" ? Grid3X3 : List} size="sm" />}
          label={viewMode === "list" ? "Grid view" : "List view"}
          onClick={toggleViewMode}
          size="sm"
          tooltip={viewMode === "list" ? "Grid view" : "List view"}
          variant="ghost"
        />
        {hiddenGroups.size > 0 ? (
          <IconButton
            icon={<Icon icon={showHidden ? Eye : EyeOff} size="sm" />}
            label={showHidden ? "Hide hidden groups" : "Show hidden groups"}
            onClick={() => setShowHidden((current) => !current)}
            size="sm"
            tooltip={showHidden ? "Hide hidden groups" : "Show hidden groups"}
            variant="ghost"
          />
        ) : null}
      </HStack>

      <div data-testid="action-grid" {...stylex.props(styles.results)}>
        {groupedActions.filtered.length === 0 ? (
          <Text color="secondary">No actions found</Text>
        ) : null}
        {groupedActions.filtered.length > 0 && visibleGroups.length === 0 ? (
          <Text color="secondary">All groups are hidden</Text>
        ) : null}

        {viewMode === "grid" && visibleActions.length > 0 ? (
          <Grid columns={{ minWidth: 88 }} gap={2}>
            {visibleActions.map((action) => (
              <ClickableCard
                data-testid={`action-option-${action.id.toLowerCase().replace(/\s+/g, "-")}`}
                isDisabled={disabled}
                key={action.id}
                label={action.label}
                onClick={() => onSelectAction(action.id)}
                padding={3}
              >
                <VStack align="center" gap={2}>
                  <ActionIcon action={action} />
                  <Text maxLines={2} type="label" xstyle={styles.centerText}>
                    {action.label}
                  </Text>
                </VStack>
              </ClickableCard>
            ))}
          </Grid>
        ) : null}

        {viewMode === "list" ? (
          <VStack gap={2}>
            {visibleGroups.map((group) => {
              const hidden = hiddenGroups.has(group.category);
              const firstAction = group.actions[0];
              return (
                <VStack gap={1} key={group.category}>
                  <HStack align="center" gap={2} justify="between">
                    <Collapsible
                      isOpen={!collapsedGroups.has(group.category)}
                      onOpenChange={() => toggleGroup(group.category)}
                      trigger={
                        <HStack align="center" gap={2}>
                          {firstAction?.integration ? (
                            <IntegrationIcon
                              integration={firstAction.integration}
                            />
                          ) : (
                            <Icon
                              icon={
                                group.category === "System" ? Settings : Zap
                              }
                              size="sm"
                            />
                          )}
                          <Text
                            color={hidden ? "disabled" : "secondary"}
                            type="label"
                          >
                            {group.category}
                          </Text>
                        </HStack>
                      }
                      xstyle={styles.group}
                    >
                      <VStack gap={1} paddingBlock={1}>
                        {group.actions.map((action) => (
                          <ClickableCard
                            data-testid={`action-option-${action.id.toLowerCase().replace(/\s+/g, "-")}`}
                            isDisabled={disabled}
                            key={action.id}
                            label={action.label}
                            onClick={() => onSelectAction(action.id)}
                            padding={2}
                            variant="transparent"
                          >
                            <VStack gap={0.5}>
                              <Text type="label">{action.label}</Text>
                              {action.description ? (
                                <Text
                                  color="secondary"
                                  maxLines={2}
                                  type="supporting"
                                >
                                  {action.description}
                                </Text>
                              ) : null}
                            </VStack>
                          </ClickableCard>
                        ))}
                      </VStack>
                    </Collapsible>
                    <DropdownMenu
                      alignment="end"
                      button={{
                        label: `${group.category} options`,
                        variant: "ghost",
                      }}
                      items={[
                        {
                          icon: hidden ? Eye : EyeOff,
                          label: hidden ? "Show group" : "Hide group",
                          onClick: () => toggleHideGroup(group.category),
                        },
                      ]}
                    />
                  </HStack>
                </VStack>
              );
            })}
          </VStack>
        ) : null}
      </div>
    </VStack>
  );
}

const styles = stylex.create({
  frame: {
    flex: 1,
    minHeight: 0,
  },
  controls: {
    flexShrink: 0,
  },
  results: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingBottom: spacingVars["--spacing-4"],
  },
  group: {
    flex: 1,
    minWidth: 0,
  },
  centerText: {
    textAlign: "center",
  },
});
