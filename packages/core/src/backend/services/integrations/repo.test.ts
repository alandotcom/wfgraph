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
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";
import {
  type DecryptedIntegration,
  IntegrationRepo,
  makeIntegrationRepoLayer,
} from "#src/backend/services/integrations/repo";

const KEY = "a".repeat(64);
const cipher = createIntegrationCipher({ key: KEY });

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
  // One row nobody can parse is one connection the editor can still show and
  // repair, which is the case the empty config exists for.
  it("answers an empty config for a row holding no envelope", async () => {
    const integration = await harness([row("not-an-envelope")]).find();

    expect(integration?.config).toEqual({});
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
});

describe("integration refresh claims", () => {
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
});
