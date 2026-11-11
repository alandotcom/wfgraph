/**
 * Task check for the wfgraph-core/build-agent skill: a host turns on the
 * editor's chat agent against a provider it chose. The developer task is "give
 * our editors the workflow agent, on our Anthropic account", with the variants
 * a self-hosted model server and a host's own runner.
 *
 * `expectAgentOn` is the grader. A host can observe whether the agent is on
 * from `GET /api/extensions`, which the editor reads at boot to decide whether
 * to draw the chat panel, and from whether `createWfGraphApp` starts at all.
 * No case calls a model, so none needs a key that works.
 */

import { describe, expect, it } from "vitest";
import { Schema, Stream } from "effect";
import {
  WfGraphRoles,
  type WfGraphAgentConfig,
  type WfGraphAgentRunner,
} from "@wfgraph/core";
import { openHost } from "#src/skills/host";

const editorAuth = () => WfGraphRoles.editor;

const bootAgent = Schema.Struct({
  agent: Schema.Struct({ enabled: Schema.Boolean }),
});

/** Whether the editor a host serves with `agent` would draw the chat panel. */
async function agentEnabled(agent: WfGraphAgentConfig): Promise<boolean> {
  await using app = await openHost({ auth: editorAuth, agent });
  const response = await app.fetch(
    new Request("http://localhost/api/extensions")
  );
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(bootAgent)(await response.json()).agent
    .enabled;
}

/** The grader: the app starts with `agent`, and the editor shows the panel. */
async function expectAgentOn(agent: WfGraphAgentConfig): Promise<void> {
  expect(await agentEnabled(agent)).toBe(true);
}

/** A runner that answers every turn with nothing, standing in for a gateway. */
const silentRunner: WfGraphAgentRunner = {
  provider: "gateway",
  model: "house-model",
  run: () => Stream.empty,
};

describe("wfgraph-core/build-agent task check", () => {
  it("turns the agent on for Anthropic with a model named", async () => {
    await expectAgentOn({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      model: "claude-opus-5-5",
    });
  });

  it("turns the agent on for a self-hosted server by its base URL, with no key", async () => {
    await expectAgentOn({
      provider: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "llama-4",
    });
  });

  it("turns the agent on for a host's own runner", async () => {
    await expectAgentOn({ runner: silentRunner, maxConcurrentTurns: 2 });
  });

  it("rejects Anthropic with no model, which fails at startup", async () => {
    await expect(
      expectAgentOn({ provider: "anthropic", apiKey: "sk-ant-test", model: "" })
    ).rejects.toThrow('agent.model is required for the "anthropic" provider');
  });

  it("rejects a key read from an unset variable, which leaves the agent off", async () => {
    await expect(
      expectAgentOn({
        provider: "anthropic",
        apiKey: "",
        model: "claude-opus-5-5",
      })
    ).rejects.toThrow("expected false to be true");
  });

  it("rejects a turn limit that is not a positive integer, which fails at startup", async () => {
    await expect(
      expectAgentOn({ apiKey: "sk-test", maxConcurrentTurns: 0 })
    ).rejects.toThrow("agent.maxConcurrentTurns must be a positive integer");
  });
});
