import { useAtomValue } from "jotai";
import { Plus, Trash2 } from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  edgesAtom,
  nodesAtom,
  selectedNodeAtom,
} from "@/client/lib/workflow-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BOOLEAN_OPERATOR_OPTIONS,
  type ConditionFieldDefinition,
  type ConditionFieldType,
  type ConditionModel,
  type ConditionRule,
  compileConditionModel,
  createDefaultConditionModel,
  createDefaultConditionRule,
  GROUP_LOGIC_OPTIONS,
  isTimestampAbsoluteConditionRule,
  isTimestampRelativeConditionRule,
  NUMBER_OPERATOR_OPTIONS,
  parseConditionModel,
  STRING_OPERATOR_OPTIONS,
  serializeConditionModel,
  TIME_UNIT_OPTIONS,
  TIMESTAMP_OPERATOR_OPTIONS,
  type TimestampAbsoluteOperator,
  type TimestampRelativeOperator,
  type TimeUnit,
} from "@/shared/workflow/conditions";
import {
  getWebhookConditionFields,
  type WebhookSchemaField,
} from "@/shared/workflow/webhook-field-registry";

type ConditionBuilderRowProps = {
  label: string;
  description: string;
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
  modelKey: "conditionModel" | "runConditionModel";
  expressionKey: "condition" | "runCondition";
  optional?: boolean;
};

function isTimestampRelativeOperatorValue(
  value: string
): value is TimestampRelativeOperator {
  return (
    value === "within_next" ||
    value === "more_than_from_now" ||
    value === "less_than_ago" ||
    value === "more_than_ago"
  );
}

function isTimestampAbsoluteOperatorValue(
  value: string
): value is TimestampAbsoluteOperator {
  return value === "before" || value === "after";
}

function isStringOperatorValue(
  value: string
): value is "equals" | "not_equals" | "contains" {
  return value === "equals" || value === "not_equals" || value === "contains";
}

function isNumberOperatorValue(
  value: string
): value is
  | "equals"
  | "not_equals"
  | "greater_than"
  | "greater_or_equal"
  | "less_than"
  | "less_or_equal" {
  return (
    value === "equals" ||
    value === "not_equals" ||
    value === "greater_than" ||
    value === "greater_or_equal" ||
    value === "less_than" ||
    value === "less_or_equal"
  );
}

function isBooleanOperatorValue(
  value: string
): value is "is_true" | "is_false" {
  return value === "is_true" || value === "is_false";
}

function isTimeUnitValue(value: string): value is TimeUnit {
  return TIME_UNIT_OPTIONS.some((option) => option.value === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWebhookSchemaField(value: unknown): value is WebhookSchemaField {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.name !== "string") {
    return false;
  }

  if (
    value.type !== "string" &&
    value.type !== "number" &&
    value.type !== "boolean" &&
    value.type !== "array" &&
    value.type !== "object"
  ) {
    return false;
  }

  if (
    value.itemType !== undefined &&
    value.itemType !== "string" &&
    value.itemType !== "number" &&
    value.itemType !== "boolean" &&
    value.itemType !== "object"
  ) {
    return false;
  }

  if (value.format !== undefined && value.format !== "timestamp") {
    return false;
  }

  if (value.fields !== undefined) {
    if (!Array.isArray(value.fields)) {
      return false;
    }
    if (!value.fields.every((field) => isWebhookSchemaField(field))) {
      return false;
    }
  }

  return true;
}

function getUpstreamNodeIds(
  nodeId: string,
  edges: Array<{ source: string; target: string }>
): string[] {
  const visited = new Set<string>();
  const upstream = new Set<string>();

  const traverse = (currentNodeId: string) => {
    if (visited.has(currentNodeId)) {
      return;
    }
    visited.add(currentNodeId);

    const incomingEdges = edges.filter((edge) => edge.target === currentNodeId);
    for (const edge of incomingEdges) {
      upstream.add(edge.source);
      traverse(edge.source);
    }
  };

  traverse(nodeId);
  return Array.from(upstream.values());
}

type ConditionBuilderNode = {
  id: string;
  data: {
    type: string;
    config?: Record<string, unknown>;
  };
};

function getWebhookFieldsFromTriggerNode(
  node: ConditionBuilderNode
): ConditionFieldDefinition[] {
  if (node.data.type !== "trigger") {
    return [];
  }

  const config = node.data.config;
  if (!config || config.triggerType !== "Webhook") {
    return [];
  }

  const rawSchema = config.webhookSchema;
  if (typeof rawSchema !== "string" || rawSchema.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawSchema);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return getWebhookConditionFields(
      parsed.filter((field) => isWebhookSchemaField(field))
    );
  } catch {
    // Ignore invalid schema and continue with any other trigger schemas.
    return [];
  }
}

function getUpstreamWebhookFields(input: {
  nodeId: string | null;
  nodes: ConditionBuilderNode[];
  edges: Array<{ source: string; target: string }>;
}): ConditionFieldDefinition[] {
  const { nodeId, nodes, edges } = input;
  if (!nodeId) {
    return [];
  }

  const upstreamNodeIds = new Set(getUpstreamNodeIds(nodeId, edges));
  const fieldsByPath = new Map<string, ConditionFieldDefinition>();

  for (const node of nodes) {
    if (!upstreamNodeIds.has(node.id)) {
      continue;
    }

    const webhookFields = getWebhookFieldsFromTriggerNode(node);
    for (const field of webhookFields) {
      if (!fieldsByPath.has(field.path)) {
        fieldsByPath.set(field.path, field);
      }
    }
  }

  return Array.from(fieldsByPath.values()).toSorted((a, b) =>
    a.path.localeCompare(b.path)
  );
}

function getOperatorOptionsByFieldType(fieldType: ConditionFieldType) {
  if (fieldType === "timestamp") {
    return TIMESTAMP_OPERATOR_OPTIONS;
  }

  if (fieldType === "string") {
    return STRING_OPERATOR_OPTIONS;
  }

  if (fieldType === "number") {
    return NUMBER_OPERATOR_OPTIONS;
  }

  return BOOLEAN_OPERATOR_OPTIONS;
}

function toLocalDateTimeInput(isoDateTime: string): string {
  const parsed = new Date(isoDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  const local = new Date(
    parsed.getTime() - parsed.getTimezoneOffset() * 60_000
  );
  return local.toISOString().slice(0, 16);
}

function toIsoDateTime(localDateTime: string): string {
  const parsed = new Date(localDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return parsed.toISOString();
}

function createInitialModel(field: ConditionFieldDefinition): ConditionModel {
  return createDefaultConditionModel(field, {
    groupId: nanoid(),
    conditionId: nanoid(),
  });
}

function createInitialRule(field: ConditionFieldDefinition): ConditionRule {
  return createDefaultConditionRule(field, nanoid());
}

function buildTimestampOperatorRule(input: {
  condition: Extract<ConditionRule, { fieldType: "timestamp" }>;
  operatorValue: string;
}): Extract<ConditionRule, { fieldType: "timestamp" }> | null {
  const { condition, operatorValue } = input;

  if (isTimestampRelativeOperatorValue(operatorValue)) {
    return {
      id: condition.id,
      field: condition.field,
      fieldType: "timestamp",
      operator: operatorValue,
      amount: isTimestampRelativeConditionRule(condition)
        ? condition.amount
        : 1,
      unit: isTimestampRelativeConditionRule(condition)
        ? condition.unit
        : "days",
    };
  }

  if (isTimestampAbsoluteOperatorValue(operatorValue)) {
    return {
      id: condition.id,
      field: condition.field,
      fieldType: "timestamp",
      operator: operatorValue,
      dateTime: isTimestampAbsoluteConditionRule(condition)
        ? condition.dateTime
        : new Date().toISOString(),
    };
  }

  return null;
}

function applyOperatorValueToCondition(
  condition: ConditionRule,
  operatorValue: string
): ConditionRule | null {
  if (condition.fieldType === "timestamp") {
    return buildTimestampOperatorRule({
      condition,
      operatorValue,
    });
  }

  if (condition.fieldType === "string") {
    if (!isStringOperatorValue(operatorValue)) {
      return null;
    }

    return {
      ...condition,
      operator: operatorValue,
    };
  }

  if (condition.fieldType === "number") {
    if (!isNumberOperatorValue(operatorValue)) {
      return null;
    }

    return {
      ...condition,
      operator: operatorValue,
    };
  }

  if (!isBooleanOperatorValue(operatorValue)) {
    return null;
  }

  return {
    ...condition,
    operator: operatorValue,
  };
}

function LogicToggle({
  value,
  onChange,
  disabled,
}: {
  value: "and" | "or";
  onChange: (value: "and" | "or") => void;
  disabled: boolean;
}) {
  return (
    <div className="inline-flex items-center rounded-full border bg-card p-0.5">
      {GROUP_LOGIC_OPTIONS.map((option) => {
        const active = option.value === value;
        return (
          <button
            className={`rounded-full px-3 py-1 font-medium text-xs transition-colors ${
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            disabled={disabled}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function ConditionValueInput(input: {
  condition: ConditionRule;
  disabled: boolean;
  onConditionChange: (condition: ConditionRule) => void;
}) {
  const { condition, disabled, onConditionChange } = input;

  if (condition.fieldType === "timestamp") {
    if (isTimestampRelativeConditionRule(condition)) {
      return (
        <>
          <Input
            className="w-24"
            disabled={disabled}
            min={1}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              onConditionChange({
                ...condition,
                amount: Number.isNaN(parsed) ? 1 : Math.max(parsed, 1),
              });
            }}
            type="number"
            value={condition.amount}
          />
          <Select
            disabled={disabled}
            onValueChange={(value) => {
              if (!isTimeUnitValue(value)) {
                return;
              }
              onConditionChange({
                ...condition,
                unit: value,
              });
            }}
            value={condition.unit}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_UNIT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      );
    }

    return (
      <Input
        disabled={disabled}
        onChange={(event) => {
          if (!isTimestampAbsoluteConditionRule(condition)) {
            return;
          }

          onConditionChange({
            ...condition,
            dateTime: toIsoDateTime(event.target.value),
          });
        }}
        type="datetime-local"
        value={
          isTimestampAbsoluteConditionRule(condition)
            ? toLocalDateTimeInput(condition.dateTime)
            : ""
        }
      />
    );
  }

  if (condition.fieldType === "string") {
    return (
      <Input
        disabled={disabled}
        onChange={(event) => {
          onConditionChange({
            ...condition,
            value: event.target.value,
          });
        }}
        placeholder="value"
        value={condition.value}
      />
    );
  }

  if (condition.fieldType === "number") {
    return (
      <Input
        disabled={disabled}
        onChange={(event) => {
          const parsed = Number.parseFloat(event.target.value);
          onConditionChange({
            ...condition,
            value: Number.isNaN(parsed) ? 0 : parsed,
          });
        }}
        placeholder="0"
        type="number"
        value={String(condition.value)}
      />
    );
  }

  return null;
}

export function ConditionBuilderRow({
  label,
  description,
  config,
  onUpdateConfig,
  disabled,
  modelKey,
  expressionKey,
  optional = false,
}: ConditionBuilderRowProps) {
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const [compileError, setCompileError] = useState<string | null>(null);

  const availableFields = useMemo(
    () =>
      getUpstreamWebhookFields({
        nodeId: selectedNodeId,
        nodes,
        edges,
      }),
    [selectedNodeId, nodes, edges]
  );

  const fieldByPath = useMemo(
    () => new Map(availableFields.map((field) => [field.path, field])),
    [availableFields]
  );

  const modelParseResult = parseConditionModel(config[modelKey]);
  const parsedModel = modelParseResult.valid ? modelParseResult.model : null;
  const expressionValue =
    typeof config[expressionKey] === "string"
      ? config[expressionKey].trim()
      : "";
  const modelValue =
    typeof config[modelKey] === "string" ? config[modelKey].trim() : "";
  const isConfigured = expressionValue.length > 0 || modelValue.length > 0;

  const persistModel = useCallback(
    (model: ConditionModel) => {
      const compiled = compileConditionModel(model);
      onUpdateConfig(modelKey, serializeConditionModel(model));

      if (!compiled.valid) {
        setCompileError(compiled.error);
        onUpdateConfig(expressionKey, "");
        return;
      }

      setCompileError(null);
      onUpdateConfig(expressionKey, compiled.expression);
    },
    [expressionKey, modelKey, onUpdateConfig]
  );

  const clearCondition = useCallback(() => {
    setCompileError(null);
    onUpdateConfig(modelKey, "");
    onUpdateConfig(expressionKey, "");
  }, [expressionKey, modelKey, onUpdateConfig]);

  const addConditionModel = useCallback(() => {
    const firstField = availableFields[0];
    if (!firstField) {
      return;
    }

    persistModel(createInitialModel(firstField));
  }, [availableFields, persistModel]);

  useEffect(() => {
    if (optional) {
      return;
    }

    if (parsedModel || modelValue.length > 0) {
      return;
    }

    const firstField = availableFields[0];
    if (!firstField) {
      return;
    }

    queueMicrotask(() => {
      persistModel(createInitialModel(firstField));
    });
  }, [availableFields, modelValue.length, optional, parsedModel, persistModel]);

  useEffect(() => {
    if (!parsedModel || availableFields.length === 0) {
      return;
    }

    let changed = false;
    const fallbackField = availableFields[0];

    const groups = parsedModel.groups.map((group) => ({
      ...group,
      conditions: group.conditions.map((condition) => {
        const selectedField = fieldByPath.get(condition.field);
        if (!selectedField) {
          changed = true;
          return createDefaultConditionRule(fallbackField, condition.id);
        }

        if (selectedField.type !== condition.fieldType) {
          changed = true;
          return createDefaultConditionRule(selectedField, condition.id);
        }

        return condition;
      }),
    }));

    if (!changed) {
      return;
    }

    queueMicrotask(() => {
      persistModel({
        ...parsedModel,
        groups,
      });
    });
  }, [availableFields, fieldByPath, parsedModel, persistModel]);

  const updateGroup = (
    groupId: string,
    updater: (
      group: ConditionModel["groups"][number]
    ) => ConditionModel["groups"][number]
  ) => {
    if (!parsedModel) {
      return;
    }

    persistModel({
      ...parsedModel,
      groups: parsedModel.groups.map((group) =>
        group.id === groupId ? updater(group) : group
      ),
    });
  };

  const updateCondition = (
    groupId: string,
    conditionId: string,
    updater: (condition: ConditionRule) => ConditionRule
  ) => {
    updateGroup(groupId, (group) => ({
      ...group,
      conditions: group.conditions.map((condition) =>
        condition.id === conditionId ? updater(condition) : condition
      ),
    }));
  };

  const addConditionToGroup = (groupId: string) => {
    if (!parsedModel) {
      return;
    }

    const firstField = availableFields[0];
    if (!firstField) {
      return;
    }

    updateGroup(groupId, (group) => ({
      ...group,
      conditions: [...group.conditions, createInitialRule(firstField)],
    }));
  };

  const removeConditionFromGroup = (groupId: string, conditionId: string) => {
    if (!parsedModel) {
      return;
    }

    updateGroup(groupId, (group) => {
      if (group.conditions.length <= 1) {
        return group;
      }

      return {
        ...group,
        conditions: group.conditions.filter(
          (condition) => condition.id !== conditionId
        ),
      };
    });
  };

  const addGroup = () => {
    if (!parsedModel) {
      return;
    }

    const firstField = availableFields[0];
    if (!firstField) {
      return;
    }

    persistModel({
      ...parsedModel,
      groups: [
        ...parsedModel.groups,
        {
          id: nanoid(),
          logic: "and",
          conditions: [createInitialRule(firstField)],
        },
      ],
    });
  };

  const removeGroup = (groupId: string) => {
    if (!parsedModel || parsedModel.groups.length <= 1) {
      return;
    }

    persistModel({
      ...parsedModel,
      groups: parsedModel.groups.filter((group) => group.id !== groupId),
    });
  };

  if (optional && !isConfigured) {
    return (
      <div className="space-y-2 rounded-md border bg-muted/30 p-3">
        <Label className="text-sm">{label}</Label>
        <p className="text-muted-foreground text-xs">{description}</p>
        <Button
          disabled={disabled || availableFields.length === 0}
          onClick={addConditionModel}
          size="sm"
          type="button"
          variant="outline"
        >
          Add run condition
        </Button>
        {availableFields.length === 0 && (
          <p className="text-muted-foreground text-xs">
            Define webhook schema fields first. Timestamp behavior appears when
            a field is marked as timestamp.
          </p>
        )}
      </div>
    );
  }

  if (!parsedModel) {
    return (
      <div className="space-y-2 rounded-md border bg-muted/30 p-3">
        <Label className="text-sm">{label}</Label>
        <p className="text-muted-foreground text-xs">{description}</p>
        {availableFields.length === 0 ? (
          <p className="text-destructive text-xs">
            No webhook fields are available. Define a webhook schema first.
          </p>
        ) : (
          <Button
            disabled={disabled}
            onClick={addConditionModel}
            size="sm"
            type="button"
            variant="outline"
          >
            Configure condition
          </Button>
        )}
        {modelValue && !modelParseResult.valid && (
          <p className="text-destructive text-xs">{modelParseResult.error}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <div className="space-y-1">
        <Label className="text-sm">{label}</Label>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>

      <div className="space-y-3">
        {parsedModel.groups.map((group, groupIndex) => (
          <div key={group.id}>
            <div className="rounded-lg border bg-card">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-muted px-2 py-1 font-medium text-xs">
                    {groupIndex + 1}
                  </span>
                  <span className="font-medium text-sm">Filter group</span>
                  <span className="text-muted-foreground text-xs">
                    {group.conditions.length}{" "}
                    {group.conditions.length === 1 ? "condition" : "conditions"}
                  </span>
                </div>
                <Button
                  disabled={disabled || parsedModel.groups.length <= 1}
                  onClick={() => removeGroup(group.id)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>

              <div className="space-y-3 p-3">
                {group.conditions.map((condition, conditionIndex) => {
                  const operatorOptions = getOperatorOptionsByFieldType(
                    condition.fieldType
                  );
                  const canDeleteCondition = group.conditions.length > 1;

                  return (
                    <div key={condition.id}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          disabled={disabled}
                          onValueChange={(fieldPath) => {
                            const field = fieldByPath.get(fieldPath);
                            if (!field) {
                              return;
                            }

                            updateCondition(group.id, condition.id, () =>
                              createDefaultConditionRule(field, condition.id)
                            );
                          }}
                          value={condition.field}
                        >
                          <SelectTrigger className="min-w-[190px]">
                            <SelectValue placeholder="Select property" />
                          </SelectTrigger>
                          <SelectContent>
                            {availableFields.map((field) => (
                              <SelectItem key={field.path} value={field.path}>
                                {field.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <Select
                          disabled={disabled}
                          onValueChange={(operatorValue) => {
                            const nextCondition = applyOperatorValueToCondition(
                              condition,
                              operatorValue
                            );
                            if (!nextCondition) {
                              return;
                            }

                            updateCondition(
                              group.id,
                              condition.id,
                              () => nextCondition
                            );
                          }}
                          value={condition.operator}
                        >
                          <SelectTrigger className="min-w-[190px]">
                            <SelectValue placeholder="Select operator" />
                          </SelectTrigger>
                          <SelectContent>
                            {operatorOptions.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <ConditionValueInput
                          condition={condition}
                          disabled={disabled}
                          onConditionChange={(nextCondition) => {
                            updateCondition(
                              group.id,
                              condition.id,
                              () => nextCondition
                            );
                          }}
                        />

                        <Button
                          disabled={disabled || !canDeleteCondition}
                          onClick={() =>
                            removeConditionFromGroup(group.id, condition.id)
                          }
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>

                      {conditionIndex < group.conditions.length - 1 && (
                        <div className="py-2 pl-2">
                          <LogicToggle
                            disabled={disabled}
                            onChange={(value) => {
                              updateGroup(group.id, (existing) => ({
                                ...existing,
                                logic: value,
                              }));
                            }}
                            value={group.logic}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}

                <Button
                  disabled={disabled || availableFields.length === 0}
                  onClick={() => addConditionToGroup(group.id)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Plus className="size-4" />
                  Add condition
                </Button>
              </div>
            </div>

            {groupIndex < parsedModel.groups.length - 1 && (
              <div className="flex justify-center py-2">
                <LogicToggle
                  disabled={disabled}
                  onChange={(value) => {
                    persistModel({
                      ...parsedModel,
                      groupLogic: value,
                    });
                  }}
                  value={parsedModel.groupLogic}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex justify-center">
        <Button
          disabled={disabled || availableFields.length === 0}
          onClick={addGroup}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus className="size-4" />
          Add group
        </Button>
      </div>

      {compileError && (
        <p className="text-destructive text-xs">{compileError}</p>
      )}
      {!compileError && expressionValue && (
        <p className="text-muted-foreground text-xs">
          Compiled CEL: {expressionValue}
        </p>
      )}

      {optional && (
        <Button
          className="px-0 text-destructive"
          disabled={disabled}
          onClick={clearCondition}
          size="sm"
          type="button"
          variant="link"
        >
          Remove run condition
        </Button>
      )}
    </div>
  );
}
