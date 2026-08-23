import { describe, expect, it } from "vitest";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { buildSystemPrompt } from "#src/prompt";
import { fixtureCatalog } from "#src/tools/catalog-fixture";

/** The prompt with its reading layout removed, so an assertion can span a wrap. */
function unwrapped(prompt: string): string {
  return prompt.replaceAll(/\s+/g, " ");
}

describe("buildSystemPrompt", () => {
  it("indexes every action by id, so the model picks a real one", () => {
    const prompt = buildSystemPrompt(fixtureCatalog);

    for (const action of fixtureCatalog.actions) {
      expect(prompt).toContain(action.id);
      expect(prompt).toContain(action.description);
    }
  });

  it("marks the actions that change something outside the workflow", () => {
    const prompt = buildSystemPrompt(fixtureCatalog);
    const slackLine = prompt
      .split("\n")
      .find((line) => line.startsWith("- slack/send-message"));

    expect(slackLine).toContain("Changes something outside the workflow");
  });

  it("names the Events a workflow can be started by", () => {
    const prompt = buildSystemPrompt(fixtureCatalog);

    expect(prompt).toContain("applicant.created");
    expect(prompt).toContain("applicant.withdrawn");
  });

  it("says so plainly when the host has registered nothing", () => {
    const prompt = buildSystemPrompt(emptyExtensionCatalog);

    expect(prompt).toContain("has registered no actions");
    expect(prompt).toContain("has registered no Events");
  });

  it("maps everyday phrasing onto the pieces it has to build with", () => {
    // The prompt is wrapped for reading, so a phrase can straddle a line break.
    // What matters is that it is in there, not how it was laid out.
    const prompt = unwrapped(buildSystemPrompt(emptyExtensionCatalog));

    // Nobody types the domain vocabulary, so the prompt has to carry the words
    // people actually use for each concept.
    for (const phrasing of [
      "when someone signs up",
      "the trigger is",
      "cancel when",
      "only when",
      "wait a day",
      "message them",
    ]) {
      expect(prompt, phrasing).toContain(phrasing);
    }
  });

  it("tells the agent to answer in the same plain language", () => {
    const prompt = unwrapped(buildSystemPrompt(emptyExtensionCatalog));

    expect(prompt).toContain("Answer in the same plain language");
    expect(prompt).toContain("label it carries on the canvas");
  });

  it("distinguishes a useful blocked draft from publish readiness", () => {
    const prompt = unwrapped(buildSystemPrompt(emptyExtensionCatalog));

    expect(prompt).toContain("draft is complete");
    expect(prompt).toContain("remaining human work");
    expect(prompt).toContain("ready to publish");
    expect(prompt).toContain("publishBlockers is empty");
    expect(prompt).toContain("leave that field empty");
    expect(prompt).toContain("remaining human work");
    expect(prompt).toContain("required identifier or destination");
    expect(prompt).toContain("Draft descriptive text");
    expect(prompt).toContain("requires a connection");
    expect(prompt).toContain("requires a channel");
  });

  it("carries the built-in action ids the tools accept", () => {
    const prompt = buildSystemPrompt(emptyExtensionCatalog);

    expect(prompt).toContain("Condition");
    expect(prompt).toContain("Wait");
    expect(prompt).toContain("Event Split");
  });

  it("requires inspection of built-ins and reuse of available references", () => {
    const prompt = unwrapped(buildSystemPrompt(emptyExtensionCatalog));

    expect(prompt).toContain("including built-in steps");
    expect(prompt).toContain("Use an existing upstream reference");
    expect(prompt).toContain("Add a lookup action only when");
  });

  it("requires a fresh graph read before recovering from a refusal", () => {
    const prompt = unwrapped(buildSystemPrompt(emptyExtensionCatalog));

    expect(prompt).toContain("After a tool refusal, call read_workflow");
    expect(prompt).toContain("Never repeat the refused call unchanged");
  });

  it("routes structured Wait configuration through set_wait", () => {
    const prompt = unwrapped(buildSystemPrompt(emptyExtensionCatalog));

    expect(prompt).toContain("set_wait");
    expect(prompt).toContain("list_events");
    expect(prompt).toContain("Event wait needs a timeout");
  });

  it("explains how an always-run action and a conditional action fan out", () => {
    const prompt = unwrapped(buildSystemPrompt(emptyExtensionCatalog));

    expect(prompt).toContain(
      "Every node with multiple incoming edges is an AND-join"
    );
    expect(prompt).toContain("fan both paths out independently");
  });
});
