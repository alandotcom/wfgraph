# Loops contact properties, triggers, and workflow filters

Research date: 2026-09-10. Sources are limited to Loops-owned documentation and API reference pages. Loops says its former automation feature **“Loops” has been renamed to “Workflows”**, so this note uses _workflow_ for the current product term ([Triggering workflows](https://loops.so/docs/workflows/triggers)).

## Findings

### 1. Loops stores contacts and custom contact properties: verified

Loops calls the stored contact collection an **audience**. Its documentation defines contact properties as “fields you store on each contact in Loops” and says they can personalize emails, segment the audience, and trigger workflows ([Contact properties](https://loops.so/docs/contacts/properties)). Loops supplies default properties and supports user-created **custom contact properties** of exactly four types: **String, Number, Boolean, and Date** ([Contact properties](https://loops.so/docs/contacts/properties#types-of-property)).

Relevant limitations:

- A custom property must be created in Loops before it is sent in an API request ([Update a contact](https://loops.so/docs/api-reference/update-contact)).
- A property's name or type cannot be edited after creation; changing either requires a new property ([Contact properties](https://loops.so/docs/contacts/properties#editing-contact-properties)).
- Deleting a custom property permanently deletes its associated data. Default properties cannot be deleted ([Contact properties](https://loops.so/docs/contacts/properties#deleting-contact-properties)).
- Date values sent through the API may be millisecond Unix timestamps or one of the documented ECMA-262 date-time strings; CSV imports accept the listed strings but not timestamps ([Contact properties](https://loops.so/docs/contacts/properties#dates)).
- `PUT /v1/contacts/update` identifies a contact by `email` or `userId` and creates one when no match exists ([Update a contact](https://loops.so/docs/api-reference/update-contact)).

### 2. Property-change workflow triggers: verified, with narrower terminology

The current trigger is named **Contact updated**, not “property changed.” It starts a workflow when “a contact property changes from one value to another,” and can additionally require a particular previous value ([Workflows](https://loops.so/docs/workflows#triggers)). The trigger model contains one property `key`, an `is` comparison for the new value, and a `was` comparison for the previous value ([Get a workflow node](https://loops.so/docs/api-reference/get-workflow-node)). Trigger frequency is separately **One time** or **Every time**; it controls whether a contact can enter only once or whenever the trigger matches ([Triggering workflows](https://loops.so/docs/workflows/triggers#trigger-frequency)).

The API reference defines these operators by selected property type ([Get a workflow node](https://loops.so/docs/api-reference/get-workflow-node)):

| Property type | Operators                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------- |
| String        | `any`, `equal`, `not_equal`, `contains`, `not_contains`, `empty`, `not_empty`                  |
| Number        | `any`, `greater_than`, `less_than`, `numeric_equal`, `numeric_not_equal`, `empty`, `not_empty` |
| Boolean       | `any`, `true`, `false`, `empty`, `not_empty`                                                   |
| Date          | `any`, `empty`, `not_empty`, `after`, `before`, `between`                                      |

The `was` side may use every operator supported by the property's type. The `is` side uses the same set except that **Number and Boolean cannot use `empty`** ([Get a workflow node](https://loops.so/docs/api-reference/get-workflow-node)). The selected key must already exist and be eligible for Contact Updated triggers; `createdAt`, `notes`, and computed contact properties are named as hidden or unsupported examples ([Get a workflow node](https://loops.so/docs/api-reference/get-workflow-node)).

The product guide supports API-driven use: Loops' own churn-risk recipe says an app should write a Boolean property through **Update contact**, then configure **Contact updated** for that property changing to `true` ([Churn risk recipe](https://loops.so/docs/guides/churn-risk-segment#trigger-on-contact-updated)). Manual edits have a separate **Save and trigger** action, while ordinary **Save changes** does not claim to trigger workflows ([Contact properties](https://loops.so/docs/contacts/properties#editing-contacts)). CSV updates trigger workflows only when **Trigger workflows** is selected during upload ([Workflows](https://loops.so/docs/workflows#triggers)).

### 3. Recalculation at each node: verified only for a scoped workflow audience filter

The broad claim needs qualification. An **Audience filter** node has two scopes ([Workflows](https://loops.so/docs/workflows#audience-filters)):

- **All following nodes**: Loops applies the filter “when contacts reach every following node.” If a contact no longer matches upon reaching a later node, Loops removes the contact from the workflow.
- **Next node only**: Loops evaluates the filter before the next node once. Later property changes are not taken into account by that filter.

Thus Loops does not document that every condition in every workflow is continuously recalculated. It documents re-evaluation **on arrival at each downstream node covered by an All following nodes filter**. Its churn-risk recipe is explicit: contacts “will be checked against the filter before they reach each node, and will exit the workflow as soon as `churnRisk` is `false`” ([Churn risk recipe](https://loops.so/docs/guides/churn-risk-segment#build-the-email-sequence)). A general audience-filter page states the related send-time rule: filters update as properties change, and an email sends only to contacts matching “at the time the email is sent” ([Filters and Segments](https://loops.so/docs/contacts/filters-segments#audience-filters)).

A branch uses audience-filter nodes differently at its decision point: Loops evaluates branches left-to-right, follows the first matching filter, and exits the workflow if none match. A branch filter can still use **All following nodes** or **Next node only** for later enforcement ([Branching workflows](https://loops.so/docs/workflows/branching#audience-filters)).

### 4. Trigger and filter concepts are distinct

- **Event received trigger**: starts a workflow when Loops receives a named event from the API, an integration, or a form ([Triggering workflows](https://loops.so/docs/workflows/triggers#event-received)). Event properties belong to that event payload and can personalize emails; contact properties included at the request's top level are saved on the contact ([Events](https://loops.so/docs/events#sending-events-with-the-api)).
- **Contact updated trigger**: starts a workflow from a transition in one stored contact property, optionally constrained by its old and new values ([Triggering workflows](https://loops.so/docs/workflows/triggers#contact-updated)).
- **Audience filter**: selects or gates contacts using current contact properties or campaign/workflow activity; it does not start a workflow ([Filters and Segments](https://loops.so/docs/contacts/filters-segments#audience-filters)). In a workflow it is a node after the trigger and has the two scopes described above ([Workflows](https://loops.so/docs/workflows#audience-filters)).
- **Audience segment**: “just filters that are saved” for reuse. Segments update automatically when contact data changes ([Filters and Segments](https://loops.so/docs/contacts/filters-segments#audience-segments)). A workflow filter node may reference a segment, an inline filter, or both; when both are present, the inline filter is applied on top of the segment filter ([Update a workflow node](https://loops.so/docs/api-reference/update-workflow-node)).

## Actors and state ownership

| Actor or system                      | Role and state                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product application or integration   | Observes the business fact, such as a plan change, and sends a contact update or event. Loops' recipe explicitly assigns computation and writing of `churnRisk` to the app ([Churn risk recipe](https://loops.so/docs/guides/churn-risk-segment#what-you-need)).                                                      |
| Loops audience/contact store         | Stores the contact identity and current default/custom property values used by triggers, personalization, filters, and segments ([Contact properties](https://loops.so/docs/contacts/properties)). This is Loops' evaluation state, even when the application remains authoritative for the underlying business fact. |
| Loops workflow configuration/runtime | Owns the trigger, node graph, trigger frequency, audience-filter scope, progression, removal, and email-send decision ([Workflows](https://loops.so/docs/workflows), [Get a workflow node](https://loops.so/docs/api-reference/get-workflow-node)).                                                                   |
| Recipient                            | Receives a workflow email only if eligible at the send node. In particular, the default `Subscribed` property determines eligibility for workflow and campaign email ([Contact properties](https://loops.so/docs/contacts/properties#subscribed)).                                                                    |

## Concrete end-to-end flow

1. The application changes a customer's authoritative plan from `free` to `paid` and calls `PUT /v1/contacts/update` with the contact identifier and a pre-created String property such as `plan: "paid"`. Loops finds or creates the audience contact and stores the supplied property ([Update a contact](https://loops.so/docs/api-reference/update-contact)).
2. A running workflow has **Contact updated** configured for `plan` with `was: equal("free")` and `is: equal("paid")`. The stored transition matches, so the contact enters; **One time** versus **Every time** determines future re-entry ([Triggering workflows](https://loops.so/docs/workflows/triggers#contact-updated), [Get a workflow node](https://loops.so/docs/api-reference/get-workflow-node)).
3. The workflow waits at a Timer, then reaches an Audience filter `plan equals paid` scoped to **All following nodes**. Loops evaluates the then-current stored property before each downstream node ([Workflows](https://loops.so/docs/workflows#audience-filters)).
4. If the application has since updated `plan` to `canceled`, the contact fails at the next covered node and is removed from the workflow. If the contact still matches and is subscribed, the contact can reach the Email node and Loops sends the workflow email ([Workflows](https://loops.so/docs/workflows#audience-filters), [Contact properties](https://loops.so/docs/contacts/properties#subscribed)).

## Ambiguities and unsupported phrasings

- “Loops are recalculated at each step” is unsupported. The documented behavior belongs to **Audience filters** with **All following nodes**, evaluated when a contact reaches covered downstream nodes. **Next node only** explicitly does not keep evaluating later changes ([Workflows](https://loops.so/docs/workflows#audience-filters)).
- The prose trigger guide explains old-to-new matching but does not enumerate operators. The exact operator matrix and the `is`-side exceptions appear in the workflow-node OpenAPI schema ([Triggering workflows](https://loops.so/docs/workflows/triggers#contact-updated), [Get a workflow node](https://loops.so/docs/api-reference/get-workflow-node)).
- The API schema says eligible keys must exist and excludes examples such as `createdAt`, `notes`, and computed properties, but it does not publish a complete list of every default property eligible for Contact Updated triggers ([Get a workflow node](https://loops.so/docs/api-reference/get-workflow-node)).
- Loops documents filter evaluation at node arrival and email-send time, not continuous background evaluation. “Exit as soon as” in the recipe should therefore be read in conjunction with “before they reach each node,” rather than as immediate asynchronous removal at the instant a property changes ([Churn risk recipe](https://loops.so/docs/guides/churn-risk-segment#build-the-email-sequence)).
- The Update contact reference describes persistence and upsert behavior but does not itself say that every API update triggers workflows. The product's own recipe couples that endpoint to a Contact updated trigger, which supports the intended flow; the docs do not specify behavior for a write that repeats the existing value rather than changing it ([Update a contact](https://loops.so/docs/api-reference/update-contact), [Churn risk recipe](https://loops.so/docs/guides/churn-risk-segment#trigger-on-contact-updated)).
