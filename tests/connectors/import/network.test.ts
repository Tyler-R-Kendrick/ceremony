import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  classifyAddress,
  createApprovedFetch,
  evaluateNetworkTarget,
  isApprovedFetch,
  networkPolicy,
  NETWORK_LIMITS,
} from "../../../src/server/connectors/import/index.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import {
  CANARY,
  answerQueue,
  assertNoCanary,
  expectConnectorError,
  loopbackPolicy,
  publicPolicy,
} from "./support.js";

/*
 * IMP-02. Every assertion here goes through the real fetcher against loopback
 * fixture servers on ephemeral ports. DNS answers are injected through the
 * policy's lookup, which is the same seam the socket uses, so a rebinding test
 * exercises the production path rather than a parallel checker.
 */

const hostPort = (origin: string) => new URL(origin).port;

test("address classification separates public, private, loopback and forbidden space", () => {
  assert.equal(classifyAddress("93.184.216.34"), "public");
  assert.equal(classifyAddress("2606:4700:4700::1111"), "public");
  assert.equal(classifyAddress("10.0.0.5"), "private");
  assert.equal(classifyAddress("172.16.3.4"), "private");
  assert.equal(classifyAddress("192.168.1.1"), "private");
  assert.equal(classifyAddress("100.64.0.1"), "private");
  assert.equal(classifyAddress("fd00::1"), "private");
  assert.equal(classifyAddress("127.0.0.1"), "loopback");
  assert.equal(classifyAddress("::1"), "loopback");
  for (const address of [
    "169.254.169.254",
    "169.254.170.2",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "192.0.2.1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:93.184.216.34",
    "::ffff:a00:1",
    "2002::1",
    "64:ff9b::7f00:1",
    "not-an-address",
    "",
  ])
    assert.equal(classifyAddress(address), "forbidden", address);
});

test("URL policy refuses userinfo, schemes, literals and unexpected ports", () => {
  const policy = publicPolicy();
  const denied = (url: string, detail: string) => {
    const decision = evaluateNetworkTarget(url, policy);
    assert.equal(decision.allowed, false, url);
    assert.equal(decision.allowed === false && decision.detail, detail, url);
  };
  denied(`https://user:${CANARY}@api.example/spec.json`, "network.userinfo-forbidden");
  denied("https://%75ser:pass@api.example/x", "network.userinfo-forbidden");
  denied("http://api.example/spec.json", "network.scheme-forbidden");
  denied("file:///etc/passwd", "network.scheme-forbidden");
  denied("ftp://api.example/x", "network.scheme-forbidden");
  denied("gopher://api.example/x", "network.scheme-forbidden");
  denied("data:application/json,{}", "network.scheme-forbidden");
  // Decimal, octal and short forms all normalize to loopback before we see them.
  denied("https://2130706433/x", "network.address-forbidden");
  denied("https://0x7f000001/x", "network.address-forbidden");
  denied("https://0177.0.0.1/x", "network.address-forbidden");
  denied("https://127.1/x", "network.address-forbidden");
  denied("https://[::1]/x", "network.address-forbidden");
  denied("https://[::ffff:127.0.0.1]/x", "network.address-forbidden");
  denied("https://[::ffff:7f00:1]/x", "network.address-forbidden");
  denied("https://169.254.169.254/latest/meta-data/", "network.address-forbidden");
  denied("https://[fe80::1]/x", "network.address-forbidden");
  denied("https://localhost/x", "network.address-forbidden");
  denied("https://api.localhost/x", "network.address-forbidden");
  denied("https://10.0.0.5/x", "network.private-origin-not-approved");
  denied("https://[fd00::1]/x", "network.private-origin-not-approved");
  denied("https://api.example:8443/x", "network.port-forbidden");
  denied("not a url", "network.url-invalid");

  const allowed = evaluateNetworkTarget("https://api.example/spec.json", policy);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.allowed === true && allowed.network, "public");
  // The default HTTPS port is not an "unexpected port".
  assert.equal(evaluateNetworkTarget("https://api.example:443/x", policy).allowed, true);
});

test("an administrator-approved private origin is scoped to exactly that origin", async (t) => {
  const approved = "https://intranet.corp.example";
  const policy = publicPolicy({
    mode: "approved-private",
    approvedPrivateOrigins: [approved, "https://10.0.0.7:8443"],
  });
  assert.equal(evaluateNetworkTarget(`${approved}/spec.json`, policy).allowed, true);
  assert.equal(evaluateNetworkTarget("https://10.0.0.7:8443/spec", policy).allowed, true);
  // Another port, another scheme or another private address is not covered by
  // the approval, and no document can add one.
  for (const [url, detail] of [
    ["https://intranet.corp.example:8443/spec.json", "network.port-forbidden"],
    ["http://intranet.corp.example/spec.json", "network.scheme-forbidden"],
    ["https://10.0.0.8:8443/spec", "network.private-origin-not-approved"],
    ["https://10.0.0.7/spec", "network.private-origin-not-approved"],
    ["https://127.0.0.1/spec", "network.address-forbidden"],
  ] as const) {
    const decision = evaluateNetworkTarget(url, policy);
    assert.equal(decision.allowed, false, url);
    assert.equal(decision.allowed === false && decision.detail, detail, url);
  }

  // A different intranet name is not approved, so it is treated as an ordinary
  // public target: approving one private origin does not put the whole private
  // network behind the same policy. Its DNS answer is held to the public rule
  // and refused at connection time, without contacting anything.
  const sibling = evaluateNetworkTarget("https://other.corp.example/spec.json", policy);
  assert.equal(sibling.allowed, true);
  assert.equal(sibling.allowed === true && sibling.network, "public");
  const approvedTarget = evaluateNetworkTarget(`${approved}/spec.json`, policy);
  assert.equal(approvedTarget.allowed === true && approvedTarget.network, "approved-private");

  const privateAnswer = async () => [{ address: "10.0.0.5", family: 4 }];
  const fetcher = createApprovedFetch({ ...policy, lookup: privateAnswer, timeoutMs: 500 });
  t.after(() => fetcher.close());
  await expectConnectorError(
    fetcher("https://other.corp.example/spec.json"),
    "network-policy",
    "network.dns-forbidden-address",
  );
  // The approved origin's private answer is accepted by policy: the attempt
  // reaches the transport and fails there, not at the policy gate.
  await expectConnectorError(fetcher(`${approved}/spec.json`), "upstream-unavailable");
  // The same origin list means nothing under the public policy.
  assert.equal(
    evaluateNetworkTarget(`${approved}/spec.json`, publicPolicy()).allowed,
    false,
  );
  // Private origins may only be declared by the mode that can honour them.
  assert.throws(
    () =>
      networkPolicy({
        ...publicPolicy(),
        approvedPrivateOrigins: [approved],
      }),
    /not valid/,
  );
  // An approved origin must be an exact HTTPS origin, never a prefix or path.
  for (const origin of [
    "https://intranet.corp.example/",
    "https://intranet.corp.example/api",
    "http://intranet.corp.example",
    "intranet.corp.example",
    "https://*.corp.example",
  ])
    assert.throws(
      () =>
        networkPolicy({
          ...publicPolicy({ mode: "approved-private" }),
          approvedPrivateOrigins: [origin],
        }),
      /not valid/,
      origin,
    );
});

test("policies are bounded and a caller cannot widen them past the ceilings", () => {
  const resolved = networkPolicy(loopbackPolicy());
  assert.equal(resolved.maxRedirects, 3);
  assert.equal(Object.isFrozen(resolved), true);
  const defaults = networkPolicy({ mode: "public" } as never);
  assert.equal(defaults.maxRedirects, NETWORK_LIMITS.maxRedirects);
  assert.equal(defaults.maxResponseBytes, NETWORK_LIMITS.maxResponseBytes);
  assert.equal(defaults.timeoutMs, NETWORK_LIMITS.timeoutMs);
  assert.equal(defaults.allowCompressedResponses, false);
  for (const policy of [
    { mode: "anything-goes" },
    { mode: "public", maxRedirects: 99 },
    { mode: "public", maxResponseBytes: 0 },
    { mode: "public", timeoutMs: 10 * 60_000 },
    { mode: "public", maxResponseBytes: 1.5 },
    { mode: "public", lookup: "nope" },
  ])
    assert.throws(() => networkPolicy(policy as never), /not valid/);
});

test("a fixture document is retrieved, and a rebound DNS answer is refused before connecting", async (t) => {
  const fixture = await startHttpFixture(() => ({ body: { ok: true } }));
  t.after(() => fixture.close());
  const { resolve, calls } = answerQueue(
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "10.0.0.5", family: 4 }],
    [
      { address: "127.0.0.1", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ],
  );
  const approved = createApprovedFetch(loopbackPolicy({ lookup: resolve }));
  t.after(() => approved.close());
  const origin = `http://localhost:${hostPort(fixture.origin)}`;

  const first = await approved(`${origin}/openapi.json`);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true });
  assert.deepEqual(calls, ["localhost"]);

  // Same hostname, same policy, a private answer this time: refused at the
  // socket's own lookup, so the fixture never sees a second request.
  await expectConnectorError(
    approved(`${origin}/rebound.json`),
    "network-policy",
    "network.dns-forbidden-address",
  );
  // A mixed answer set is refused as a whole rather than filtered down.
  await expectConnectorError(
    approved(`${origin}/mixed.json`),
    "network-policy",
    "network.dns-forbidden-address",
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(
    fixture.requests.map((request) => request.url.pathname),
    ["/openapi.json"],
  );
});

test("DNS failures and empty answers are policy denials, not silent fallbacks", async (t) => {
  const failing = createApprovedFetch(
    loopbackPolicy({
      lookup: async () => {
        throw new Error(`resolver exploded for ${CANARY}`);
      },
    }),
  );
  t.after(() => failing.close());
  const error = await expectConnectorError(
    failing("http://localhost:45001/x"),
    "network-policy",
    "network.dns-forbidden-address",
  );
  assertNoCanary(error);

  const empty = createApprovedFetch(loopbackPolicy({ lookup: async () => [] }));
  t.after(() => empty.close());
  await expectConnectorError(
    empty("http://localhost:45001/x"),
    "network-policy",
    "network.dns-forbidden-address",
  );
});

test("redirects are followed manually, revalidated per hop and bounded", async (t) => {
  const target = await startHttpFixture(() => ({ body: { reached: "second" } }));
  t.after(() => target.close());
  const targetPort = hostPort(target.origin);
  const source = await startHttpFixture((request) => {
    const to = request.url.searchParams.get("to");
    if (to !== null) return { status: 302, headers: { location: to } };
    if (request.url.pathname === "/loop")
      return { status: 302, headers: { location: "/loop" } };
    if (request.url.pathname === "/final") return { body: { reached: "first" } };
    return { body: { path: request.url.pathname } };
  });
  t.after(() => source.close());
  const approved = createApprovedFetch(loopbackPolicy());
  t.after(() => approved.close());
  const origin = source.origin;

  // Same-origin redirects are followed and reported at their final URL.
  const followed = await approved(`${origin}/start?to=/final`);
  assert.equal(followed.status, 200);
  assert.deepEqual(await followed.json(), { reached: "first" });
  assert.equal(followed.url, `${origin}/final`);

  // A cross-origin redirect is refused even though both ends are loopback.
  await expectConnectorError(
    approved(`${origin}/start?to=${encodeURIComponent(`http://127.0.0.1:${targetPort}/x`)}`),
    "network-policy",
    "network.redirect-cross-origin",
  );
  assert.equal(target.requests.length, 0);

  // ... unless the policy itself lists the destination origin.
  const listed = createApprovedFetch(
    loopbackPolicy({ allowedOrigins: [`http://127.0.0.1:${targetPort}`] }),
  );
  t.after(() => listed.close());
  const crossed = await listed(
    `${origin}/start?to=${encodeURIComponent(`http://127.0.0.1:${targetPort}/x`)}`,
  );
  assert.deepEqual(await crossed.json(), { reached: "second" });
  assert.equal(target.requests.length, 1);

  // Private, metadata, mapped-literal and credentialed targets stay refused,
  // and each is refused for its own reason rather than a generic one.
  for (const [to, detail] of [
    ["http://10.0.0.5/x", "network.loopback-fixture-only"],
    ["http://169.254.169.254/latest/meta-data/", "network.loopback-fixture-only"],
    ["http://[::ffff:127.0.0.1]/x", "network.loopback-fixture-only"],
    ["http://2130706433/x", "network.redirect-cross-origin"],
    [`http://user:${CANARY}@127.0.0.1:${targetPort}/x`, "network.userinfo-forbidden"],
    ["file:///etc/passwd", "network.scheme-forbidden"],
  ] as const) {
    const error = await expectConnectorError(
      listed(`${origin}/start?to=${encodeURIComponent(to)}`),
      "network-policy",
      detail,
    );
    assertNoCanary(error);
  }

  await expectConnectorError(
    approved(`${origin}/loop`),
    "network-policy",
    "network.redirect-limit",
  );
  // redirect: "error" and "manual" are honoured without following anything.
  await expectConnectorError(
    approved(`${origin}/start?to=/final`, { redirect: "error" }),
    "network-policy",
    "network.redirect-refused",
  );
  const manual = await approved(`${origin}/start?to=/final`, { redirect: "manual" });
  assert.equal(manual.status, 302);
  assert.equal(manual.headers.get("location"), "/final");
});

test("credentials are stripped on every redirect, including same-origin", async (t) => {
  const fixture = await startHttpFixture((request) =>
    request.url.pathname === "/start"
      ? { status: 307, headers: { location: "/second" } }
      : { body: { ok: true } },
  );
  t.after(() => fixture.close());
  const approved = createApprovedFetch(loopbackPolicy());
  t.after(() => approved.close());
  const response = await approved(`${fixture.origin}/start`, {
    headers: {
      authorization: `Bearer ${CANARY}`,
      cookie: `session=${CANARY}`,
      "x-trace": "keep-me",
    },
  });
  assert.equal(response.status, 200);
  const [first, second] = fixture.requests;
  assert.equal(first?.headers.authorization, `Bearer ${CANARY}`);
  assert.equal(second?.url.pathname, "/second");
  assert.equal(second?.headers.authorization, undefined);
  assert.equal(second?.headers.cookie, undefined);
  // A non-credential header is not the responder's business to see changed.
  assert.equal(second?.headers["x-trace"], "keep-me");
});

test("a 303 or POST redirect becomes a bodyless GET", async (t) => {
  const fixture = await startHttpFixture((request) =>
    request.url.pathname === "/submit"
      ? { status: 303, headers: { location: "/result" } }
      : { body: { ok: true } },
  );
  t.after(() => fixture.close());
  const approved = createApprovedFetch(loopbackPolicy());
  t.after(() => approved.close());
  await approved(`${fixture.origin}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"a":1}',
  });
  const [first, second] = fixture.requests;
  assert.equal(first?.method, "POST");
  assert.equal(first?.body.toString(), '{"a":1}');
  assert.equal(second?.method, "GET");
  assert.equal(second?.body.length, 0);
  assert.equal(second?.headers["content-type"], undefined);
});

test("response size is bounded while streaming and Content-Length is never trusted", async (t) => {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/lying") {
      // Claims to be tiny, then streams far more than the ceiling.
      res.writeHead(200, { "content-type": "application/json", "content-length": "12" });
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      let sent = 0;
      const push = () => {
        while (sent < 4 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", push);
            return;
          }
        }
        res.end();
      };
      push();
      return;
    }
    if (req.url === "/declared") {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(8 * 1024 * 1024),
      });
      res.end(Buffer.alloc(1024));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const approved = createApprovedFetch(
    loopbackPolicy({ maxResponseBytes: 256 * 1024 }),
  );
  t.after(() => approved.close());

  await expectConnectorError(
    approved(`${origin}/lying`),
    "network-policy",
    "network.response-too-large",
  );
  // A declared oversize length is refused early, without reading the body.
  await expectConnectorError(
    approved(`${origin}/declared`),
    "network-policy",
    "network.response-too-large",
  );
  assert.deepEqual(await (await approved(`${origin}/small`)).json(), { ok: true });
});

test("compressed responses are refused unless allowed, and then bounded by decoded size", async (t) => {
  const payload = Buffer.alloc(8 * 1024 * 1024, 0x20);
  const fixture = await startHttpFixture((request) => ({
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
    body: gzipSync(
      request.url.pathname === "/bomb" ? payload : Buffer.from('{"ok":true}'),
    ),
  }));
  t.after(() => fixture.close());

  const strict = createApprovedFetch(loopbackPolicy());
  t.after(() => strict.close());
  // The request asked for identity; a body that arrives compressed anyway is
  // refused rather than silently inflated.
  assert.equal(fixture.requests.length, 0);
  await expectConnectorError(
    strict(`${fixture.origin}/small`),
    "network-policy",
    "network.compressed-response-refused",
  );
  assert.equal(fixture.requests[0]?.headers["accept-encoding"], "identity");

  const lenient = createApprovedFetch(
    loopbackPolicy({ allowCompressedResponses: true, maxResponseBytes: 256 * 1024 }),
  );
  t.after(() => lenient.close());
  const ok = await lenient(`${fixture.origin}/small`);
  assert.deepEqual(await ok.json(), { ok: true });
  // A decompression bomb is cut off at the ceiling of decoded bytes.
  await expectConnectorError(
    lenient(`${fixture.origin}/bomb`),
    "network-policy",
    "network.response-too-large",
  );
});

test("timeouts and caller cancellation are distinct sanitized outcomes", async (t) => {
  const stalled = createServer(() => {
    /* Never responds: the request outlives the policy's budget. */
  });
  stalled.listen(0, "127.0.0.1");
  await once(stalled, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        stalled.closeAllConnections();
        stalled.close(() => resolve());
      }),
  );
  const origin = `http://127.0.0.1:${(stalled.address() as AddressInfo).port}`;
  const approved = createApprovedFetch(loopbackPolicy({ timeoutMs: 300 }));
  t.after(() => approved.close());

  const started = Date.now();
  await expectConnectorError(
    approved(`${origin}/slow`),
    "upstream-unavailable",
    "network.timeout",
  );
  assert.ok(Date.now() - started < 5_000);

  const controller = new AbortController();
  const pending = approved(`${origin}/slow`, { signal: controller.signal });
  controller.abort();
  await expectConnectorError(pending, "cancelled");
});

test("request shape is bounded and the transport owns its own framing headers", async (t) => {
  const fixture = await startHttpFixture(() => ({ body: { ok: true } }));
  t.after(() => fixture.close());
  const approved = createApprovedFetch(
    loopbackPolicy({ maxRequestBytes: 1024 }),
  );
  t.after(() => approved.close());
  await expectConnectorError(
    approved(`${fixture.origin}/x`, { method: "POST", body: "x".repeat(2048) }),
    "invalid-request",
    "network.request-too-large",
  );
  await expectConnectorError(
    approved(`${fixture.origin}/x`, {
      method: "POST",
      body: new ReadableStream(),
      // @ts-expect-error duplex is required for stream bodies and unsupported here
      duplex: "half",
    }),
    "invalid-request",
    "network.request-body-unsupported",
  );
  await expectConnectorError(
    approved(`${fixture.origin}/x`, { method: "TRACE ME" }),
    "invalid-request",
    "network.method-invalid",
  );
  // A caller cannot smuggle a different Host or a hop-by-hop header.
  await approved(`${fixture.origin}/x`, {
    headers: { host: "evil.example", "transfer-encoding": "chunked", accept: "application/json" },
  });
  const request = fixture.requests.at(-1)!;
  assert.equal(request.headers.host, new URL(fixture.origin).host);
  assert.equal(request.headers["transfer-encoding"], undefined);
  assert.equal(request.headers.accept, "application/json");
});

test("the approved fetcher is recognizable and refuses non-loopback work in fixture mode", async (t) => {
  const approved = createApprovedFetch(loopbackPolicy());
  t.after(() => approved.close());
  assert.equal(isApprovedFetch(approved), true);
  assert.equal(isApprovedFetch(globalThis.fetch), false);
  assert.equal(isApprovedFetch(undefined), false);
  assert.equal(approved.policy.mode, "loopback-fixture");
  for (const url of [
    "https://api.example/spec.json",
    "http://10.0.0.5/spec.json",
    "http://169.254.169.254/latest/",
  ])
    await expectConnectorError(
      approved(url),
      "network-policy",
      "network.loopback-fixture-only",
    );
});
