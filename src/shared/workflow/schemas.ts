import { z } from "zod";

export const workflowNodeTypeSchema = z.enum(["trigger", "action", "add"]);

export const workflowNodeDataSchema = z
  .object({
    label: z.string(),
    description: z.string().optional(),
    type: workflowNodeTypeSchema,
    config: z.record(z.string(), z.unknown()).optional(),
    status: z
      .enum(["idle", "running", "success", "error", "cancelled"])
      .optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();

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
  .passthrough();

export const workflowEdgeAttributesSchema = z
  .object({
    id: z.string().trim().min(1),
    source: z.string().trim().min(1),
    target: z.string().trim().min(1),
  })
  .passthrough();

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
