# Rova Workflow Builder

Rova lets a developer embed a workflow engine in their app and hand a visual
editor to the people who build workflows on top of it. Two personas share the
system, and most trigger vocabulary exists to keep their responsibilities apart.

## Language

### Personas

**Trigger Author**:
The developer embedding the library who defines a custom trigger in code:
what payloads look like and how to read them.
_Avoid_: developer (ambiguous), integrator

**Workflow Builder**:
The person in the visual editor who assembles a workflow and configures its
trigger. Owns the routing policy for their workflow.
_Avoid_: user (ambiguous), operator

### Triggers

**Event Type**:
The name classifying an incoming payload (e.g. `appointment.rescheduled`).
Read from the payload at the declared `eventTypePath`; when an event-mode
trigger declares none, the Inngest event names themselves are the Event
Types. The vocabulary is a closed set the editor can enumerate.

**Correlation Key**:
The string identifying the entity a run tracks (e.g. an appointment id), read
from the payload at the Trigger Author's declared `correlationIdPath`. Runs
sharing a Correlation Key are about the same entity.

**Routing Policy**:
The Workflow Builder's per-workflow mapping from Event Type to what happens
when that payload arrives. Owned by the Workflow Builder in the editor; the
Trigger Author supplies vocabulary (Event Types, Correlation Key), never
policy. One concept across every trigger type; the trigger types differ only
in where the Event Type vocabulary comes from.
_Avoid_: lifecycle (the retired authored-in-code model), create/update/delete
(the retired webhook-only routing names)

**Start**:
The Routing Policy action that begins a new Execution carrying the payload.

**Replace**:
The Routing Policy action that cancels the entity's in-flight Executions and
Starts a new one carrying the new payload.
_Avoid_: restart (implies the same run beginning again)

**Cancel**:
The Routing Policy action that cancels the entity's in-flight Executions.
_Avoid_: stop (reads as pausable)

**Ignore**:
The Routing Policy action that drops the payload. The default for any Event
Type the Workflow Builder has not mapped.

### Runs

**Execution**:
One run of one workflow, started by a trigger payload or a manual test.
_Avoid_: workflow (a workflow is the definition; an Execution is one run of it)
