/**
 * Which of the two unreadable rows a read carries on past.
 *
 * Both arrive from the one `config` column and only the cipher tells them
 * apart, so the repository is where the difference has to show. Every caller
 * stubs `IntegrationRepo` whole, which leaves no other seam this is visible
 * through, so each case answers the read with a row set of its own choosing.
 */

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { stubDatabase } from "#src/backend/lib/effect/test-layers";
import {
  createIntegrationCipher,
  EncryptionKeyMismatch,
} from "#src/backend/services/integrations/cipher";
import {
  type DecryptedIntegration,
  IntegrationRepo,
  makeIntegrationRepoLayer,
} from "#src/backend/services/integrations/repo";

const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);

const cipher = createIntegrationCipher({ key: KEY });

/** An envelope this cipher's key cannot authenticate, whatever it holds. */
const sealedElsewhere = createIntegrationCipher({ key: OTHER_KEY }).seal({
  SLACK_API_KEY: "secret",
});

/** One `integrations` row, in the order the table declares its columns. */
type IntegrationRow = [
  id: string,
  name: string,
  type: string,
  config: string,
  isManaged: boolean,
  createdAt: string,
  updatedAt: string,
];

function row(config: string): IntegrationRow {
  return [
    "int_1",
    "Slack Prod",
    "slack",
    config,
    false,
    "2026-01-01 00:00:00",
    "2026-01-01 00:00:00",
  ];
}

function harness(rows: IntegrationRow[]) {
  const { layer: databaseLayer } = stubDatabase(() => rows);

  const ask = <A, E>(
    question: (repo: IntegrationRepo["Service"]) => Effect.Effect<A, E>
  ): Effect.Effect<A, E> =>
    Effect.flatMap(IntegrationRepo, question).pipe(
      Effect.provide(
        makeIntegrationRepoLayer(cipher).pipe(Layer.provide(databaseLayer))
      )
    );

  /** The failure a read left with, as a value, so a case can name its type. */
  const failureOf = <A, E>(
    question: (repo: IntegrationRepo["Service"]) => Effect.Effect<A, E>
  ): Promise<E> => Effect.runPromise(ask(question).pipe(Effect.flip));

  return {
    find: (): Promise<DecryptedIntegration | null> =>
      Effect.runPromise(ask((repo) => repo.findById("int_1"))),
    listFailure: () => failureOf((repo) => repo.listByType("slack")),
    findFailure: () => failureOf((repo) => repo.findById("int_1")),
  };
}

describe("reading a row this key cannot open", () => {
  // Every row in the table is unreadable when the key is wrong, so answering an
  // empty config for each would draw a table of connections nobody filled in.
  it("fails the list when the row was sealed under another key", async () => {
    const failure = await harness([row(sealedElsewhere)]).listFailure();

    expect(failure).toBeInstanceOf(EncryptionKeyMismatch);
  });

  it("fails a single read under that key with the tagged failure", async () => {
    const failure = await harness([row(sealedElsewhere)]).findFailure();

    expect(failure).toBeInstanceOf(EncryptionKeyMismatch);
  });

  // One row nobody can parse is one connection the editor can still show and
  // repair, which is the case the empty config exists for.
  it("answers an empty config for a row holding no envelope", async () => {
    const integration = await harness([row("not-an-envelope")]).find();

    expect(integration?.config).toEqual({});
  });
});

describe("reading a row this key sealed", () => {
  it("gives back the config that was stored", async () => {
    const config = { SLACK_API_KEY: "secret", SLACK_TEAM_ID: "T1" };

    const integration = await harness([row(cipher.seal(config))]).find();

    expect(integration?.config).toEqual(config);
  });

  // The branch `decryptedOrNull` exists for: no row means no integration, which
  // is a caller's "not found" rather than anything the cipher was asked about.
  it("answers null when no row carries that id", async () => {
    const integration = await harness([]).find();

    expect(integration).toBeNull();
  });
});
