/**
 * Demonstration-only authentication for the example host.
 *
 * Sessions live in process memory and every account uses a public password. The
 * module exists to exercise Workflow Graph's host-owned authorization contract,
 * not to provide an identity system an adopter should deploy.
 */

import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, setCookie } from "hono/cookie";
import {
  defineWfGraphAuth,
  type WfGraphAccess,
  WfGraphRoles,
} from "@wfgraph/core";
import { DemoLoginPage } from "./demo-login-page";

const SESSION_COOKIE = "wfgraph_session";
const MAX_LOGIN_BODY_BYTES = 4 * 1024;

type DemoRole = keyof typeof WfGraphRoles;
type DemoUser = { password: string; role: DemoRole };
type DemoSession = { username: string; access: WfGraphAccess };

const demoUsers: Record<string, DemoUser> = {
  admin: { password: "password", role: "admin" },
  editor: { password: "password", role: "editor" },
  readonly: { password: "password", role: "viewer" },
};

function noStore(c: Context): void {
  c.header("Cache-Control", "no-store");
}

function isSameOrigin(request: Request, options: DemoAuthOptions): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;

  try {
    if (origin === new URL(request.url).origin) return true;
    if (options.publicUrl && origin === new URL(options.publicUrl).origin) {
      return true;
    }
    if (!options.isProduction) {
      const parsed = new URL(origin);
      return (
        parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
      );
    }
  } catch {
    return false;
  }
  return false;
}

function scalarFormValue(value: string | File | (string | File)[] | undefined) {
  return typeof value === "string" ? value : undefined;
}

type DemoAuthOptions = {
  isProduction: boolean;
  publicUrl?: string | undefined;
};

function sessionToken(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header || header.length > 8192) return undefined;

  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`))
    .map((part) => part.slice(SESSION_COOKIE.length + 1));
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(values[0] ?? "")) {
    return undefined;
  }
  return values[0];
}

export function createDemoAuth(options: DemoAuthOptions) {
  const sessions = new Map<string, DemoSession>();
  const app = new Hono();

  const sessionForRequest = (request: Request): DemoSession | null => {
    const token = sessionToken(request);
    return token ? (sessions.get(token) ?? null) : null;
  };

  app.get("/login", (c) => {
    noStore(c);
    return c.html(
      DemoLoginPage({
        username: sessionForRequest(c.req.raw)?.username,
      })
    );
  });

  app.get("/login/session", (c) => {
    noStore(c);
    return sessionForRequest(c.req.raw) ? c.body(null, 204) : c.body(null, 401);
  });

  app.post(
    "/login",
    bodyLimit({
      maxSize: MAX_LOGIN_BODY_BYTES,
      onError: (c) => {
        noStore(c);
        return c.html(DemoLoginPage({}), 413);
      },
    }),
    async (c) => {
      noStore(c);
      if (!isSameOrigin(c.req.raw, options)) return c.text("Forbidden", 403);
      if (
        !c.req
          .header("content-type")
          ?.startsWith("application/x-www-form-urlencoded")
      ) {
        return c.html(DemoLoginPage({}), 400);
      }

      const form = await c.req.parseBody({ all: true });
      const username = scalarFormValue(form.username);
      const password = scalarFormValue(form.password);
      const user = username ? demoUsers[username] : undefined;
      if (
        Object.keys(form).length !== 2 ||
        !username ||
        !user ||
        user.password !== password
      ) {
        return c.html(DemoLoginPage({ invalidCredentials: true }), 401);
      }

      const previousToken = sessionToken(c.req.raw);
      if (previousToken) sessions.delete(previousToken);

      let token: string;
      do {
        token = randomBytes(32).toString("base64url");
      } while (sessions.has(token));

      sessions.set(
        token,
        Object.freeze({ username, access: WfGraphRoles[user.role] })
      );
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        path: "/",
        sameSite: "Lax",
        secure: options.isProduction,
      });
      return c.redirect("/", 303);
    }
  );

  app.post("/logout", (c) => {
    noStore(c);
    if (!isSameOrigin(c.req.raw, options)) return c.text("Forbidden", 403);
    const token = sessionToken(c.req.raw);
    if (token) sessions.delete(token);
    deleteCookie(c, SESSION_COOKIE, {
      path: "/",
      secure: options.isProduction,
    });
    return c.redirect("/login", 303);
  });

  const auth = defineWfGraphAuth((request) => {
    if (!options.isProduction && new URL(request.url).pathname === "/api/mcp") {
      return WfGraphRoles.editor;
    }
    return sessionForRequest(request)?.access ?? null;
  });

  const createFetch =
    (wfgraphFetch: (request: Request) => Promise<Response>) =>
    async (request: Request): Promise<Response> => {
      const pathname = new URL(request.url).pathname;
      if (
        pathname === "/login" ||
        pathname === "/login/session" ||
        pathname === "/logout"
      ) {
        return await app.fetch(request);
      }

      const response = await wfgraphFetch(request);
      const isDocumentNavigation =
        request.method === "GET" &&
        (request.headers.get("accept") ?? "").includes("text/html") &&
        !(pathname === "/api" || pathname.startsWith("/api/"));
      return isDocumentNavigation && response.status === 401
        ? Response.redirect(new URL("/login", request.url), 302)
        : response;
    };

  return {
    auth,
    createFetch,
  };
}
