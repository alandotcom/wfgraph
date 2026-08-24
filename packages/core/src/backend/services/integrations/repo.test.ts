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
import {
  type CapturedStatement,
  stubDatabase,
} from "#src/backend/lib/effect/test-layers";
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
  configRevision: number,
  isManaged: boolean,
  refreshState: string,
  refreshClaimId: string | null,
  refreshClaimedAt: string | null,
  createdAt: string,
  updatedAt: string,
];

function row(config: string): IntegrationRow {
  return [
    "int_1",
    "Slack Prod",
    "slack",
    config,
    0,
    false,
    "idle",
    null,
    null,
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

function repositoryHarness(
  answer: (statement: CapturedStatement) => unknown[][] = () => []
) {
  const database = stubDatabase(answer);
  const layer = makeIntegrationRepoLayer(cipher).pipe(
    Layer.provide(database.layer)
  );

  return {
    statements: database.statements,
    run: <A, E>(
      question: (repo: IntegrationRepo["Service"]) => Effect.Effect<A, E>
    ): Promise<A> =>
      Effect.runPromise(
        Effect.flatMap(IntegrationRepo, question).pipe(Effect.provide(layer))
      ),
  };
}

describe("integration insertion", () => {
  it("inserts under an explicitly reserved id", async () => {
    const config = { ACCESS_TOKEN: "secret" };
    const repoHarness = repositoryHarness((statement) =>
      statement.query.startsWith("insert") ? [row(cipher.seal(config))] : []
    );

    const inserted = await repoHarness.run((repo) =>
      repo.insertWithId({
        id: "int_1",
        name: "Slack Prod",
        type: "slack",
        config,
      })
    );

    expect(inserted.id).toBe("int_1");
    expect(inserted.config).toEqual(config);
    expect(repoHarness.statements[0]?.params).toContain("int_1");
  });
});

describe("OAuth authorization attempts", () => {
  const attemptPayload = {
    kind: "reconnect" as const,
    redirectUri:
      "https://workflows.example.com/api/integrations/oauth/callback",
    configRevision: 0,
    codeVerifier: "pkce-verifier",
  };
  const validAttemptRow = [
    "state_hash",
    "int_1",
    new Date("2099-01-01T00:00:00Z"),
    "browser_hash",
    cipher.seal({ payload: JSON.stringify(attemptPayload) }),
    new Date("2026-01-01T00:00:00Z"),
  ];

  it("creates an attempt and atomically returns it once", async () => {
    let deleteCount = 0;
    const repoHarness = repositoryHarness((statement) => {
      if (statement.query.startsWith("delete")) {
        if (statement.query.includes('"expires_at" <=')) return [];
        deleteCount += 1;
        return deleteCount === 1 ? [validAttemptRow] : [];
      }
      return [];
    });

    await repoHarness.run((repo) =>
      repo.createOAuthAuthorizationAttempt({
        stateHash: "state_hash",
        integrationId: "int_1",
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        browserBindingHash: "browser_hash",
        payload: attemptPayload,
      })
    );
    const first = await repoHarness.run((repo) =>
      repo.consumeOAuthAuthorizationAttempt("state_hash", "browser_hash")
    );
    const second = await repoHarness.run((repo) =>
      repo.consumeOAuthAuthorizationAttempt("state_hash", "browser_hash")
    );

    expect(first).toEqual({
      integrationId: "int_1",
      payload: attemptPayload,
    });
    expect(second).toBeNull();
    expect(
      repoHarness.statements.filter((statement) =>
        statement.query.startsWith("delete")
      )
    ).toHaveLength(3);
    expect(repoHarness.statements[0]?.query).toContain("expires_at");
    expect(repoHarness.statements[1]?.query).toContain("insert");
    expect(repoHarness.statements[0]?.params).not.toContain("pkce-verifier");
  });

  it.each([
    {
      name: "the browser binding differs",
      row: validAttemptRow,
      browserBindingHash: "other_browser",
    },
    {
      name: "the attempt has expired",
      row: validAttemptRow.with(2, new Date("2000-01-01T00:00:00Z")),
      browserBindingHash: "browser_hash",
    },
  ])("consumes and rejects an attempt when $name", async (scenario) => {
    const repoHarness = repositoryHarness((statement) =>
      statement.query.startsWith("delete") ? [scenario.row] : []
    );

    const consumed = await repoHarness.run((repo) =>
      repo.consumeOAuthAuthorizationAttempt(
        "state_hash",
        scenario.browserBindingHash
      )
    );

    expect(consumed).toBeNull();
  });

  it("stores create data only in the encrypted payload under a nullable integration id", async () => {
    const payload = {
      kind: "create" as const,
      integrationId: "int_reserved",
      name: "New connection",
      type: "slack",
      config: { TEAM: "secret-team" },
      redirectUri:
        "https://workflows.example.com/api/integrations/oauth/callback",
      codeVerifier: "pkce-verifier",
    };
    const attemptRow = [
      "state_hash",
      null,
      new Date("2099-01-01T00:00:00Z"),
      "browser_hash",
      cipher.seal({ payload: JSON.stringify(payload) }),
      new Date("2026-01-01T00:00:00Z"),
    ];
    const repoHarness = repositoryHarness((statement) =>
      statement.query.startsWith("delete") &&
      !statement.query.includes('"expires_at" <=')
        ? [attemptRow]
        : []
    );

    await repoHarness.run((repo) =>
      repo.createOAuthAuthorizationAttempt({
        stateHash: "state_hash",
        integrationId: null,
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        browserBindingHash: "browser_hash",
        payload,
      })
    );
    const consumed = await repoHarness.run((repo) =>
      repo.consumeOAuthAuthorizationAttempt("state_hash", "browser_hash")
    );

    expect(consumed).toEqual({ integrationId: null, payload });
    const insert = repoHarness.statements.find((statement) =>
      statement.query.startsWith("insert")
    );
    expect(insert?.params).toContain(null);
    expect(insert?.params).not.toContain("int_reserved");
    expect(insert?.params).not.toContain("secret-team");
  });
});

describe("integration refresh claims", () => {
  it.each([
    { updateRows: [["int_1"]], lookupRows: [], expected: "acquired" },
    { updateRows: [], lookupRows: [["int_1"]], expected: "lost" },
    { updateRows: [], lookupRows: [], expected: "not_found" },
  ])("reports $expected from an atomic claim", async (scenario) => {
    const repoHarness = repositoryHarness((statement) => {
      if (statement.query.startsWith("update")) return scenario.updateRows;
      if (statement.query.startsWith("select")) return scenario.lookupRows;
      return [];
    });

    const outcome = await repoHarness.run((repo) =>
      repo.claimRefresh({
        integrationId: "int_1",
        claimId: "claim_1",
        expectedRevision: 4,
      })
    );

    expect(outcome).toEqual({ status: scenario.expected });
    expect(repoHarness.statements[0]?.query).toContain("config_revision");
    expect(repoHarness.statements[0]?.params).toContain(4);
    expect(repoHarness.statements[0]?.params).toContain("refreshing");
  });

  it("completes only the owning claim while replacing the encrypted config", async () => {
    const repoHarness = repositoryHarness((statement) =>
      statement.query.startsWith("update") ? [["int_1"]] : []
    );

    const completed = await repoHarness.run((repo) =>
      repo.completeRefresh({
        integrationId: "int_1",
        claimId: "claim_1",
        expectedRevision: 4,
        config: { accessToken: "replacement" },
      })
    );

    expect(completed).toBe(true);
    const statement = repoHarness.statements.at(-1);
    expect(statement?.query).toContain("refresh_claim_id");
    expect(statement?.query).toContain("refresh_state");
    expect(statement?.query).toContain("config");
    expect(statement?.query).toContain("config_revision");
    expect(statement?.params).toContain(4);
    expect(statement?.params).not.toContain("replacement");
  });

  it("reports a conflict when a manual config compare-and-set loses", async () => {
    const repoHarness = repositoryHarness((statement) =>
      statement.query.startsWith("select") ? [["int_1"]] : []
    );

    const outcome = await repoHarness.run((repo) =>
      repo.update("int_1", {
        config: { accessToken: "manual" },
        expectedRevision: 2,
      })
    );

    expect(outcome).toEqual({ status: "conflict" });
    expect(repoHarness.statements[0]?.query).toContain("config_revision");
    expect(repoHarness.statements[0]?.query).toContain("refresh_state");
    expect(repoHarness.statements[0]?.params).toContain(2);
  });

  it("fences releaseRefreshClaim by the owning claim", async () => {
    const repoHarness = repositoryHarness((statement) =>
      statement.query.startsWith("update") ? [] : []
    );

    const changed = await repoHarness.run((repo) =>
      repo.releaseRefreshClaim({
        integrationId: "int_1",
        claimId: "stale_claim",
        expectedRevision: 0,
      })
    );

    expect(changed).toBe(false);
    const statement = repoHarness.statements.at(-1);
    expect(statement?.query).toContain("refresh_claim_id");
    expect(statement?.params).toContain("idle");
  });

  it("fences markReauthorizationRequired by the owning claim", async () => {
    const repoHarness = repositoryHarness((statement) =>
      statement.query.startsWith("update") ? [] : []
    );

    const changed = await repoHarness.run((repo) =>
      repo.markReauthorizationRequired({
        integrationId: "int_1",
        claimId: "stale_claim",
        expectedRevision: 0,
      })
    );

    expect(changed).toEqual({ status: "no_longer_owned" });
    const statement = repoHarness.statements.at(-1);
    expect(statement?.query).toContain("refresh_claim_id");
    expect(statement?.params).toContain("reauthorization_required");
  });

  it.each([
    { deleteRows: [["int_1"]], lookupRows: [], expected: "deleted" },
    {
      deleteRows: [],
      lookupRows: [["int_1"]],
      expected: "no_longer_owned",
    },
    { deleteRows: [], lookupRows: [], expected: "not_found" },
  ])("reports $expected when deleting an owned claim", async (scenario) => {
    const repoHarness = repositoryHarness((statement) => {
      if (statement.query.startsWith("delete")) return scenario.deleteRows;
      if (statement.query.startsWith("select")) return scenario.lookupRows;
      return [];
    });

    const outcome = await repoHarness.run((repo) =>
      repo.deleteOwnedRefreshClaim({
        integrationId: "int_1",
        claimId: "claim_1",
        expectedRevision: 4,
      })
    );

    expect(outcome).toEqual({ status: scenario.expected });
    const statement = repoHarness.statements[0];
    expect(statement?.query).toContain("refresh_claim_id");
    expect(statement?.query).toContain("config_revision");
    expect(statement?.params).toContain("claim_1");
    expect(statement?.params).toContain(4);
  });
});
