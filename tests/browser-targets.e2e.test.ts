import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { after, before, describe, test } from "node:test";
import { browserEngines } from "../src/core/browser-session-contracts.js";
import {
  launchManagedBrowser,
  type ManagedBrowser,
} from "../src/server/browser-backends.js";
import { createPlaywrightCeremonyPage } from "../src/server/browser-page.js";
import { StaleTargetError } from "../src/server/browser-targets.js";

/**
 * The stale-target refusals, proved in real browsers.
 *
 * A unit test can show the adapter throwing. That is not the claim being made
 * here. The claim is that a secret is never delivered to an element or a
 * destination that was not approved — and the only thing that can establish
 * that is a server on the other end reporting what it did and did not receive.
 * Every case below stages the race inside a deliberately paused resolver, the
 * way a real attempt loses it (a model deciding, a broker fetching), and then
 * asks two independent questions: did the adapter refuse, and did the canary
 * reach anyone.
 */

const canary = "canary-9d41f2a7-never-sent";

type Recorder = {
  origin: string;
  received: { path: string; body: string }[];
  close(): Promise<void>;
};

/** A server that records exactly what was posted to it, and nothing else. */
async function recorder(html: (origin: string) => string): Promise<Recorder> {
  const received: { path: string; body: string }[] = [];
  const sockets = new Set<Socket>();
  let server: Server;
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push({ path: url.pathname, body });
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><title>Posted</title><p>ok</p>");
      });
      return;
    }
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html(origin) || pageFor(url.pathname, origin));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function pageFor(pathname: string, origin: string): string {
  return `<!doctype html><title>Race ${pathname}</title>
    <form id="form" method="post" action="${origin}/collect">
      <label>Password <input id="secret" name="password" type="password"></label>
      <button id="go" type="submit">Sign in</button>
    </form>`;
}

let provider: Recorder;
let elsewhere: Recorder;
const browsers = new Map<string, ManagedBrowser>();

before(async () => {
  provider = await recorder((origin) => pageFor("/race", origin));
  elsewhere = await recorder(() => "<!doctype html><title>Elsewhere</title>");
  for (const engine of browserEngines)
    browsers.set(engine, await launchManagedBrowser(engine));
});

after(async () => {
  for (const browser of browsers.values()) await browser.dispose();
  await provider.close();
  await elsewhere.close();
});

/**
 * Open a page, observe it, then run `disturb` — standing in for the await a
 * real attempt spends on inference or a credential lookup — and only then try
 * to type the canary.
 */
async function raceFill(
  engine: string,
  disturb: (raw: {
    evaluate(
      fn: string | ((arg: unknown) => unknown),
      arg?: unknown,
    ): Promise<unknown>;
    goto(
      url: string,
      options?: { waitUntil?: "domcontentloaded" },
    ): Promise<unknown>;
  }) => Promise<void>,
): Promise<StaleTargetError | undefined> {
  const context = await browsers.get(engine)!.openContext();
  try {
    const { page, raw } = await context.openPage();
    await page.goto(`${provider.origin}/race`);
    const snapshot = await page.snapshot();
    const field = snapshot.elements.find(
      (element) => element.type === "password",
    );
    assert.ok(field, "the fixture must present a password field");

    await disturb(raw as never);

    try {
      await page.fill(field, canary);
      return undefined;
    } catch (error) {
      if (error instanceof StaleTargetError) return error;
      throw error;
    }
  } finally {
    await context.close();
  }
}

for (const engine of browserEngines) {
  describe(`stale targets in real ${engine}`, () => {
    test("TARGET-MARKER: a replaced input never receives the value", async () => {
      const before = provider.received.length;
      const refusal = await raceFill(engine, async (raw) => {
        // The page swaps the approved control for an identical-looking one.
        // A selector would find the replacement; a held reference does not.
        await raw.evaluate(() => {
          const stale = document.querySelector("#secret")!;
          const fresh = document.createElement("input");
          fresh.id = "secret";
          fresh.name = "password";
          fresh.type = "password";
          stale.replaceWith(fresh);
        });
      });
      assert.ok(refusal, "the adapter must refuse a replaced element");
      assert.equal(refusal.reason, "stale-element");
      assert.equal(
        provider.received.length,
        before,
        "nothing may be submitted",
      );
    });

    test("TARGET-ASYNC: a same-origin navigation mid-race refuses", async () => {
      const before = provider.received.length;
      const refusal = await raceFill(engine, async (raw) => {
        // Same origin, different document. An origin comparison cannot see
        // this; comparing the document node can.
        await raw.goto(`${provider.origin}/race-two`, {
          waitUntil: "domcontentloaded",
        });
      });
      assert.ok(refusal, "the adapter must refuse after a navigation");
      assert.equal(refusal.reason, "stale-document");
      assert.equal(provider.received.length, before);
    });

    test("TARGET-FORM: a rewritten destination refuses before filling", async () => {
      const before = elsewhere.received.length;
      const refusal = await raceFill(engine, async (raw) => {
        await raw.evaluate((target) => {
          (document.querySelector("#form") as HTMLFormElement).action =
            String(target);
        }, `${elsewhere.origin}/collect`);
      });
      assert.ok(refusal, "a changed destination must be refused");
      assert.equal(refusal.reason, "unapproved-recipient");
      assert.equal(
        elsewhere.received.length,
        before,
        "the rewritten recipient must receive nothing",
      );
    });

    test("TARGET-FORM: a submitter `formaction` override refuses", async () => {
      const before = elsewhere.received.length;
      const context = await browsers.get(engine)!.openContext();
      try {
        const { page, raw } = await context.openPage();
        await page.goto(`${provider.origin}/race`);
        const snapshot = await page.snapshot();
        const button = snapshot.elements.find(
          (element) => element.kind === "button",
        );
        assert.ok(button);
        await (
          raw as never as {
            evaluate(
              fn: (t: unknown) => unknown,
              arg: unknown,
            ): Promise<unknown>;
          }
        ).evaluate((target) => {
          document
            .querySelector("#go")!
            .setAttribute("formaction", String(target));
        }, `${elsewhere.origin}/collect`);

        let refusal: StaleTargetError | undefined;
        try {
          await page.click(button);
        } catch (error) {
          if (error instanceof StaleTargetError) refusal = error;
          else throw error;
        }
        assert.ok(refusal, "a formaction override must be refused");
        assert.equal(refusal.reason, "unapproved-recipient");
        assert.equal(elsewhere.received.length, before);
      } finally {
        await context.close();
      }
    });

    test("a control that is still the approved one is acted on normally", async () => {
      // The refusals above are only meaningful if the ordinary path works.
      const context = await browsers.get(engine)!.openContext();
      try {
        const { page } = await context.openPage();
        await page.goto(`${provider.origin}/race`);
        const snapshot = await page.snapshot();
        const field = snapshot.elements.find(
          (element) => element.type === "password",
        )!;
        await assert.doesNotReject(page.fill(field, "ordinary-value"));
      } finally {
        await context.close();
      }
    });
  });
}
