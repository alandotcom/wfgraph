import { fixtureCatalog } from "@wfgraph/agent/tools/catalog-fixture";
import { serializeConditionModel } from "@wfgraph/shared/conditions/condition-schema";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { AgentDocument } from "@wfgraph/agent/document";
import type { AgentEvalInput } from "#src/agent/types";

export const emptyDocument: AgentDocument = { nodes: [], edges: [] };

export const evalCatalog: ExtensionCatalog = {
  ...fixtureCatalog,
  events: [
    ...fixtureCatalog.events,
    {
      name: "slack/candidate.referred",
      label: "Slack candidate referred",
      description: "Raised when a candidate referral arrives through Slack.",
      integration: "slack",
      correlationPath: "applicantId",
      payloadFields: [
        { path: "applicantId", type: "string" },
        { path: "email", type: "string" },
      ],
    },
    {
      name: "app/appointment.created",
      label: "Appointment created",
      description: "Raised when a new appointment is booked.",
      correlationPath: "appointment.id",
      payloadFields: [
        { path: "appointment.id", type: "string" },
        { path: "appointment.startsAt", type: "timestamp" },
        { path: "appointment.patientName", type: "string" },
        { path: "appointment.status", type: "string" },
        { path: "occurredAt", type: "timestamp" },
      ],
    },
    {
      name: "app/appointment.rescheduled",
      label: "Appointment rescheduled",
      description: "Raised when an appointment moves to a new time.",
      correlationPath: "appointment.id",
      payloadFields: [
        { path: "appointment.id", type: "string" },
        { path: "appointment.startsAt", type: "timestamp" },
        { path: "appointment.patientName", type: "string" },
        { path: "appointment.status", type: "string" },
        { path: "occurredAt", type: "timestamp" },
        { path: "previousStartsAt", type: "timestamp" },
      ],
    },
    {
      name: "app/appointment.canceled",
      label: "Appointment canceled",
      description: "Raised when an appointment is called off.",
      correlationPath: "appointment.id",
      payloadFields: [
        { path: "appointment.id", type: "string" },
        { path: "appointment.startsAt", type: "timestamp" },
        { path: "appointment.patientName", type: "string" },
        { path: "appointment.status", type: "string" },
        { path: "occurredAt", type: "timestamp" },
        { path: "reason", type: "string" },
      ],
    },
    {
      name: "billing/payment.settled",
      label: "Payment settled",
      description: "Raised by the billing service when a charge clears.",
      correlationPath: "appointmentId",
      payloadFields: [
        { path: "appointmentId", type: "string" },
        { path: "amountCents", type: "number" },
        { path: "settledAt", type: "timestamp" },
      ],
    },
  ],
  actions: [
    ...fixtureCatalog.actions,
    {
      id: "crm/get-applicant",
      label: "Get applicant",
      description: "Read the applicant's current CRM profile.",
      category: "CRM",
      configFields: [
        {
          key: "applicantId",
          label: "Applicant",
          type: "template-input",
          required: true,
        },
      ],
      outputFields: [
        { path: "email", type: "string" },
        { path: "department", type: "string", nullable: true },
      ],
    },
    {
      id: "appointments/cancel",
      label: "Cancel Appointment",
      description: "Cancels an appointment and records the reason.",
      category: "Appointments",
      sideEffect: true,
      configFields: [
        {
          key: "appointmentId",
          label: "Appointment ID",
          type: "template-input",
          required: true,
        },
        {
          key: "reason",
          label: "Reason",
          type: "text",
          required: true,
        },
      ],
      outputFields: [
        { path: "appointmentId", type: "string" },
        { path: "status", type: "string" },
        { path: "reason", type: "string" },
        { path: "cancelledAt", type: "timestamp" },
      ],
    },
  ],
};

export const connectedIntegrations = [
  { id: "slack-primary", type: "slack" },
  { id: "linear-primary", type: "linear" },
];

export function scenario(
  input: Omit<AgentEvalInput, "catalog">
): AgentEvalInput {
  return { ...input, catalog: evalCatalog };
}

export const configuredApplicantDocument: AgentDocument = {
  nodes: [
    {
      id: "entry",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: {
        label: "Lifecycle",
        type: "lifecycle",
        config: {
          lifecycleRules: {
            startEvents: ["applicant.created"],
            cancelEvents: [],
            concurrency: "newest-wins",
            allowManualStart: true,
            correlationPaths: { "applicant.created": "applicantId" },
            startFilters: {
              "applicant.created": serializeConditionModel({
                version: 2,
                groupLogic: "and",
                groups: [
                  {
                    id: "has-email",
                    logic: "and",
                    conditions: [
                      {
                        id: "email-is-set",
                        field: "email",
                        fieldType: "string",
                        operator: "is_set",
                      },
                    ],
                  },
                ],
              }),
            },
          },
        },
      },
    },
    {
      id: "score",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Score applicant",
        type: "action",
        config: {
          actionType: "score-applicant",
          applicantId: "{{@entry:Lifecycle.applicantId}}",
        },
      },
    },
    {
      id: "notify",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Notify recruiting",
        type: "action",
        config: {
          actionType: "slack/send-message",
          integrationId: "slack-primary",
          channel: "#recruiting",
          text: "Applicant score: {{@score:Score applicant.score}}",
        },
      },
    },
  ],
  edges: [
    {
      id: "entry-score",
      source: "entry",
      target: "score",
      sourceHandle: "started",
    },
    { id: "score-notify", source: "score", target: "notify" },
  ],
};
