import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createConnectorClient } from "../../../src/core/connectors/client.js";
import { ConnectorConnection } from "../../../src/react/connector-connection.js";
import {
  blockedDefinition,
  createConnectorFixture,
  type ConnectorFixture,
} from "./fixture.js";
import { mount, type Mounted } from "./render.js";

/*
 * The connection surface, driven through its own controls against the loopback
 * double. The assertions are deliberately about two things: what the server was
 * asked to do, and what a person is told. Between those two there is nothing
 * this component is allowed to decide on its own — least of all whether
 * something is connected.
 */

const entryFor = (fixture: ConnectorFixture, id: string) => {
  const entry = fixture.entries.find((item) => item.id === id);
  assert.ok(entry, `fixture has no entry ${id}`);
  return entry;
};
const definitionFor = (fixture: ConnectorFixture, ref: string) => {
  const found = fixture.definitions.find((item) => item.definitionRef === ref);
  assert.ok(found);
  return found;
};

async function open(
  fixture: ConnectorFixture,
  overrides: Record<string, unknown> = {},
  mountOptions: Parameters<typeof mount>[1] = {},
) {
  const client = createConnectorClient({
    fetch: fixture.fetch,
    online: () => mountOptions.onLine !== false,
  });
  return mount(
    createElement(ConnectorConnection, {
      client,
      entry: entryFor(fixture, "github-app"),
      definition: definitionFor(fixture, "definition:github-app"),
      bindings: fixture.bindings,
      viewer: { capabilities: ["executor"], ownerKinds: ["user"] },
      pollIntervalMs: 20,
      autoFocus: false,
      openWindow: () => ({ closed: false }) as unknown as Window,
      ...overrides,
    } as never),
    mountOptions,
  );
}

const lifecycle = (view: Mounted) =>
  view.query("[data-connector-connection]")?.getAttribute("data-lifecycle");

test("every drawer control becomes an input to the connect command", async () => {
  const fixture = createConnectorFixture();
  const view = await open(fixture);
  try {
    await view.fill("#connector-profile", "oauth");
    await view.fill("#connector-target", "octocat");
    await view.fill("#connector-interruption", "none");
    // The interruption budget is a constraint the server reports back on, not
    // an instruction to find another way in.
    assert.match(view.text, /constraint, not a bypass/);
    await view.click("Connect GitHub (native app)");
    const sent = fixture.requests.find((item) => item.path === "/connections");
    assert.ok(sent, "no connect command was sent");
    assert.deepEqual(sent.body, {
      bindingRef: "binding:github-app",
      ownerKind: "user",
      intent: {
        profileId: "oauth",
        requestedPermissions: ["read:user", "repo"],
        target: { kind: "github", id: "octocat" },
        accountSwitch: false,
        interruption: "none",
      },
    });
    assert.equal(lifecycle(view), "human-required");
    // "none" ended in a person being needed, which is what the copy promised.
    assert.match(view.text, /interruption\.not\.permitted/);
  } finally {
    await view.close();
  }
});

test("AC-UX-04: no control claims to enable a capability or to skip verification", async () => {
  const fixture = createConnectorFixture();
  const view = await open(fixture);
  try {
    const report = view.query(".connector-report");
    assert.ok(report);
    assert.equal(report.querySelectorAll("input").length, 0);
    assert.equal(report.querySelectorAll("button").length, 0);
    assert.match(view.text, /These are reports, not switches/);
    // Nothing that a person can switch mentions verification or key sharing:
    // only labels that actually wrap a control count as controls.
    const controlLabels = view
      .all("label")
      .filter((element) => element.querySelector("input, select, textarea"))
      .map((element) => element.textContent ?? "")
      .join(" ");
    assert.doesNotMatch(controlLabels, /verif/i);
    assert.doesNotMatch(controlLabels, /shared key|per-user key/i);
    // Custody is stated, and stated as something the server decides.
    assert.match(view.text, /cannot be changed from here/);
  } finally {
    await view.close();
  }
});

test("an organization connection is offered only when policy allows it", async () => {
  const fixture = createConnectorFixture();
  const view = await open(fixture);
  try {
    const organization = view
      .all("input[name='connector-owner']")
      .at(1) as unknown as { disabled: boolean };
    assert.equal(organization.disabled, true);
    assert.match(view.text, /requires administrator policy/);
  } finally {
    await view.close();
  }
  const permissive = createConnectorFixture();
  const allowed = await open(permissive, {
    viewer: {
      capabilities: ["executor"],
      ownerKinds: ["user", "organization"],
    },
  });
  try {
    const organization = allowed
      .all("input[name='connector-owner']")
      .at(1) as unknown as { disabled: boolean };
    assert.equal(organization.disabled, false);
  } finally {
    await allowed.close();
  }
});

test("AC-UX-04: a blocked popup continues in the same window", async () => {
  const fixture = createConnectorFixture();
  const view = await open(fixture, { openWindow: () => null });
  try {
    await view.click("Connect GitHub (native app)");
    assert.ok(view.query("[data-connector-popup-blocked]"));
    const link = view.query("[data-connector-continue]");
    assert.equal(link?.textContent, "Continue in this window");
    // A same-window continuation is an ordinary navigation to the server's
    // presentation URL, not a second popup attempt.
    assert.equal(link?.getAttribute("target"), null);
    assert.match(
      link?.getAttribute("href") ?? "",
      /^https:\/\/app\.test\/authorize/,
    );
  } finally {
    await view.close();
  }
});

test("AC-AUTH-15: finishing at the provider only asks the server", async () => {
  const fixture = createConnectorFixture();
  const view = await open(fixture);
  try {
    await view.click("Connect GitHub (native app)");
    await view.click("I finished in the provider — check status");
    assert.equal(lifecycle(view), "human-required");
    assert.doesNotMatch(view.text, /Verified target/);
    assert.match(view.text, /Only the server's answer changes the status/);

    fixture.approve();
    await view.waitFor(() => lifecycle(view) === "active");
    assert.match(view.text, /Connected/);
    assert.match(view.text, /octocat/);
    assert.match(view.text, /Read access was demonstrated/);
  } finally {
    await view.close();
  }
});

test("offline refuses to connect and says nothing is queued", async () => {
  const fixture = createConnectorFixture();
  const view = await open(fixture, {}, { onLine: false });
  try {
    assert.ok(view.query("[data-connector-offline]"));
    const connect = view.button("Connect GitHub (native app)") as unknown as {
      disabled: boolean;
    };
    assert.equal(connect.disabled, true);
    assert.match(view.text, /nothing is queued/);
    assert.equal(
      fixture.requests.some((item) => item.path === "/connections"),
      false,
    );
  } finally {
    await view.close();
  }
});

test("a description that never arrived is unknown, not clean", async () => {
  const fixture = createConnectorFixture();
  const client = createConnectorClient({ fetch: fixture.fetch });
  const props = {
    client,
    entry: entryFor(fixture, "github-app"),
    bindings: fixture.bindings,
    viewer: { capabilities: ["executor"], ownerKinds: ["user"] },
    pollIntervalMs: 20,
    autoFocus: false,
    openWindow: () => ({ closed: false }) as unknown as Window,
  };
  const connect = (view: Mounted) =>
    view.button("Connect GitHub (native app)") as unknown as {
      disabled: boolean;
    };
  // A description whose security requirement cannot be executed refuses the
  // connection and names the issue that refused it.
  const view = await mount(
    createElement(ConnectorConnection, {
      ...props,
      definition: blockedDefinition(),
    } as never),
  );
  try {
    assert.ok(view.query("[data-connector-blockers]"));
    assert.match(view.text, /cannot be authorized as imported/);
    assert.equal(connect(view).disabled, true);

    // The same connector with no description at all knows none of that. The
    // blocking list is empty because nothing was read, which is not the same
    // answer as nothing being wrong, so connecting stays refused.
    await view.render(createElement(ConnectorConnection, props as never));
    assert.equal(view.query("[data-connector-blockers]"), null);
    assert.equal(connect(view).disabled, true);
    assert.ok(view.query("[data-connector-definition-pending]"));
    assert.equal(
      fixture.requests.some((item) => item.path === "/connections"),
      false,
    );

    // A read the host reported as failed says so, in the host's own words, and
    // still refuses.
    await view.render(
      createElement(ConnectorConnection, {
        ...props,
        definitionError: "The description store is unavailable.",
      } as never),
    );
    const unread = view.query("[data-connector-definition-unread]");
    assert.match(unread?.textContent ?? "", /could not be read/);
    assert.match(unread?.textContent ?? "", /store is unavailable/);
    assert.equal(connect(view).disabled, true);

    // And the description in hand, with nothing blocking, connects as before.
    await view.render(
      createElement(ConnectorConnection, {
        ...props,
        definition: definitionFor(fixture, "definition:github-app"),
      } as never),
    );
    assert.equal(view.query("[data-connector-definition-unread]"), null);
    assert.equal(view.query("[data-connector-definition-pending]"), null);
    assert.equal(connect(view).disabled, false);
  } finally {
    await view.close();
  }
});

test("an expired session asks for sign-in and shows nothing stale", async () => {
  const fixture = createConnectorFixture({ expireSessionAfter: 1 });
  const view = await open(fixture);
  try {
    await view.click("Connect GitHub (native app)");
    await view.waitFor(
      () =>
        lifecycle(view) === "active" || view.text.includes("session expired"),
    );
    assert.match(view.text, /Your session expired/);
    assert.doesNotMatch(view.text, /Verified target/);
    assert.ok(view.button("Sign in"));
  } finally {
    await view.close();
  }
});

test("the sign-in a dead session offers actually starts one", async () => {
  const fixture = createConnectorFixture({ expireSessionAfter: 0 });
  const asked: string[] = [];
  const view = await open(
    fixture,
    {},
    {
      // No host handler is passed, which is the shipped case: the panel uses
      // this application's own sign-in command.
      fetch: (async (input: RequestInfo | URL) => {
        asked.push(String(input));
        return new Response(
          JSON.stringify({ authorizationUrl: "https://id.test/authorize?x=1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    },
  );
  try {
    await view.click("Connect GitHub (native app)");
    await view.waitFor(() => view.text.includes("Your session expired"));
    const visited: string[] = [];
    (globalThis.location as unknown as { assign(url: string): void }).assign = (
      url,
    ) => visited.push(url);
    await view.click("Sign in");
    await view.waitFor(() => visited.length > 0);
    assert.deepEqual(asked, ["/api/auth/login"]);
    assert.deepEqual(visited, ["https://id.test/authorize?x=1"]);
    // The panel is not cleared by a button that did nothing else: what
    // replaces it is the page the browser is on its way to.
    assert.match(view.text, /Your session expired/);
  } finally {
    await view.close();
  }
});

test("a refused reconnect closes the window it opened", async () => {
  const fixture = createConnectorFixture({ requireAccountSwitch: true });
  const opened: Array<{ closed: boolean }> = [];
  const view = await open(fixture, {
    openWindow: () => {
      const handle = {
        closed: false,
        close() {
          handle.closed = true;
        },
        location: { replace() {} },
      };
      opened.push(handle);
      return handle as unknown as Window;
    },
  });
  try {
    await view.click("Connect GitHub (native app)");
    fixture.approve();
    await view.waitFor(() => lifecycle(view) === "active");
    await view.click("Reconnect");
    await view.click("Start reconnect");
    await view.waitFor(() => view.text.includes("Confirm the account change"));
    // The server refused, so the window opened on the click has nowhere to go
    // and is not left over the page for somebody to close by hand. The window
    // the provider is still using is untouched.
    assert.equal(opened.length, 2);
    assert.equal(opened[1]?.closed, true);
    assert.equal(opened[0]?.closed, false);
  } finally {
    await view.close();
  }
});

test("a private value is collected separately and only a reference is submitted", async () => {
  const fixture = createConnectorFixture();
  const client = createConnectorClient({ fetch: fixture.fetch });
  const view = await mount(
    createElement(ConnectorConnection, {
      client,
      entry: entryFor(fixture, "petstore-api-key"),
      definition: definitionFor(fixture, "definition:petstore"),
      bindings: fixture.bindings,
      pollIntervalMs: 20,
      autoFocus: false,
    } as never),
  );
  try {
    await view.click("Connect Petstore");
    assert.equal(lifecycle(view), "human-required");
    // The dependent list is empty until the field it depends on has a value.
    assert.match(view.text, /Choose region first/);
    await view.fill("#connector-field-region", "us");
    await view.waitFor(() =>
      (view.query("#connector-field-project")?.textContent ?? "").includes(
        "US main",
      ),
    );
    const lookup = fixture.requests.find((item) =>
      item.path.endsWith("/invoke"),
    );
    assert.deepEqual((lookup?.body as { input: unknown }).input, {
      region: "us",
    });

    await view.fill("#connector-field-project", "us-main");
    await view.fill("#connector-field-apiKey", "CANARY-PETSTORE-KEY");
    await view.submit(".connector-handoff-form");
    await view.waitFor(() => lifecycle(view) === "active");

    const collect = fixture.requests.filter((item) =>
      item.path.endsWith("/collect"),
    );
    assert.equal(collect.length, 1);
    assert.deepEqual(collect[0]!.body, {
      values: { apiKey: "CANARY-PETSTORE-KEY" },
    });
    const elsewhere = fixture.requests
      .filter((item) => !item.path.endsWith("/collect"))
      .map((item) => JSON.stringify(item.body ?? null))
      .join("\n");
    assert.doesNotMatch(elsewhere, /CANARY-PETSTORE-KEY/);
    const submitted = fixture.requests.find((item) =>
      item.path.includes("/handoffs/"),
    );
    assert.match(JSON.stringify(submitted?.body), /"secretRef":"secret:\d+"/);
    // Nothing keeps the secret afterwards: not the form, not the page text.
    assert.doesNotMatch(view.text, /CANARY-PETSTORE-KEY/);
    assert.equal(
      view
        .all("input")
        .some(
          (element) =>
            (element as unknown as { value?: string }).value ===
            "CANARY-PETSTORE-KEY",
        ),
      false,
    );
  } finally {
    await view.close();
  }
});

test("reconnect requires explicit account-switch intent", async () => {
  const fixture = createConnectorFixture({ requireAccountSwitch: true });
  const view = await open(fixture);
  try {
    await view.click("Connect GitHub (native app)");
    fixture.approve();
    await view.waitFor(() => lifecycle(view) === "active");
    await view.click("Reconnect");
    assert.ok(view.query("[data-connector-reconnect]"));
    await view.click("Start reconnect");
    assert.match(view.text, /different account/);
    assert.equal(lifecycle(view), "active");

    const checkbox = view.query(
      "[data-connector-reconnect] input[type='checkbox']",
    ) as unknown as { checked: boolean } | null;
    assert.ok(checkbox);
    // A checkbox reports its state on the click, so the state comes first.
    checkbox.checked = true;
    await view.clickElement(checkbox as never);
    await view.click("Start reconnect");
    await view.waitFor(() => lifecycle(view) === "human-required");
    const reconnects = fixture.requests.filter((item) =>
      item.path.endsWith("/reconnect"),
    );
    assert.equal(reconnects.length, 2);
    assert.deepEqual(reconnects[0]!.body, {
      expectedRevision: 2,
      accountSwitch: false,
    });
    assert.deepEqual(reconnects[1]!.body, {
      expectedRevision: 2,
      accountSwitch: true,
    });
  } finally {
    await view.close();
  }
});

test("disconnect explains each scope and reports what actually happened", async () => {
  const fixture = createConnectorFixture();
  const view = await open(fixture);
  try {
    await view.click("Connect GitHub (native app)");
    fixture.approve();
    await view.waitFor(() => lifecycle(view) === "active");
    await view.click("Disconnect…");
    const panel = view.query("[data-connector-disconnect]");
    assert.ok(panel);
    const text = panel.textContent ?? "";
    assert.match(text, /Unlink here only/);
    assert.match(text, /keeps existing until you revoke it there/);
    assert.match(text, /delete at the broker/);
    assert.match(text, /revoke at the provider/);

    await view.click("Unlink here only");
    await view.waitFor(() => lifecycle(view) === "locally-disconnected");
    const result = view.query("[data-connector-disconnect-result]");
    assert.match(result?.textContent ?? "", /Not attempted/);
    assert.match(view.text, /was not revoked/);
    const shared = view.query("[data-connector-shared-with]");
    assert.match(shared?.textContent ?? "", /connection:shared-team/);
    const sent = fixture.requests.find((item) =>
      item.path.endsWith("/disconnect"),
    );
    assert.deepEqual(sent?.body, { expectedRevision: 2, scope: "local" });
  } finally {
    await view.close();
  }
});

test("a read operation proves the connection works and shows its classification", async () => {
  const fixture = createConnectorFixture();
  const view = await open(fixture, {
    readOperations: [
      {
        operationRef: "operation:listRepositories",
        label: "List repositories",
      },
    ],
  });
  try {
    await view.click("Connect GitHub (native app)");
    fixture.approve();
    await view.waitFor(() => lifecycle(view) === "active");
    await view.click("List repositories");
    await view.waitFor(() => view.text.includes("Read succeeded"));
    assert.match(view.text, /octocat\/hello-world/);
    assert.match(view.text, /\(read, public\)/);
  } finally {
    await view.close();
  }
});
