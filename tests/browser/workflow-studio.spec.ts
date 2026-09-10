import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { AxeBuilder } from "@axe-core/playwright";
import {
  newAuthoredMethod,
  newConnectorProject,
  parseConnectorDraft,
  parseConnectorProject,
} from "../../src/core/connector-authoring.js";
import { defaultTemplate } from "../../src/core/schema.js";

function sampleProject() {
  const project = newConnectorProject();
  project.manifest.id = "acme";
  project.manifest.name = "Acme";
  project.manifest.description = "Connect your Acme workspace.";
  project.workflows[0]!.sourceDescriptions[0]!.url =
    "https://api.example.com/openapi.json";
  const method = newAuthoredMethod("oauth-code", "method-1");
  method.label = "Browser authorization (OAuth)";
  method.contract!.completion.verifier = "acme.verify-access";
  project.manifest.methods = [method];
  project.workflows[0]!.workflows = [
    {
      workflowId: "method-1",
      summary: "Connect Acme",
      steps: [
        {
          stepId: "authorize-user",
          description: "Authorize the user at the provider",
          operationId: "provider.authorize-user",
        },
        {
          stepId: "verify-access",
          description: "Verify provider access",
          operationId: "provider.verify-access",
        },
      ],
    },
  ];
  const template = defaultTemplate("oauth-code");
  template.screens.intro = template.screens.intro.replace(
    "Connect your account",
    "Your authored welcome",
  );
  project.templates = [template];
  return project;
}

test("Studio has no provider kickoff form and does not run Connect", async ({
  page,
}, info) => {
  const effects: string[] = [];
  page.on("request", (request) => {
    if (
      /\/api\/(live\/)?ceremonies|\/api\/environment|\/api\/workflows/.test(
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
    page.getByRole("button", { name: "Create connector", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Build from this provider", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Connector name", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByLabel("Connector ID", { exact: true })).toHaveCount(0);
  await expect(
    page.getByLabel("Provider OpenAPI document", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Ask the authoring agent", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect GitHub", exact: true }),
  ).toHaveCount(0);
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
});

test("Studio reviews an agent draft without ceremony editing forms", async ({
  page,
}) => {
  const project = sampleProject();
  await page.goto("/?section=studio");
  await page.getByLabel("Open connector project").setInputFiles({
    name: "project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(
    page.getByText("Definition valid. Ready to export for host integration."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add method", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Compose selected ceremonies" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Completion verifier")).toHaveCount(0);
  await page
    .getByText("Customize ceremony presentation", { exact: true })
    .click();
  await expect(page.getByLabel("Template source · JSON / OpenUI")).toHaveValue(
    /Your authored welcome/,
  );
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save connector project" }).click();
  const downloaded = await pending;
  const result = parseConnectorProject(
    await readFile((await downloaded.path())!, "utf8"),
  );
  expect(result.manifest.id).toBe("acme");
  expect(result.templates[0]!.screens.intro).toMatch(/Your authored welcome/);
});

test("incomplete drafts cannot export a completed connector", async ({
  page,
}) => {
  const project = newConnectorProject();
  await page.goto("/?section=studio");
  await page.getByLabel("Open connector project").setInputFiles({
    name: "draft.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.getByRole("alert")).toContainText(
    "Unresolved definition issues",
  );
  await expect(
    page.getByRole("button", { name: "Export manifest" }),
  ).toBeDisabled();
  const saved = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save connector project" }).click();
  const file = await saved;
  expect(file.suggestedFilename()).toBe("untitled.connector.json");
  parseConnectorDraft(await readFile((await file.path())!, "utf8"));
  await expect(page.getByLabel("Connector name", { exact: true })).toHaveCount(
    0,
  );
});
