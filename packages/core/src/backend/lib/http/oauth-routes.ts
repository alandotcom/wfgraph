import { Effect, Result, Schema } from "effect";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { WfGraphAppContext } from "#src/backend/lib/effect/app-context";
import { responseFromServiceFailure } from "#src/backend/lib/http/failure-response";
import type { WfGraphRuntime, WfGraphServices } from "#src/backend/runtime";
import {
  completeIntegrationOAuth,
  getOAuthClientMetadata,
  oauthBindingCookieName,
  readIntegrationOAuthAttemptStatus,
  startIntegrationOAuth,
} from "#src/backend/services/integrations/oauth";
import {
  NonEmptyTrimmedString,
  rejectUnknownKeys,
} from "@wfgraph/shared/types/schema";
import { formatSchemaFailure } from "@wfgraph/shared/types/schema-message";
import { hasOnlySafeRecordKeys } from "@wfgraph/shared/types/record-key";
import { OAUTH_GRANT_CONFIG_KEY } from "#src/backend/services/integrations/oauth-grant";

export const OAUTH_CLIENT_METADATA_ROUTE =
  "/integrations/oauth/clients/:integrationType";
export const OAUTH_CALLBACK_ROUTE = "/integrations/oauth/callback";
export const OAUTH_RESPONSE_ROUTES = ["/integrations/oauth/*"] as const;

export const OAUTH_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

const startOAuthInputSchema = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("create"),
    name: Schema.String,
    type: NonEmptyTrimmedString,
    config: Schema.Record(Schema.String, Schema.String).check(
      Schema.makeFilter(hasOnlySafeRecordKeys, {
        expected: "config keys that are not reserved by JavaScript objects",
      }),
      Schema.makeFilter((config) => !(OAUTH_GRANT_CONFIG_KEY in config), {
        expected: "an integration config without the reserved OAuth grant key",
      })
    ),
  }),
  Schema.Struct({
    mode: Schema.Literal("reconnect"),
    integrationId: NonEmptyTrimmedString,
  }),
]);
const decodeStartOAuthInput = Schema.decodeUnknownResult(
  startOAuthInputSchema,
  { ...rejectUnknownKeys, errors: "all" }
);

/**
 * The page the provider's popup lands on.
 *
 * Both are constants rather than one function over a message: this is the only
 * HTML core writes, it is served on the route a provider redirects to, and a
 * hole in it is the kind of thing a later edit fills from a query parameter.
 * There is nothing here a caller needs to vary.
 */
const oauthPage = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"></head><body>${body}</body></html>`;

/** Success closes itself. The editor already knows, and says so in its own tab. */
const OAUTH_COMPLETE_PAGE = oauthPage(
  "<p>OAuth connection complete.</p><script>window.close()</script>"
);

/**
 * Failure stays open, because this sentence is the only account of it a person
 * gets. The window is script-opened, so closing it is theirs to press; a page
 * that closed on load displayed its own explanation for about zero frames.
 */
const OAUTH_FAILED_PAGE = oauthPage(
  '<p>OAuth connection could not be completed. Close this window and try connecting again.</p><button id="close" type="button">Close</button><script>document.getElementById("close").addEventListener("click",function(){window.close()})</script>'
);

function applyOAuthHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(OAUTH_RESPONSE_HEADERS)) {
    headers.set(name, value);
  }
}

/**
 * Run one service call and hand back its outcome as a value.
 *
 * Every handler below needs both arms: a service failure becomes a response
 * through `responseFromServiceFailure`, and a success is shaped per route. The
 * `Effect.match` that flattens the two was written out at each of them, which is
 * four chances to answer the wrong arm.
 */
async function runService<A, E>(
  runtime: WfGraphRuntime,
  effect: Effect.Effect<A, E, WfGraphServices>
): Promise<{ ok: true; value: A } | { ok: false; failure: E }> {
  return await runtime.runPromise(
    effect.pipe(
      Effect.match({
        onSuccess: (value) => ({ ok: true as const, value }),
        onFailure: (failure) => ({ ok: false as const, failure }),
      })
    )
  );
}

/** Browser-facing OAuth adapters. The parent API app owns auth and logging. */
export function createOAuthRoutes(options: {
  basePath: `/${string}`;
  runtime: WfGraphRuntime;
}) {
  const { basePath, runtime } = options;

  return new Hono()
    .post("/integrations/oauth/start", async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.raw.json();
      } catch {
        return c.json({ error: "Request body must be valid JSON" }, 400);
      }
      const body = decodeStartOAuthInput(raw);
      if (Result.isFailure(body)) {
        return c.json({ error: formatSchemaFailure(body.failure.issue) }, 400);
      }

      const result = await runService(
        runtime,
        startIntegrationOAuth(body.success)
      );
      if (!result.ok) {
        const response = responseFromServiceFailure(result.failure);
        applyOAuthHeaders(response.headers);
        return response;
      }

      const context = await runtime.runPromise(WfGraphAppContext);
      if (!context.oauth) {
        return c.json({ error: "OAuth requires a public URL" }, 400);
      }
      setCookie(c, result.value.cookieName, result.value.browserBinding, {
        httpOnly: true,
        sameSite: "Lax",
        maxAge: result.value.maxAge,
        path: context.oauth.cookiePath,
        secure: context.oauth.secureCookies,
      });
      applyOAuthHeaders(c.res.headers);
      return c.json({
        attemptId: result.value.attemptId,
        authorizeUrl: result.value.authorizeUrl,
      });
    })
    .get("/integrations/oauth/attempts/:attemptId", async (c) => {
      const attemptId = c.req.param("attemptId");
      const cookieName = oauthBindingCookieName(attemptId);
      const browserBinding = cookieName ? getCookie(c, cookieName) : undefined;
      if (!cookieName || !browserBinding) {
        applyOAuthHeaders(c.res.headers);
        return c.json({ error: "OAuth attempt not found" }, 404);
      }
      const result = await runService(
        runtime,
        readIntegrationOAuthAttemptStatus({ attemptId, browserBinding })
      );
      if (!result.ok) {
        const response = responseFromServiceFailure(result.failure);
        applyOAuthHeaders(response.headers);
        return response;
      }

      if (result.value.status !== "pending") {
        const context = await runtime.runPromise(WfGraphAppContext);
        deleteCookie(c, cookieName, {
          path: context.oauth?.cookiePath ?? `${basePath}/integrations/oauth`,
          secure: context.oauth?.secureCookies ?? false,
        });
      }
      applyOAuthHeaders(c.res.headers);
      return c.json(result.value);
    })
    .get(OAUTH_CALLBACK_ROUTE, async (c) => {
      // State identifies only which binding-cookie name to read. Its value and
      // every provider query member stay in the service call and never in a log.
      const state = c.req.query("state");
      const cookieName = state
        ? (oauthBindingCookieName(state) ?? undefined)
        : undefined;
      const browserBinding = cookieName ? getCookie(c, cookieName) : undefined;
      const result = await runService(
        runtime,
        completeIntegrationOAuth({
          state,
          browserBinding,
          code: c.req.query("code"),
          providerError: c.req.query("error"),
        })
      );
      applyOAuthHeaders(c.res.headers);
      if (result.ok) {
        return c.html(OAUTH_COMPLETE_PAGE);
      }
      const response = new Response(OAUTH_FAILED_PAGE, {
        status: responseFromServiceFailure(result.failure).status,
      });
      applyOAuthHeaders(response.headers);
      return response;
    })
    .get(OAUTH_CLIENT_METADATA_ROUTE, async (c) => {
      const result = await runService(
        runtime,
        getOAuthClientMetadata(c.req.param("integrationType"))
      );
      applyOAuthHeaders(c.res.headers);
      if (result.ok) {
        return c.json(result.value);
      }
      const response = responseFromServiceFailure(result.failure);
      applyOAuthHeaders(response.headers);
      return response;
    });
}
