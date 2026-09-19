import { test, expect, type Page } from "../fixtures/browser-test.js";
import { AxeBuilder } from "@axe-core/playwright";

/**
 * The Add Connection wizard against the server, not against itself.
 *
 * The defect these cover is specific: a wizard that collected a mode, a family,
 * a key scope, an interruption budget and an identity preference, rendered all
 * of it as a settled summary, and sent none of it anywhere. So every assertion
 * here is on the *request body* the browser actually put on the wire, or on a
 * value that could only have come back from the server — never on which radio
 * is selected. A screenshot of a checked box proves nothing about what runs.
 */

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  // Audit product UI, not the separately installed development editor.
  await page.route(/^http:\/\/localhost:\d+\/live\.js(?:\?|$)/, (route) =>
    route.abort(),
  );
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

const loginRoute = "**/api/v1/teaching/tools/browser-login";
const backendsRoute = "**/api/v1/teaching/tools/browser-backends";

/** A descriptor in the exact shape `browser-backends` publishes. */
function managedBackend(engine: "chromium" | "firefox" | "webkit") {
  return {
    backendId: `managed-${engine}`,
    engine,
    ownership: "managed" as const,
    engineVersion: "131.0.6778.85",
    capabilities: {
      retainedSession: true,
      backendHeldElements: true,
      documentBinding: true,
      popupBinding: true,
      frameBinding: true,
      // False on every real backend, which is why a plan that demands it is
      // refused rather than run under a name it does not deserve.
      strongEgressContainment: false,
      authenticatorHandoff: true,
      statePersistence: true,
      debugExposure: false,
    },
  };
}

async function serveBackends(
  page: Page,
  backends: ReturnType<typeof managedBackend>[],
  verificationRequired = false,
) {
  await page.route(backendsRoute, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ backends, verificationRequired }),
    }),
  );
}

type SentDraft = Record<string, unknown>;

/**
 * Stand in for the host's compiler and keep every body it was handed.
 *
 * The handler is given the `draft` argument exactly as it arrived, so a test
 * can answer differently for different configurations the way a real compiler
 * does — and so the bodies themselves are available to assert on afterwards.
 */
async function serveLogin(
  page: Page,
  reply: (
    draft: SentDraft,
    connectorId: string,
    index: number,
  ) => { status: number; body: unknown },
): Promise<SentDraft[]> {
  const sent: SentDraft[] = [];
  await page.route(loginRoute, async (route) => {
    const payload = route.request().postDataJSON() as {
      connectorId: string;
      draft: SentDraft;
    };
    sent.push(payload.draft);
    const answer = reply(payload.draft, payload.connectorId, sent.length - 1);
    await route.fulfill({
      status: answer.status,
      contentType: "application/json",
      body: JSON.stringify(answer.body),
    });
  });
  return sent;
}

/** Browse to the attended-browser row and open its drawer, as a person would. */
async function openBrowserLogin(page: Page) {
  await page.goto("/?mode=test");
  await page
    .getByRole("region", { name: "Bring your own" })
    .getByRole("button", { name: "Browser Login", exact: true })
    .click();
  const drawer = page.getByRole("dialog", { name: "Add Connection" });
  await expect(drawer.getByRole("region", { name: "Configure" })).toBeVisible();
  return drawer;
}

const digestOf = (index: number) => `${index}`.repeat(64).slice(0, 64);

test("QA-PR: two wizard configurations put two different plans on the wire", async ({
  page,
}) => {
  await serveBackends(page, [managedBackend("chromium")]);
  const sent = await serveLogin(page, (draft, connectorId, index) => ({
    status: 200,
    body: {
      status: "verified",
      runRef: `brun_${"0".repeat(32)}`,
      evidenceKind: "fixture-verified",
      // Canonical values, and deliberately not the ones that were asked for:
      // if the interface renders these, it is rendering the server's answer.
      plan: {
        digest: digestOf(index + 1),
        revision: 7,
        backendId: "managed-chromium",
        engine: "chromium",
        ownership: "managed",
        entryUrl: draft.entryUrl,
        navigationOrigins: draft.navigationOrigins,
        credentialRecipients: draft.credentialRecipients ?? {},
        account: draft.account,
        continuation: draft.continuation,
        trustMode: draft.trustMode,
        interactionRounds: 3,
        requireVerification: true,
        sessionTtlMs: 600_000,
      },
      connectorId,
    },
  }));

  const drawer = await openBrowserLogin(page);

  // ---- first configuration -------------------------------------------------
  await drawer.getByLabel("Entry origin").fill("https://first.example");
  await drawer.getByRole("button", { name: "Continue", exact: true }).click();
  await drawer.getByLabel("Interruption budget").selectOption("none");
  await drawer.getByLabel("Whose access this is").selectOption("personal");
  await drawer.getByRole("button", { name: "Continue", exact: true }).click();
  await drawer.getByRole("button", { name: /^Check/ }).click();
  await expect.poll(() => sent.length).toBe(1);

  const first = sent[0]!;
  expect(first.entryUrl).toBe("https://first.example");
  expect(first.navigationOrigins).toEqual(["https://first.example"]);
  // "Never interrupt anyone" is a number the compiler can enforce, not a label.
  expect(first.interactionRounds).toBe(0);
  // "Personal" means somebody has to choose; it never becomes "whatever is there".
  expect(first.account).toEqual({ kind: "require-selection" });
  // One page means one secret, and it may be typed at exactly one origin.
  expect(first.credentialRecipients).toEqual({
    "workspace-password": ["https://first.example"],
  });
  expect(first.continuation).toBe("dispose");
  expect(first.requireVerification).toBe(true);
  expect(first.verifierOrigin).toBe("https://first.example");
  expect(first.engine).toBe("chromium");
  expect(first.ownership).toBe("managed");

  const panel = drawer.getByRole("region", { name: "Effective configuration" });
  await expect(panel.locator('[data-plan="digest"]')).toHaveText(digestOf(1));
  await expect(panel.locator('[data-plan="revision"]')).toHaveText("7");
  // The wizard asked for none; the server said three. Three is what is shown.
  await expect(panel.locator('[data-plan="interactionRounds"]')).toHaveText(
    "3",
  );
  await expect(panel.locator('[data-plan="sessionTtlMs"]')).toHaveText(
    "10 minutes",
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // ---- second configuration ------------------------------------------------
  await drawer.getByRole("button", { name: "Configure" }).click();
  await drawer.getByLabel("Entry origin").fill("https://second.example");
  await drawer.getByLabel("Sign-in sequence").selectOption("identifier");
  await drawer.getByRole("button", { name: "Continue", exact: true }).click();
  await drawer
    .getByRole("checkbox", { name: /Agent-to-human handoff/ })
    .check();
  await drawer.getByLabel("Interruption budget").selectOption("at-most-one");
  await drawer.getByLabel("Whose access this is").selectOption("anonymous");
  await drawer.getByRole("button", { name: "Continue", exact: true }).click();
  // Editing the draft cleared the previous answer, which is the point: a
  // compiled plan describes the draft it was compiled from and nothing else.
  await expect(panel.locator('[data-plan="digest"]')).toHaveCount(0);
  await drawer.getByRole("button", { name: /^Check/ }).click();
  await expect.poll(() => sent.length).toBe(2);

  const second = sent[1]!;
  expect(second.entryUrl).toBe("https://second.example");
  // Two pages means the identifier is typed on one and the secret on the other,
  // and the plan has to admit both before either is typed anywhere.
  expect(second.credentialRecipients).toEqual({
    "workspace-identifier": ["https://second.example"],
    "workspace-password": ["https://second.example"],
  });
  expect(second.interactionRounds).toBe(1);
  expect(second.account).toEqual({ kind: "accept-existing" });
  // Handing the browser back to the person who owns the account is a different
  // continuation, and a session that outlives the call has a longer lifetime.
  expect(second.continuation).toBe("return-to-user");
  expect(second.sessionTtlMs).toBeGreaterThan(Number(first.sessionTtlMs));

  // The whole point: two configurations, two genuinely different requests.
  expect(second).not.toEqual(first);
  await expect(panel.locator('[data-plan="digest"]')).toHaveText(digestOf(2));
});

test("a configuration the server rejects shows the reason it named", async ({
  page,
}) => {
  // A host whose only browser cannot keep state between runs. That is not a
  // contrived fixture: `statePersistence` is false on every engine this
  // project registers, because nothing implements it.
  const limited = managedBackend("chromium");
  limited.capabilities.statePersistence = false;
  await serveBackends(page, [limited]);
  const sent = await serveLogin(page, (draft) =>
    (draft.required as Record<string, boolean> | undefined)?.statePersistence
      ? {
          status: 400,
          body: { error: "plan-rejected", reason: "unsupported-capability" },
        }
      : { status: 200, body: { status: "verified", runRef: "brun_x" } },
  );

  const drawer = await openBrowserLogin(page);
  await drawer.getByLabel("Entry origin").fill("https://refused.example");
  await drawer.getByRole("button", { name: "Continue", exact: true }).click();
  // Teaching is on by default for this row, and replaying a recorded sign-in
  // is what makes the plan ask for state to survive the run.
  await expect(
    drawer.getByRole("checkbox", { name: /Teach this connection/ }),
  ).toBeChecked();
  await drawer.getByRole("button", { name: "Continue", exact: true }).click();
  await drawer
    .getByRole("button", { name: "Check this configuration" })
    .click();
  await expect.poll(() => sent.length).toBe(1);
  // The capability reached the wire, which is why it could be refused. A
  // wizard that kept this to itself would have shown a plan that runs without
  // the thing the person asked for.
  expect(sent[0]!.required).toEqual({ statePersistence: true });

  const panel = drawer.getByRole("region", { name: "Effective configuration" });
  const alert = panel.getByRole("alert");
  await expect(alert).toContainText("unsupported-capability");
  await expect(alert).toContainText(
    "cannot enforce something this configuration requires",
  );
  // A rejected configuration is not quietly replaced by a plausible-looking one.
  await expect(panel.locator('[data-plan="digest"]')).toHaveCount(0);

  // The reason names the step that owns the field, and the step opens.
  await panel.getByRole("button", { name: "Fix in Customize" }).click();
  await expect(drawer.getByRole("region", { name: "Customize" })).toBeVisible();
});

test("a browser this host does not run is disabled with the reason on it", async ({
  page,
}) => {
  // One engine, managed only: exactly what `managedBackends()` would report on
  // a host with a single driver installed and no attached-browser companion.
  await serveBackends(page, [managedBackend("chromium")], true);
  const drawer = await openBrowserLogin(page);

  const engines = drawer.getByRole("group", { name: "Browser engine" });
  await expect(engines.getByRole("radio", { name: /Chromium/ })).toBeEnabled();
  const firefox = engines.getByRole("radio", { name: /Firefox/ });
  await expect(firefox).toBeDisabled();
  await expect(firefox).not.toBeChecked();
  await expect(engines.getByRole("radio", { name: /WebKit/ })).toBeDisabled();
  await expect(
    engines.getByText("No backend for this engine is registered on this host."),
  ).toHaveCount(2);
  await expect(
    drawer
      .getByRole("group", { name: "Whose browser" })
      .getByRole("radio", { name: /My own browser/ }),
  ).toBeDisabled();
  // Honest about what the engine that *is* here cannot enforce.
  await expect(
    drawer.getByText(/cannot enforce: strongEgressContainment/),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // A host that will not compile an unverified plan says so where the
  // configuration is made, rather than accepting it and refusing a step later.
  //
  // It is stated, not offered. Whether a connection proves real access is
  // settled by the connector's manifest and, above that, by this workspace -
  // so a checkbox here would be a control that changes nothing, which is the
  // defect the whole drawer was rebuilt to remove. What a person is owed is
  // the fact, in the place where they would otherwise have looked for the
  // switch.
  await expect(
    drawer.getByText("This workspace refuses a plan that turns verification"),
  ).toBeVisible();

  // Keyboard only, and the drawer gives the keyboard back where it found it.
  const card = page
    .getByRole("region", { name: "Bring your own" })
    .getByRole("button", { name: "Browser Login", exact: true });
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(card).toBeFocused();
});

test("the wizard posts its configuration to the shared browser-login tool", async ({
  page,
}) => {
  // No interception at all. Whatever this workspace answers — a compiled plan,
  // a refusal, or "there is no browser executor here" — the interface has to
  // report that answer rather than keep describing the draft.
  const posted: { url: string; body: unknown }[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/tools/browser-login"))
      posted.push({ url: request.url(), body: request.postDataJSON() });
  });

  const drawer = await openBrowserLogin(page);
  await drawer.getByLabel("Entry origin").fill("https://live.example");
  await drawer.getByRole("button", { name: "Continue", exact: true }).click();
  await drawer.getByRole("button", { name: "Continue", exact: true }).click();
  await drawer
    .getByRole("button", { name: "Check this configuration" })
    .click();

  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0]!.url).toContain("/api/v1/teaching/tools/browser-login");
  const payload = posted[0]!.body as {
    connectorId: string;
    draft: Record<string, unknown>;
  };
  expect(payload.connectorId).toBe("custom-browser-login");
  expect(payload.draft.entryUrl).toBe("https://live.example");
  expect(payload.draft.requireVerification).toBe(true);

  const panel = drawer.getByRole("region", { name: "Effective configuration" });
  // Whatever came back, the "nothing has been sent" state is over and the
  // panel is now reporting the server rather than the draft.
  await expect(panel.getByText("Nothing has been sent yet")).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await panel.locator('[data-plan="status"]').count()) +
        (await panel.getByRole("alert").count()),
    )
    .toBeGreaterThan(0);
});
