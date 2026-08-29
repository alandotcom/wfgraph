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
    "reconnect",
    "processing",
    new Date("2099-01-01T00:00:00Z"),
    "browser_hash",
    cipher.seal({ payload: JSON.stringify(attemptPayload) }),
    null,
    new Date("2026-01-01T00:00:00Z"),
    new Date("2026-01-01T00:00:00Z"),
  ];

  it("locks expired attempts before fencing their integration claims", async () => {
    const repoHarness = repositoryHarness((statement) =>
      statement.query.startsWith("select")
        ? [["expired_state", "reconnect", "processing"]]
        : []
    );

    await repoHarness.run((repo) =>
      repo.createOAuthAuthorizationAttempt({
        stateHash: "new_state",
        integrationId: "int_1",
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        browserBindingHash: "browser_hash",
        payload: attemptPayload,
      })
    );

    expect(repoHarness.statements.map((statement) => statement.query)).toEqual([
      expect.stringContaining("for update"),
      expect.stringContaining('update "integrations"'),
      expect.stringContaining('delete from "oauth_authorization_attempts"'),
      expect.stringContaining('insert into "oauth_authorization_attempts"'),
    ]);
    expect(repoHarness.statements[1]?.params).toContain("expired_state");
    expect(repoHarness.statements[2]?.params).toContain("expired_state");
  });

  it("creates an attempt and atomically claims it once", async () => {
    let claimCount = 0;
    const repoHarness = repositoryHarness((statement) => {
      if (
        statement.query.startsWith("update") &&
        statement.params.includes("processing")
      ) {
        claimCount += 1;
        return claimCount === 1
          ? [[validAttemptRow[1], validAttemptRow[6]]]
          : [];
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
      repo.claimOAuthAuthorizationAttempt({
        stateHash: "state_hash",
        browserBindingHash: "browser_hash",
        expiresAt: new Date("2099-01-01T00:10:00Z"),
      })
    );
    const second = await repoHarness.run((repo) =>
      repo.claimOAuthAuthorizationAttempt({
        stateHash: "state_hash",
        browserBindingHash: "browser_hash",
        expiresAt: new Date("2099-01-01T00:10:00Z"),
      })
    );

    expect(first).toEqual({ integrationId: "int_1", payload: attemptPayload });
    expect(second).toBeNull();
    expect(repoHarness.statements[0]?.query).toContain("expires_at");
    expect(repoHarness.statements[0]?.query).toContain("for update");
    expect(repoHarness.statements[1]?.query).toContain("insert into");
    expect(repoHarness.statements[0]?.params).not.toContain("pkce-verifier");
  });

  it("burns a pending attempt when the browser binding differs", async () => {
    const repoHarness = repositoryHarness((statement) =>
      statement.query.startsWith("update") &&
      statement.params.includes("failed")
        ? [["state_hash"]]
        : []
    );

    const claimed = await repoHarness.run((repo) =>
      repo.claimOAuthAuthorizationAttempt({
        stateHash: "state_hash",
        browserBindingHash: "other_browser",
        expiresAt: new Date("2099-01-01T00:10:00Z"),
      })
    );

    expect(claimed).toBeNull();
    const burn = repoHarness.statements.find((statement) =>
      statement.params.includes("failed")
    );
    expect(burn?.query).toContain("browser_binding_hash");
  });

  it("stores create data only in the encrypted payload", async () => {
    const payload = {
      kind: "create" as const,
      integrationId: "int_reserved",
      configRevision: 0 as const,
      name: "New connection",
      type: "slack",
      config: { TEAM: "secret-team" },
      redirectUri:
        "https://workflows.example.com/api/integrations/oauth/callback",
      codeVerifier: "pkce-verifier",
    };
    const attemptRow = validAttemptRow
      .with(1, null)
      .with(2, "create")
      .with(6, cipher.seal({ payload: JSON.stringify(payload) }));
    const repoHarness = repositoryHarness((statement) =>
      statement.query.startsWith("update") &&
      statement.params.includes("processing")
        ? [[attemptRow[1], attemptRow[6]]]
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
    const claimed = await repoHarness.run((repo) =>
      repo.claimOAuthAuthorizationAttempt({
        stateHash: "state_hash",
        browserBindingHash: "browser_hash",
        expiresAt: new Date("2099-01-01T00:10:00Z"),
      })
    );

    expect(claimed).toEqual({ integrationId: null, payload });
    const insert = repoHarness.statements.find((statement) =>
      statement.query.startsWith("insert")
    );
    expect(insert?.params).not.toContain("int_reserved");
    expect(insert?.params).not.toContain("secret-team");
  });

  it("reads only browser-bound attempt status", async () => {
    const repoHarness = repositoryHarness((statement) =>
      statement.query.startsWith("select")
        ? [["succeeded", "int_reserved"]]
        : []
    );

    const status = await repoHarness.run((repo) =>
      repo.readOAuthAuthorizationAttemptStatus({
        stateHash: "state_hash",
        browserBindingHash: "browser_hash",
      })
    );

    expect(status).toEqual({
      status: "succeeded",
      integrationId: "int_reserved",
    });
    expect(repoHarness.statements[0]?.query).toContain("expires_at");
  });

  it("retains a failed terminal status until its renewed expiry", async () => {
    const repoHarness = repositoryHarness((statement) =>
      statement.query.startsWith("update") ? [["state_hash"]] : []
    );

    const failed = await repoHarness.run((repo) =>
      repo.failOAuthAuthorizationAttempt({
        stateHash: "state_hash",
        expiresAt: new Date("2099-01-01T00:10:00Z"),
      })
    );

    expect(failed).toBe(true);
    expect(repoHarness.statements[0]?.params).toContain("failed");
    expect(repoHarness.statements[0]?.params).toContain("processing");
    expect(repoHarness.statements[0]?.query).toContain("expires_at");
  });

  it("atomically inserts a created integration and records success", async () => {
    const repoHarness = repositoryHarness((statement) => {
      if (statement.query.startsWith("select")) return [["state_hash"]];
      if (statement.query.startsWith("update")) return [["state_hash"]];
      return [];
    });

    const completed = await repoHarness.run((repo) =>
      repo.completeOAuthCreateAttempt({
        stateHash: "state_hash",
        integrationId: "int_reserved",
        name: "New connection",
        type: "slack",
        config: { ACCESS_TOKEN: "secret" },
        expiresAt: new Date("2099-01-01T00:10:00Z"),
      })
    );

    expect(completed).toBe(true);
    expect(
      repoHarness.statements.some((statement) =>
        statement.query.startsWith("insert")
      )
    ).toBe(true);
    expect(JSON.stringify(repoHarness.statements)).not.toContain("secret");
  });

  it("atomically completes a revision-fenced reconnect", async () => {
    const repoHarness = repositoryHarness((statement) => {
      if (statement.query.startsWith("select")) return [["state_hash"]];
      if (statement.query.startsWith("update")) return [["int_1"]];
      return [];
    });

    const completed = await repoHarness.run((repo) =>
      repo.completeOAuthReconnectAttempt({
        stateHash: "state_hash",
        integrationId: "int_1",
        expectedRevision: 4,
        config: { ACCESS_TOKEN: "secret" },
        expiresAt: new Date("2099-01-01T00:10:00Z"),
      })
    );

    expect(completed).toBe(true);
    const integrationUpdate = repoHarness.statements.find(
      (statement) =>
        statement.query.startsWith("update") &&
        statement.query.includes('"config_revision"')
    );
    expect(integrationUpdate?.params).toContain("state_hash");
    expect(integrationUpdate?.params).toContain(4);
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
