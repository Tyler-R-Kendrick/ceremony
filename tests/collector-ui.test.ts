import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { parseHTML } from "linkedom";
import { App } from "@modelcontextprotocol/ext-apps";
import { mountPrivateCollector } from "../src/mcp-app/index.js";

for (const outcome of [
  "success",
  "provider-failure",
  "bind-failure",
  "malformed-response",
] as const)
  test(`behavior: private MCP collector ${outcome} clears secrets and passes references only`, async (t) => {
    const { document, Event } = parseHTML(
      "<html><body><main></main></body></html>",
    );
    const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: document,
    });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, "document", previous);
      else Reflect.deleteProperty(globalThis, "document");
    });
    let app: App | undefined;
    t.mock.method(App.prototype, "connect", async function (this: App) {
      app = this;
    });
    t.mock.method(App.prototype, "close", async () => {});
    const references: unknown[] = [];
    t.mock.method(App.prototype, "callServerTool", async (input: unknown) => {
      references.push(input);
      return { content: [], isError: outcome === "bind-failure" };
    });
    const secretRef = randomUUID();
    const delivered = Promise.withResolvers<Response>();
    let requests = 0;
    t.mock.method(
      globalThis,
      "fetch",
      (input: string | URL | Request, init?: RequestInit) => {
        requests++;
        assert.equal(
          String(input),
          "https://broker.example/ceremony/private-collection",
        );
        assert.equal(init?.redirect, "error");
        assert.equal(init?.credentials, "omit");
        assert.equal(init?.referrerPolicy, "no-referrer");
        assert.deepEqual(JSON.parse(String(init?.body)), {
          token: "synthetic-secret",
        });
        return delivered.promise;
      },
    );
    const root = document.querySelector("main")!;
    await assert.rejects(mountPrivateCollector(root, "http://broker.example"));
    const unmount = await mountPrivateCollector(root, "https://broker.example");
    assert.ok(app);
    const collection = {
      handle: randomUUID(),
      instanceId: randomUUID(),
      revision: 1,
      endpoint: "https://broker.example/ceremony/private-collection",
      fields: [
        { name: "token", label: "Token", type: "password", required: true },
      ],
    };
    app.ontoolresult?.({
      content: [],
      _meta: {
        collection: { ...collection, endpoint: "https://evil.example/collect" },
      },
    });
    assert.match(root.textContent ?? "", /Untrusted/);
    app.ontoolresult?.({ content: [], _meta: { collection: {} } });
    assert.equal(root.querySelector("form"), null);
    app.ontoolresult?.({ content: [], _meta: { collection } });
    const input = root.querySelector("input")!;
    assert.equal(input.type, "password");
    input.value = "synthetic-secret";
    const form = root.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.equal(requests, 1);
    assert.equal(input.value, "");
    delivered.resolve(
      outcome === "provider-failure"
        ? new Response("private-provider-error", { status: 503 })
        : Response.json(
            outcome === "malformed-response"
              ? { secretRef: "invalid" }
              : { secretRef },
          ),
    );
    for (let i = 0; i < 20 && root.querySelector("form"); i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(root.querySelector("form"), null);
    assert.doesNotMatch(JSON.stringify(references), /synthetic-secret/);
    assert.doesNotMatch(
      root.textContent ?? "",
      /synthetic-secret|private-provider-error/,
    );
    if (outcome === "success" || outcome === "bind-failure")
      assert.deepEqual(references, [
        {
          name: "ceremony_bind_private",
          arguments: {
            instanceId: collection.instanceId,
            revision: 1,
            secretRef,
          },
        },
      ]);
    else assert.deepEqual(references, []);
    assert.match(
      root.textContent ?? "",
      outcome === "success" ? /Private input submitted/ : /failed/,
    );
    assert.ok(app.onteardown);
    // The collector teardown deliberately does not use the SDK request context.
    await Reflect.apply(app.onteardown, app, [{}, undefined]);
    assert.equal(root.childNodes.length, 0);
    unmount();
  });
