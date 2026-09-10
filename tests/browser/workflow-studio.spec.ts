import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { AxeBuilder } from "@axe-core/playwright";
import { parseConnectorProject } from "../../src/core/connector-authoring.js";
import {
  newConnectorProject,
  newAuthoredMethod,
} from "../../src/core/connector-authoring.js";
import { defaultTemplate } from "../../src/core/schema.js";

test("Studio authors a new connector without running Connect or reading Environment", async ({
  page,
}, info) => {
  const effects: string[] = [];
  page.on("request", (request) => {
    if (
      /\/api\/(live\/)?ceremonies|\/api\/v1\/teaching|\/api\/environment|\/api\/workflows/.test(
        request.url(),
      )
    )
      effects.push(request.url());
  });
  await page.goto("/?section=studio&connector=github");
  await expect(
    page.getByRole("heading", { name: "Workflow studio", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect GitHub", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Create from demonstration",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Create connector", exact: true })
    .click();
  await expect(page.getByLabel("Connector name", { exact: true })).toHaveValue(
    "",
  );
  await page
    .getByLabel("Connector name", { exact: true })
    .fill("Acme Workspace");
  await page.getByLabel("Connector ID", { exact: true }).fill("acme-workspace");
  await page
    .getByLabel("What does this connector do?")
    .fill("Connect your Acme workspace.");
  await page
    .getByLabel("Provider OpenAPI document")
    .fill("https://api.example.com/openapi.json");
  await page.getByRole("button", { name: "Design ceremonies" }).click();
  await page.getByRole("button", { name: "Add method", exact: true }).click();
  await page.getByLabel("Completion verifier").fill("acme.verify-access");
  await page
    .getByLabel("SDK operation ID")
    .first()
    .fill("accounts/get-current");
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page
    .getByLabel("What happens?")
    .last()
    .fill("Check workspace membership");
  await page.getByLabel("SDK operation ID").last().fill("memberships/check");
  await page
    .getByRole("button", { name: "Move up", exact: true })
    .last()
    .click();
  await page
    .getByText("Prerequisites and human fallback", { exact: true })
    .click();
  await page
    .getByLabel("Who should help when human participation is required?")
    .selectOption("authorized-owner");
  if (process.env.CEREMONY_CAPTURE_REVIEW === "1") {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: info.outputPath(`studio-editor-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.getByRole("button", { name: "Review connector" }).click();
  await expect(
    page.getByText("Definition valid. Ready to export for host integration."),
  ).toBeVisible();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save connector project" }).click();
  const download = await pending;
  const bytes = await readFile((await download.path())!);
  const project = parseConnectorProject(bytes.toString());
  expect(project.manifest.id).toBe("acme-workspace");
  expect(project.manifest.methods[0]!.contract.handoff.recipient).toBe(
    "authorized-owner",
  );
  expect(
    project.workflows[0]!.workflows[0]!.steps.map((step) => step.operationId),
  ).toEqual([
    "accounts/get-current",
    "provider.authorize-user",
    "memberships/check",
    "provider.verify-access",
  ]);
  expect(effects).toEqual([]);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    if (process.env.CEREMONY_CAPTURE_REVIEW === "1")
      await page.screenshot({
        path: info.outputPath(`studio-${width}.png`),
        fullPage: true,
      });
  }
  await page.getByRole("button", { name: "1. Connector", exact: true }).click();
  await page.getByLabel("Open connector project").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"published":true}'),
  });
  await expect(
    page.getByRole("status").filter({ hasText: "Could not open" }),
  ).toBeVisible();
  await expect(page.getByLabel("Connector name", { exact: true })).toHaveValue(
    "Acme Workspace",
  );
  await page.getByLabel("Open connector project").setInputFiles({
    name: "connector.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  await expect(
    page.getByRole("status").filter({ hasText: "Project opened" }),
  ).toBeVisible();
  await page
    .getByLabel("Connector name", { exact: true })
    .fill("Unfinished changes");
  await page.getByLabel("Open connector project").setInputFiles({
    name: "connector.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByLabel("Connector name", { exact: true })).toHaveValue(
    "Unfinished changes",
  );
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Connect GitHub", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Workflow studio", exact: true })
    .click();
  await expect(page.getByLabel("Connector name", { exact: true })).toHaveValue(
    "Unfinished changes",
  );
});

test("Studio drafts a provider from generic templates and composes ceremonies", async ({
  page,
}) => {
  await page.goto("/?section=studio");
  await page.getByLabel("Provider to build a ceremony for").fill("Jira");
  await page
    .getByRole("button", { name: "Build from this provider", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Drafted Jira" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Browser authorization (OAuth)",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("What happens?").first()).toHaveValue(
    "Prepare the shared OAuth app when the host has none",
  );
  await page.getByLabel("Authentication method").selectOption("device");
  await page.getByRole("button", { name: "Add method", exact: true }).click();
  await page.getByLabel("Include in composition").first().check();
  await page.getByLabel("Include in composition").nth(1).check();
  await page
    .getByRole("button", { name: "Compose selected ceremonies", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Composed ceremony", exact: true }),
  ).toBeVisible();
  await page.getByText("Prerequisites and human fallback").last().click();
  await expect(page.getByLabel("Prerequisite ID").nth(1)).toHaveValue(
    "method-1",
  );
  await expect(page.getByLabel("Prerequisite ID").nth(2)).toHaveValue(
    "method-2",
  );
});

test("imported document names and saved presentations remain editable when methods change", async ({
  page,
}) => {
  const project = newConnectorProject();
  project.manifest.id = "acme";
  project.manifest.name = "Acme";
  project.workflows = ["first-api", "second-api"].map((document, i) => ({
    document,
    arazzo: "1.0.1",
    info: { title: "Acme API", version: "1.0.0" },
    sourceDescriptions: [
      {
        name: "provider",
        type: "openapi",
        url: "https://example.com/openapi.json",
      },
    ],
    workflows: [
      {
        workflowId: `method-${i + 1}`,
        summary: "Authorize",
        steps: [
          {
            stepId: "verify",
            description: "Verify",
            operationId: "accounts/get",
          },
        ],
      },
    ],
  }));
  project.manifest.methods = project.workflows.map((doc, i) => {
    const method = newAuthoredMethod("oauth-code", `method-${i + 1}`);
    method.contract!.completion.verifier = "acme.verify";
    method.contract!.workflows[0]!.document = doc.document;
    return method;
  });
  const template = defaultTemplate("oauth-code");
  template.screens.intro = template.screens.intro.replace(
    "Connect your account",
    "Your authored welcome",
  );
  project.templates = [template];
  await page.goto("/?section=studio");
  await page.getByLabel("Open connector project").setInputFiles({
    name: "project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page.getByRole("button", { name: "3. Review & export" }).click();
  await page
    .getByText("Customize ceremony presentation", { exact: true })
    .click();
  await expect(page.getByLabel("Template source · JSON / OpenUI")).toHaveValue(
    /Your authored welcome/,
  );
  await page.getByRole("button", { name: "2. Ceremonies" }).click();
  await page
    .getByLabel("Authentication method", { exact: true })
    .selectOption("api-key");
  await page.getByRole("button", { name: "Add method", exact: true }).click();
  await page.getByLabel("Completion verifier").last().fill("acme.verify-key");
  await page.getByLabel("SDK operation ID").last().fill("keys/verify");
  await page
    .getByRole("button", { name: "Remove method", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Remove method", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Review connector" }).click();
  await expect(
    page.getByText("Definition valid. Ready to export for host integration."),
  ).toBeVisible();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save connector project" }).click();
  const downloaded = await pending;
  const result = parseConnectorProject(
    await readFile((await downloaded.path())!, "utf8"),
  );
  expect(result.workflows.map((doc) => doc.document)).toEqual(["first-api"]);
  expect(result.manifest.methods[0]!.contract.workflows[0]!.document).toBe(
    "first-api",
  );
  expect(result.templates.map((template) => template.id)).toEqual(["api-key"]);
  expect(result.templates[0]!.kind).toBe("api-key");
});

test("incomplete ceremonies stay editable without a false validation pass", async ({
  page,
}) => {
  await page.goto("/?section=studio");
  await page.getByRole("button", { name: "Create connector" }).click();
  await page.getByRole("button", { name: "3. Review & export" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Resolve these definition issues",
  );
  await expect(
    page.getByRole("button", { name: "Export manifest" }),
  ).toBeDisabled();
  const saved = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save connector project" }).click();
  const file = await saved;
  expect(file.suggestedFilename()).toBe("untitled.connector.json");
  const bytes = await readFile((await file.path())!);
  await page.getByRole("button", { name: "Adjust definition" }).click();
  await page.getByLabel("Open connector project").setInputFiles({
    name: "draft.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  await expect(
    page.getByRole("status").filter({ hasText: "Project opened" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Connector name", { exact: true }),
  ).toBeVisible();
});
