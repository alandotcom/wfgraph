import { Effect, Result, Schema } from "effect";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { WfGraphAppContext } from "#src/backend/lib/effect/app-context";
import { responseFromServiceFailure } from "#src/backend/lib/http/failure-response";
import type { WfGraphRuntime } from "#src/backend/runtime";
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

const oauthPage = (message: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"></head><body><p>${message}</p><script>window.close()</script></body></html>`;

function applyOAuthHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(OAUTH_RESPONSE_HEADERS)) {
    headers.set(name, value);
  }
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

      const result = await runtime.runPromise(
        startIntegrationOAuth(body.success).pipe(
          Effect.match({
            onSuccess: (value) => ({ ok: true as const, value }),
            onFailure: (failure) => ({ ok: false as const, failure }),
          })
        )
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
      const result = await runtime.runPromise(
        readIntegrationOAuthAttemptStatus({ attemptId, browserBinding }).pipe(
          Effect.match({
            onSuccess: (value) => ({ ok: true as const, value }),
            onFailure: (failure) => ({ ok: false as const, failure }),
          })
        )
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
      const result = await runtime.runPromise(
        completeIntegrationOAuth({
          state,
          browserBinding,
          code: c.req.query("code"),
          providerError: c.req.query("error"),
        }).pipe(
          Effect.match({
            onSuccess: () => ({ ok: true as const }),
            onFailure: (failure) => ({ ok: false as const, failure }),
          })
        )
      );
      applyOAuthHeaders(c.res.headers);
      if (result.ok) {
        return c.html(oauthPage("OAuth connection complete."));
      }
      const response = new Response(
        oauthPage("OAuth connection could not be completed."),
        { status: responseFromServiceFailure(result.failure).status }
      );
      applyOAuthHeaders(response.headers);
      return response;
    })
    .get(OAUTH_CLIENT_METADATA_ROUTE, async (c) => {
      const result = await runtime.runPromise(
        getOAuthClientMetadata(c.req.param("integrationType")).pipe(
          Effect.match({
            onSuccess: (value) => ({ ok: true as const, value }),
            onFailure: (failure) => ({ ok: false as const, failure }),
          })
        )
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
