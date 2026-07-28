import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveClientAsset } from "@/backend/lib/http/client-assets";

const INDEX_HTML =
  '<!doctype html><html><head><base href="/" /></head><body></body></html>';

let clientDir: string;

beforeAll(async () => {
  clientDir = await mkdtemp(join(tmpdir(), "rova-client-"));
  await writeFile(join(clientDir, "index.html"), INDEX_HTML);
  await writeFile(join(clientDir, "app.js"), "export const ok = true;\n");
});

afterAll(async () => {
  await rm(clientDir, { recursive: true, force: true });
});

describe("serveClientAsset", () => {
  it("serves a real file with a content type derived from its extension", async () => {
    const response = await serveClientAsset({
      clientDir,
      basePath: "",
      pathname: "/app.js",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8"
    );
    expect(await response.text()).toContain("export const ok");
  });

  it("falls back to the SPA entry on a router-owned path", async () => {
    const response = await serveClientAsset({
      clientDir,
      basePath: "",
      pathname: "/workflows/abc123",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<base href="/" />');
  });

  // The bare path, without the trailing slash the prefix rule above matches on.
  // It only answers because it is spelled out in the SPA path set, so a case of
  // its own keeps that entry from being dropped as redundant.
  it("falls back to the SPA entry on the bare workflows list path", async () => {
    const response = await serveClientAsset({
      clientDir,
      basePath: "",
      pathname: "/workflows",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<base href="/" />');
  });

  it("points the SPA entry at the mount point when Rova is mounted under one", async () => {
    const response = await serveClientAsset({
      clientDir,
      basePath: "/rova",
      pathname: "/",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<base href="/rova/" />');
  });

  it("404s a non-SPA path with no file behind it", async () => {
    const response = await serveClientAsset({
      clientDir,
      basePath: "",
      pathname: "/missing.css",
    });

    expect(response.status).toBe(404);
  });

  it("refuses to read outside the client directory", async () => {
    for (const pathname of [
      "/../package.json",
      "/%2e%2e/package.json",
      "/nested/../../package.json",
    ]) {
      const response = await serveClientAsset({
        clientDir,
        basePath: "",
        pathname,
      });
      expect(response.status).toBe(404);
    }
  });

  it("reports a missing client bundle rather than pretending the route is gone", async () => {
    const response = await serveClientAsset({
      clientDir: join(clientDir, "not-built"),
      basePath: "",
      pathname: "/",
    });

    expect(response.status).toBe(503);
  });
});
