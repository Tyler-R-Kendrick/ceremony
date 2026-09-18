import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { firefox } from "playwright-core";

/**
 * The Gecko artifact loaded into a real Firefox.
 *
 * Playwright cannot install an add-on through its own API, so this drives
 * Firefox's remote debugging protocol — the same `installTemporaryAddon` call
 * `web-ext run` makes — against the browser Playwright launched. What that
 * proves is a real install of the built directory into a real Firefox: the
 * manifest is accepted with no warnings, the MV3 event page starts, and the
 * app bridge round-trips through the content-script relay on the admitted
 * origin while an identical page on a non-admitted origin gets nothing.
 *
 * What it does not prove: signing, AMO distribution, installation into a
 * pre-existing user profile, or any real provider login.
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const addonId = "browser-login@ceremony.invalid";

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

/** Firefox's remote debugging protocol: `<byteLength>:<json>` both ways. */
function remoteDebugger(port: number) {
  const socket = net.connect(port, "127.0.0.1");
  let buffer = Buffer.alloc(0);
  const waiting: ((packet: Record<string, unknown>) => void)[] = [];
  const arrived: Record<string, unknown>[] = [];
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const colon = buffer.indexOf(0x3a);
      if (colon < 0) return;
      const length = Number(buffer.subarray(0, colon).toString("ascii"));
      if (!Number.isFinite(length) || buffer.length < colon + 1 + length)
        return;
      const packet = JSON.parse(
        buffer.subarray(colon + 1, colon + 1 + length).toString("utf8"),
      ) as Record<string, unknown>;
      buffer = buffer.subarray(colon + 1 + length);
      const next = waiting.shift();
      if (next) next(packet);
      else arrived.push(packet);
    }
  });
  return {
    socket,
    next: () =>
      new Promise<Record<string, unknown>>((resolve) => {
        const ready = arrived.shift();
        if (ready) resolve(ready);
        else waiting.push(resolve);
      }),
    send(message: unknown) {
      const body = Buffer.from(JSON.stringify(message), "utf8");
      socket.write(`${body.length}:`);
      socket.write(body);
    },
  };
}

async function connectDebugger(port: number, deadline: number) {
  for (;;) {
    const client = remoteDebugger(port);
    const connected = await new Promise<boolean>((resolve) => {
      client.socket.once("connect", () => resolve(true));
      client.socket.once("error", () => resolve(false));
    });
    if (connected) return client;
    client.socket.destroy();
    if (Date.now() > deadline) throw new Error("no debugger server");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

test(
  "the built Firefox add-on installs and bridges in a real Firefox",
  { timeout: 240_000 },
  async () => {
    const appPort = await freePort();
    const strangerPort = await freePort();
    const appOrigin = `http://127.0.0.1:${appPort}`;
    // Same host, different port: a match pattern cannot tell these apart, so
    // this is the page that proves the exact-origin check is doing the work.
    const strangerOrigin = `http://127.0.0.1:${strangerPort}`;
    const page_html =
      "<!doctype html><title>Ceremony app fixture</title><h1>App</h1>";
    const servers = [appPort, strangerPort].map((port) => {
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(page_html);
      });
      server.listen(port, "127.0.0.1");
      return server;
    });
    await Promise.all(servers.map((server) => once(server, "listening")));

    const staging = await mkdtemp(join(tmpdir(), "ceremony-firefox-load-"));
    const profile = await mkdtemp(join(tmpdir(), "ceremony-firefox-profile-"));
    let context;
    try {
      await mkdir(join(staging, "scripts"));
      await Promise.all([
        cp(
          join(root, "scripts/build-extension.mjs"),
          join(staging, "scripts/build-extension.mjs"),
        ),
        cp(join(root, "extensions"), join(staging, "extensions"), {
          recursive: true,
        }),
        cp(join(root, "src"), join(staging, "src"), { recursive: true }),
        symlink(
          join(root, "node_modules"),
          join(staging, "node_modules"),
          "dir",
        ),
      ]);
      execFileSync(process.execPath, ["scripts/build-extension.mjs"], {
        cwd: staging,
        timeout: 120_000,
        stdio: "pipe",
        env: { ...process.env, CEREMONY_EXTENSION_APP_ORIGINS: appOrigin },
      });
      const unpacked = join(staging, "extension-dist/firefox");

      const debuggerPort = await freePort();
      context = await firefox.launchPersistentContext(profile, {
        headless: true,
        args: ["--start-debugger-server", String(debuggerPort)],
        firefoxUserPrefs: {
          "devtools.debugger.remote-enabled": true,
          "devtools.debugger.prompt-connection": false,
        },
      });
      const client = await connectDebugger(debuggerPort, Date.now() + 30_000);
      await client.next();
      client.send({ to: "root", type: "getRoot" });
      const addonsActor = (await client.next())["addonsActor"];
      assert.equal(typeof addonsActor, "string");
      client.send({
        to: addonsActor,
        type: "installTemporaryAddon",
        addonPath: unpacked,
        openDevTools: false,
      });
      const installed = (await client.next()) as {
        addon?: { id?: string };
        error?: string;
        message?: string;
      };
      assert.equal(
        installed.addon?.id,
        addonId,
        `install failed: ${JSON.stringify(installed)}`,
      );

      let described: Record<string, unknown> | undefined;
      const until = Date.now() + 30_000;
      for (;;) {
        client.send({ to: "root", type: "listAddons" });
        const listed = (await client.next()) as {
          addons?: Record<string, unknown>[];
        };
        described = listed.addons?.find((addon) => addon["id"] === addonId);
        if (described?.["backgroundScriptStatus"] === "RUNNING") break;
        assert.ok(Date.now() < until, "background script never started");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      // No manifest warnings: Firefox parsed every key this artifact declares.
      assert.deepEqual(described["warnings"], []);
      assert.equal(described["isWebExtension"], true);
      assert.equal(described["temporarilyInstalled"], true);
      // MV3 on Gecko is an event page, not a persistent background page.
      assert.equal(described["persistentBackgroundScript"], false);
      assert.match(
        String(described["manifestURL"]),
        /^moz-extension:\/\/[0-9a-f-]{36}\/manifest\.json$/,
      );

      const ask = (origin: string) => `new Promise((resolve) => {
        addEventListener("message", (event) => {
          if (event.source !== window) return;
          const data = event.data;
          if (data && data.channel === "ceremony.extension" && data.kind === "reply")
            resolve(data);
        });
        window.postMessage({
          channel: "ceremony.extension",
          kind: "request",
          id: "11111111-1111-4111-8111-111111111111",
          request: { type: "ceremony.ping", protocol: 1 },
        }, ${JSON.stringify(origin)});
        setTimeout(() => resolve(null), 8000);
      })`;

      const app = await context.newPage();
      await app.goto(`${appOrigin}/`, { waitUntil: "domcontentloaded" });
      assert.deepEqual(await app.evaluate(ask(appOrigin)), {
        channel: "ceremony.extension",
        kind: "reply",
        id: "11111111-1111-4111-8111-111111111111",
        reply: { protocol: 1, version: "0.1.0" },
      });

      const stranger = await context.newPage();
      await stranger.goto(`${strangerOrigin}/`, {
        waitUntil: "domcontentloaded",
      });
      assert.equal(
        await stranger.evaluate(ask(strangerOrigin)),
        null,
        "a page on a non-admitted port must not reach the extension",
      );
      client.socket.destroy();
    } finally {
      await context?.close();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
      );
      await rm(staging, { recursive: true, force: true });
      await rm(profile, { recursive: true, force: true });
    }
  },
);
