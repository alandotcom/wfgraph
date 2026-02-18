import { z } from "zod";

export const workflowNodeTypeSchema = z.enum(["trigger", "action", "add"]);

export const webhookTriggerConfigSchema = z
  .object({
    triggerType: z.literal("Webhook"),
    webhookSchema: z.string().optional(),
    webhookEventPath: z.string().optional(),
    webhookCorrelationPath: z.string().optional(),
    webhookCreateEvents: z.string().optional(),
    webhookUpdateEvents: z.string().optional(),
    webhookDeleteEvents: z.string().optional(),
    webhookMockRequest: z.string().optional(),
  })
  .strict();

export const scheduleTriggerConfigSchema = z
  .object({
    triggerType: z.literal("Schedule"),
    scheduleExpression: z.string().optional(),
    scheduleCron: z.string().optional(),
    scheduleTimezone: z.string().optional(),
  })
  .strict();

export const customTriggerConfigSchema = z
  .object({
    triggerType: z.string().trim().min(1),
  })
  .catchall(z.unknown())
  .refine(
    (value) =>
      value.triggerType !== "Webhook" && value.triggerType !== "Schedule",
    {
      message: 'Custom triggerType must not be "Webhook" or "Schedule"',
      path: ["triggerType"],
    }
  );

export const workflowTriggerConfigSchema = z.union([
  webhookTriggerConfigSchema,
  scheduleTriggerConfigSchema,
  customTriggerConfigSchema,
]);
// When adding a new first-class trigger type (beyond Webhook/Schedule):
// - Add a dedicated schema here and include it in this union.
// - Mirror the trigger option + config UI in `src/components/workflow/config/trigger-config.tsx`.
// Custom trigger configs are still accepted through `customTriggerConfigSchema`.

const workflowNodeDataBaseSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
  status: z
    .enum(["idle", "running", "success", "error", "cancelled"])
    .optional(),
  enabled: z.boolean().optional(),
});

const workflowTriggerNodeDataSchema = workflowNodeDataBaseSchema
  .extend({
    type: z.literal("trigger"),
    config: workflowTriggerConfigSchema.optional(),
  })
  .loose();

const workflowNonTriggerNodeDataSchema = workflowNodeDataBaseSchema
  .extend({
    type: z.enum(["action", "add"]),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

export const workflowNodeDataSchema = z.discriminatedUnion("type", [
  workflowTriggerNodeDataSchema,
  workflowNonTriggerNodeDataSchema,
]);

export type WebhookTriggerConfigInput = z.infer<
  typeof webhookTriggerConfigSchema
>;
export type ScheduleTriggerConfigInput = z.infer<
  typeof scheduleTriggerConfigSchema
>;
export type CustomTriggerConfigInput = z.infer<
  typeof customTriggerConfigSchema
>;
export type WorkflowTriggerConfigInput = z.infer<
  typeof workflowTriggerConfigSchema
>;

export const workflowNodeAttributesSchema = z
  .object({
    id: z.string().trim().min(1),
    type: z.string().optional(),
    position: z
      .object({
        x: z.number(),
        y: z.number(),
      })
      .optional(),
    data: workflowNodeDataSchema,
  })
  .loose();

export const workflowEdgeAttributesSchema = z
  .object({
    id: z.string().trim().min(1),
    source: z.string().trim().min(1),
    target: z.string().trim().min(1),
  })
  .loose();

export const serializedWorkflowNodeSchema = z
  .object({
    key: z.string().trim().min(1),
    attributes: workflowNodeAttributesSchema,
  })
  .strict();

export const serializedWorkflowEdgeSchema = z
  .object({
    key: z.string().trim().min(1),
    source: z.string().trim().min(1),
    target: z.string().trim().min(1),
    attributes: workflowEdgeAttributesSchema,
    undirected: z.literal(false).optional(),
  })
  .strict();

export const serializedWorkflowGraphSchema = z
  .object({
    attributes: z.record(z.string(), z.unknown()).optional(),
    options: z
      .object({
        allowSelfLoops: z.boolean().optional(),
        multi: z.boolean().optional(),
        type: z.enum(["directed", "undirected", "mixed"]).optional(),
      })
      .optional(),
    nodes: z.array(serializedWorkflowNodeSchema),
    edges: z.array(serializedWorkflowEdgeSchema),
  })
  .strict();

export type SerializedWorkflowGraphInput = z.infer<
  typeof serializedWorkflowGraphSchema
>;
