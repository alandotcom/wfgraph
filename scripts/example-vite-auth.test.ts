import { afterEach, describe, expect, it, vi } from "vitest";
import { exampleAuthGuard } from "./example-vite-auth";

type Request = {
  method: string;
  url: string;
  headers: { accept?: string; cookie?: string };
};

type Response = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: () => void;
};

type Middleware = (
  request: Request,
  response: Response,
  next: () => void
) => void | Promise<void>;

function middlewareFor(appOrigin: string): Middleware {
  let middleware: Middleware | undefined;
  const configureServer = exampleAuthGuard(appOrigin).configureServer;
  if (!configureServer) {
    throw new Error("The example auth plugin has no server hook");
  }
  const configure =
    typeof configureServer === "function"
      ? configureServer
      : configureServer.handler;
  configure.call(
    {} as never,
    {
      middlewares: {
        use(candidate: Middleware) {
          middleware = candidate;
        },
      },
    } as never
  );
  if (!middleware)
    throw new Error("The example auth middleware was not installed");
  return middleware;
}

function responseFor() {
  return {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(),
  } satisfies Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("example Vite auth guard", () => {
  it("redirects an unauthenticated root navigation to the login page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401 }));
    const middleware = middlewareFor("http://localhost:4017");
    const response = responseFor();
    const next = vi.fn();

    await middleware(
      {
        method: "GET",
        url: "/",
        headers: { accept: "text/html", cookie: "wfgraph_session=token" },
      },
      response,
      next
    );

    expect(fetch).toHaveBeenCalledWith("http://localhost:4017/login/session", {
      headers: { cookie: "wfgraph_session=token" },
    });
    expect(response.statusCode).toBe(302);
    expect(response.setHeader).toHaveBeenCalledWith("Location", "/login");
    expect(response.end).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it("passes login navigation and authenticated navigation to Vite", async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 204 });
    vi.stubGlobal("fetch", fetch);
    const middleware = middlewareFor("http://localhost:4017");
    const loginResponse = responseFor();
    const loginNext = vi.fn();

    await middleware(
      { method: "GET", url: "/login", headers: { accept: "text/html" } },
      loginResponse,
      loginNext
    );

    const workflowResponse = responseFor();
    const workflowNext = vi.fn();
    await middleware(
      {
        method: "GET",
        url: "/workflows/workflow-1",
        headers: { accept: "text/html" },
      },
      workflowResponse,
      workflowNext
    );

    expect(loginNext).toHaveBeenCalledOnce();
    expect(workflowNext).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("passes through when the example app is starting", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const middleware = middlewareFor("http://localhost:4017");
    const next = vi.fn();

    await middleware(
      { method: "GET", url: "/workflows", headers: { accept: "text/html" } },
      responseFor(),
      next
    );

    expect(next).toHaveBeenCalledOnce();
  });
});
