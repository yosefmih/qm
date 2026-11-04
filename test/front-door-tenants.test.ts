import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWebReleaseStore, deployBundledRelease } from "../src/web/releases.ts";
import { startFrontDoor } from "../src/web/front-door.ts";
import { loadConfig } from "../src/config.ts";
import { hostRequest } from "./support/host-request.ts";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const HOSTS: Record<string, string> = { "a.example.test": A, "b.example.test": B };
const SHARE = "11111111-1111-4111-8111-111111111111";

const shareTenants: Array<string | undefined> = [];
const core = createServer((req: IncomingMessage, res) => {
  req.resume();
  const path = (req.url ?? "").split("?")[0] ?? "";
  if (path.startsWith("/v1/operator/hosts/")) {
    const tenant = HOSTS[decodeURIComponent(path.split("/").at(-1) ?? "")];
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ ...(tenant ? { tenant } : {}), multi: true }));
  }
  if (path.startsWith(`/v1/public-shares/${SHARE}`)) {
    const tenant = req.headers["x-qm-tenant"];
    shareTenants.push(typeof tenant === "string" ? tenant : undefined);
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));

const dataDir = mkdtempSync(join(tmpdir(), "qm-front-door-tenants-"));
const bundle = join(dataDir, "bundle");
mkdirSync(join(bundle, "assets"), { recursive: true });
writeFileSync(join(bundle, "index.html"), "<title>front door</title>");
writeFileSync(join(bundle, "shared.html"), "<title>shared</title>");
writeFileSync(join(bundle, "assets", "app-front.js"), "export const ok = 1;\n");
await deployBundledRelease(createLocalWebReleaseStore(join(dataDir, "web-ui")), bundle);

const publicPort = await new Promise<number>((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const port = (probe.address() as AddressInfo).port;
    probe.close(() => resolve(port));
  });
});
process.env.CORE_SIGNING_SECRET = "front-door-tenants-signing-secret-0123456789";
const door = await startFrontDoor(
  { ...loadConfig({}), dataDir, port: (core.address() as AddressInfo).port, publicPort },
  process.env,
);
const base = `http://127.0.0.1:${publicPort}`;

test.after(() => {
  door.close();
  door.terminate();
  core.close();
});

test("hashed assets load on every host, including one that maps to no tenant", async () => {
  for (const host of ["a.example.test", "b.example.test", "stranger.example.test"]) {
    const asset = await hostRequest(`${base}/assets/app-front.js`, host);
    assert.equal(asset.status, 200, host);
    assert.match(asset.text, /export const ok = 1;/);
  }
});

test("pages on a host that maps to no tenant are refused", async () => {
  const page = await hostRequest(`${base}/`, "stranger.example.test", { headers: { accept: "text/html" } });
  assert.equal(page.status, 421);
  assert.equal(JSON.parse(page.text).error, "unknown_host");
});

test("a public share reaches core under the tenant of the host it was requested on", async () => {
  shareTenants.length = 0;
  await hostRequest(`${base}/share/external/${SHARE}`, "a.example.test");
  await hostRequest(`${base}/share/external/${SHARE}`, "b.example.test");
  assert.deepEqual(shareTenants, [A, B]);
});

test("a write from a tenant host's own origin passes the same-origin check, and another tenant's origin is refused", async () => {
  const logout = (origin: string) =>
    hostRequest(`${base}/auth/logout`, "a.example.test", {
      method: "POST",
      headers: { origin, "sec-fetch-site": origin === "http://a.example.test" ? "same-origin" : "cross-site" },
    });
  assert.notEqual((await logout("http://a.example.test")).status, 403);
  assert.equal((await logout("http://b.example.test")).status, 403);
});
