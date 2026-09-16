import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo, LookupFunction } from "node:net";
import { PassThrough } from "node:stream";
import tls from "node:tls";
import { test } from "node:test";
import {
  createPublicAuthFetch,
  createPublicAuthLookup,
  isPublicAuthAddress,
  loopbackAuthFetch,
  publicAuthFetch,
} from "../src/server/public-auth-fetch.js";
import { registerDynamicClient } from "../src/server/authored-app.js";
import {
  beginAuthorization,
  exchangeAuthorizationCode,
} from "../src/server/authored-oauth.js";

test("default socket lookup preserves the operating system's public address preference", async (t) => {
  const answers = [
    { address: "2606:4700:4700::1111", family: 6 },
    { address: "1.1.1.1", family: 4 },
  ];
  const resolver = t.mock.method(
    dns,
    "lookup",
    async (hostname: string, options: { all: boolean; verbatim: boolean }) => {
      assert.equal(hostname, "provider.example");
      assert.equal(options.all, true);
      // Model an IPv6-first OS resolver: opting out of verbatim ordering
      // prioritizes IPv4, which can select an unreachable provider interface.
      return options.verbatim ? answers : [...answers].reverse();
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    resolver.mock.restore();
    syncBuiltinESMExports();
  });
  const lookup = createPublicAuthLookup();
  const replies: unknown[] = [];
  lookup("provider.example", {}, (error, address, family) => {
    replies.push({ error, address, family });
  });
  lookup("provider.example", { all: true }, (error, addresses) => {
    replies.push({ error, addresses });
  });
  // The injected resolver settles immediately. Drain its callbacks, then
  // assert they occurred; a missing socket callback must fail, not hang.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(replies, [
    { error: null, ...answers[0] },
    { error: null, addresses: answers },
  ]);
});

test("outbound address policy excludes private, special, mapped and transition networks", () => {
  for (const address of [
    "not-an-address",
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "64:ff9b::7f00:1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "3fff::1",
  ])
    assert.equal(isPublicAuthAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
    assert.equal(isPublicAuthAddress(address), true, address);
});

test("private literal and non-HTTPS endpoints are rejected before transport", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("unexpected");
  });
  for (const endpoint of [
    "https://127.0.0.1/private",
    "https://2130706433/private",
    "https://0x7f000001/private",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/private",
    "https://[::ffff:127.0.0.1]/private",
    "https://[fc00::1]/private",
    "http://provider.example/private",
    "http://127.0.0.1/private",
    "http://localhost/private",
    "file:///etc/passwd",
    "https://name:password@provider.example/private",
  ])
    await assert.rejects(publicAuthFetch(endpoint));
  for (const endpoint of [
    "ftp://localhost/private",
    "http://provider.example/private",
  ])
    await assert.rejects(loopbackAuthFetch(endpoint));
  assert.equal(calls, 0);
  for (const endpoint of ["http://127.0.0.1/private", "http://[::1]/private"])
    assert.equal((await loopbackAuthFetch(endpoint)).status, 200);
  assert.equal(calls, 2);
});

test("connection-time lookup rejects private and mixed DNS answers before connecting", async (t) => {
  // Keep fault/mutation tests offline even if a broken guard admits an internal IP.
  t.mock.method(
    tls,
    "connect",
    (
      options: tls.ConnectionOptions & {
        lookup?: LookupFunction;
        host?: string;
      },
    ) => {
      assert.equal(options.servername, "provider.example");
      assert.notEqual(options.rejectUnauthorized, false);
      const socket = Object.assign(new PassThrough(), {
        setKeepAlive() {
          return this;
        },
        setNoDelay() {
          return this;
        },
      });
      queueMicrotask(() => {
        if (!options.lookup)
          return socket.destroy(new Error("unguarded DNS lookup"));
        options.lookup(options.host!, { all: true }, (error) =>
          socket.destroy(error ?? new Error("unexpected DNS acceptance")),
        );
      });
      return socket as unknown as tls.TLSSocket;
    },
  );
  for (const answers of [
    [],
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "::ffff:127.0.0.1", family: 6 }],
    [{ address: "fc00::1", family: 6 }],
    [
      { address: "1.1.1.1", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ],
  ]) {
    let lookups = 0;
    const guarded = createPublicAuthFetch({
      allowLoopbackHttp: true,
      lookup: async () => {
        lookups++;
        return answers;
      },
    });
    await assert.rejects(
      guarded("https://provider.example/private", {
        signal: AbortSignal.timeout(2_000),
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message === "Auth endpoint is not public",
    );
    assert.equal(lookups, 1);
  }
  const failedDns = createPublicAuthFetch({
    lookup: async () => {
      throw new Error("injected DNS failure");
    },
  });
  await assert.rejects(
    failedDns("https://provider.example", {
      signal: AbortSignal.timeout(1_000),
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.cause instanceof Error &&
      error.cause.message === "Auth endpoint is not public",
  );
});

test("loopback fixtures pin each connection and never follow redirects", async (t) => {
  const received: string[] = [];
  const server = createServer((request, response) => {
    received.push(request.url!);
    response.setHeader("connection", "close");
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/escaped" });
      response.end();
    } else response.end("fixture");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  let calls = 0;
  const guarded = createPublicAuthFetch({
    allowLoopbackHttp: true,
    lookup: async (hostname) => {
      assert.equal(hostname, "localhost");
      calls++;
      return [{ address: calls <= 2 ? "127.0.0.1" : "127.0.0.2", family: 4 }];
    },
  });
  assert.equal(
    await (
      await guarded(`${origin}/safe`, { signal: AbortSignal.timeout(1_000) })
    ).text(),
    "fixture",
  );
  assert.equal(calls, 1, "the socket must use the checked DNS answer directly");
  await assert.rejects(
    guarded(`${origin}/redirect`, {
      redirect: "follow",
      signal: AbortSignal.timeout(1_000),
    }),
  );
  assert.equal(calls, 2);
  await assert.rejects(
    guarded(`${origin}/rebound`, { signal: AbortSignal.timeout(1_000) }),
  );
  assert.equal(calls, 3);
  assert.deepEqual(received, ["/safe", "/redirect"]);
  assert.equal(
    await (
      await loopbackAuthFetch(`${origin}/default`, {
        signal: AbortSignal.timeout(1_000),
      })
    ).text(),
    "fixture",
  );
  assert.deepEqual(received, ["/safe", "/redirect", "/default"]);
});

test("the connector supplies only vetted answers of the requested address family", async (t) => {
  const publicAnswers = [
    { address: "1.1.1.1", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ];
  for (const [settings, answers] of [
    [{ all: false, family: 4 }, publicAnswers],
    [{ all: false, family: 6 }, publicAnswers],
    [{ all: true, family: 6 }, publicAnswers],
    [{ all: false, family: 4 }, [publicAnswers[1]!]],
  ] as const) {
    let checked = false;
    t.mock.method(
      tls,
      "connect",
      (
        options: tls.ConnectionOptions & {
          lookup?: LookupFunction;
          host?: string;
        },
      ) => {
        const socket = Object.assign(new PassThrough(), {
          setKeepAlive() {
            return this;
          },
          setNoDelay() {
            return this;
          },
        });
        queueMicrotask(() => {
          if (!options.lookup)
            return socket.destroy(new Error("unguarded lookup"));
          options.lookup(options.host!, settings, (error, address, family) => {
            try {
              const expected = answers.filter(
                (answer) => answer.family === settings.family,
              );
              if (!expected.length)
                assert.equal(error?.message, "Auth endpoint is not public");
              else {
                assert.equal(error, null);
                assert.deepEqual(
                  address,
                  settings.all ? expected : expected[0]!.address,
                );
                assert.equal(
                  family,
                  settings.all ? undefined : expected[0]!.family,
                );
              }
              checked = true;
            } finally {
              socket.destroy(new Error("offline connection probe complete"));
            }
          });
        });
        return socket as unknown as tls.TLSSocket;
      },
    );
    const guarded = createPublicAuthFetch({ lookup: async () => [...answers] });
    await assert.rejects(
      guarded("https://provider.example", {
        signal: AbortSignal.timeout(1_000),
      }),
    );
    assert.equal(checked, true);
    t.mock.restoreAll();
  }
});

test("default PAR, token and DCR transports reject malicious discovered endpoints", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ client_id: "unexpected" });
  });
  const discovery = {
    origin: "https://provider.example",
    authorizationEndpoint: "https://provider.example/authorize",
    tokenEndpoint: "https://127.0.0.1:9443/token",
  };
  await assert.rejects(
    exchangeAuthorizationCode({
      discovery,
      clientId: "client",
      redirectUri: "https://ceremony.example/return",
      callbackUrl:
        "https://ceremony.example/return?code=synthetic-code&state=state",
      verifier: "synthetic-verifier",
      state: "state",
    }),
    /Auth endpoint is not public/,
  );
  await assert.rejects(
    beginAuthorization({
      discovery: {
        ...discovery,
        pushedAuthorizationRequestEndpoint: "https://[::1]:9443/par",
        requirePushedAuthorizationRequests: true,
      },
      clientId: "client",
      redirectUri: "https://ceremony.example/return",
      scope: "openid",
    }),
    /Auth endpoint is not public/,
  );
  await assert.rejects(
    registerDynamicClient(
      "https://169.254.169.254/register",
      "https://ceremony.example/return",
      "provider",
      publicAuthFetch,
      ["authorization_code"],
    ),
    /Auth endpoint is not public/,
  );
  assert.equal(calls, 0);
});
