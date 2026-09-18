import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyProviderProposal,
  attachGenericCeremony,
  connectorProjectSchema,
  exportConnectorFiles,
  newAuthoredMethod,
  newConnectorProject,
  parseConnectorProject,
} from "../../../src/core/connector-authoring.js";
import { flowKinds } from "../../../src/core/schema.js";
import { arazzoSchema, runArazzo } from "../../../src/server/arazzo.js";
import {
  exportArazzo,
  readArazzo,
  reviewArazzoImport,
} from "../../../src/server/connectors/formats/arazzo/index.js";
import { full110, storeWorkflow101 } from "../fixtures/arazzo/documents.js";

/*
 * WF-04: saved studio v1 projects keep validating exactly as before, and the
 * new import review and version-aware export report what a studio round trip
 * would lose instead of presenting unsupported constructs as editable.
 */

function studioProject() {
  const draft = newConnectorProject();
  draft.manifest.id = "acme";
  draft.manifest.name = "Acme";
  const method = newAuthoredMethod("oauth-code", "oauth");
  method.contract!.completion.verifier = "acme.verify-access";
  draft.manifest.methods = [method];
  draft.workflows[0]!.sourceDescriptions[0]!.url =
    "https://api.example.com/openapi.json";
  draft.workflows[0]!.workflows = [
    {
      workflowId: "oauth",
      summary: "Connect Acme",
      steps: [
        {
          stepId: "prepare",
          description: "Prepare request",
          operationId: "authorize/prepare",
        },
        {
          stepId: "verify",
          description: "Verify account",
          operationId: "accounts/get-current",
        },
      ],
    },
  ];
  return draft;
}

const lossCodes = (losses: ReadonlyArray<{ code: string }>) =>
  new Set(losses.map((loss) => loss.code));

test("AC-IMP-01 saved studio projects still validate and export unchanged", () => {
  const project = studioProject();
  assert.equal(connectorProjectSchema.safeParse(project).success, true);
  const saved = parseConnectorProject(JSON.stringify(project));
  assert.deepEqual(saved, project);
  const files = exportConnectorFiles(saved);
  // The bounded 1.0.1 executor still accepts the studio's own export.
  const document = arazzoSchema.parse(files.workflows[0]!.definition);
  assert.equal(document.arazzo, "1.0.1");

  // Every generated family still produces a project the studio schema accepts.
  for (const kind of flowKinds) {
    const draft = newConnectorProject();
    draft.manifest.id = "acme";
    draft.manifest.name = "Acme";
    draft.manifest.description = "Connect Acme.";
    draft.workflows[0]!.sourceDescriptions[0]!.url =
      "https://api.example.com/openapi.json";
    attachGenericCeremony(draft, kind, "Generated");
    assert.equal(connectorProjectSchema.safeParse(draft).success, true, kind);
    const generated = parseConnectorProject(JSON.stringify(draft));
    assert.equal(
      arazzoSchema.safeParse(
        exportConnectorFiles(generated).workflows[0]!.definition,
      ).success,
      true,
      kind,
    );
  }
  const proposal = newConnectorProject();
  proposal.workflows[0]!.sourceDescriptions[0]!.url =
    "https://api.example.com/openapi.json";
  applyProviderProposal(proposal, "GitHub");
  assert.equal(connectorProjectSchema.safeParse(proposal).success, true);
});

test("AC-IMP-01 a studio export reads, reviews as editable and re-exports byte-identically", async () => {
  const project = parseConnectorProject(JSON.stringify(studioProject()));
  const definition = exportConnectorFiles(project).workflows[0]!.definition;
  const review = reviewArazzoImport(definition);
  assert.deepEqual(
    review.read.issues.filter((issue) => issue.severity === "blocking"),
    [],
  );
  assert.equal(review.studio.editable, true);
  assert.deepEqual(review.studio.losses, [], "a studio document loses nothing");
  assert.deepEqual(review.studio.document, definition);
  assert.deepEqual(
    review.executable.map((item) => item.workflowId),
    ["oauth"],
  );

  const exported = exportArazzo(review.read, { version: "1.0.1" });
  assert.deepEqual(exported.losses, []);
  assert.deepEqual(exported.document, definition, "1.0.1 round trip is exact");
  assert.equal(exported.mediaType, "application/vnd.oai.workflows+json");
  // And it still runs through the existing bounded executor with host bindings.
  const executed: string[] = [];
  await runArazzo(
    arazzoSchema.parse(exported.document),
    "oauth",
    new Map(
      ["authorize/prepare", "accounts/get-current"].map((operation) => [
        operation,
        async () => {
          executed.push(operation);
        },
      ]),
    ),
  );
  assert.deepEqual(executed, ["authorize/prepare", "accounts/get-current"]);
});

test("AC-IMP-14 a general description is reviewable but not editable, with every loss pointed at", () => {
  const review = reviewArazzoImport(full110());
  assert.equal(review.studio.editable, false);
  assert.equal(review.studio.document, undefined);
  const codes = lossCodes(review.studio.losses);
  assert.ok(
    codes.has("arazzo.review.studio-version"),
    "1.1.0 is not a studio version",
  );
  assert.ok(codes.has("arazzo.review.studio-shape"));
  const pointers = new Set(
    review.studio.losses.map((loss) => loss.sourcePointer),
  );
  for (const pointer of [
    "/arazzo",
    "/$self",
    "/components",
    "/sourceDescriptions/1/type",
    "/workflows/0/steps/0/parameters",
    "/workflows/0/steps/0/requestBody",
    "/workflows/0/steps/0/successCriteria",
    "/workflows/0/steps/0/timeout",
    "/workflows/0/steps/1/channelPath",
    "/workflows/0/steps/1/dependsOn",
    "/workflows/0/successActions",
    "/workflows/0/outputs",
  ])
    assert.ok(pointers.has(pointer), pointer);
  // Losing the ability to edit does not lose the description.
  assert.equal(review.read.document!.workflows[0]!.steps.length, 2);
  assert.equal(review.read.definition!.capabilities.length, 1);

  // A 1.0.1 description with supported-but-unstudio constructs is also refused.
  const rich = reviewArazzoImport(storeWorkflow101());
  assert.equal(rich.studio.editable, false);
  assert.ok(
    lossCodes(rich.studio.losses).has("arazzo.review.studio-shape"),
    "outputs and criteria have no studio field",
  );
  assert.equal(
    rich.studio.losses.some(
      (loss) => loss.code === "arazzo.review.studio-version",
    ),
    false,
    "the version itself is fine",
  );
});

test("AC-IMP-14 exporting 1.1.0 as 1.0.1 blocks on every 1.1-only construct", () => {
  const read = readArazzo(full110());
  const downgrade = exportArazzo(read, { version: "1.0.1" });
  assert.equal(downgrade.document, undefined, "no lossy document is produced");
  const blocking = downgrade.losses.filter(
    (loss) => loss.severity === "blocking",
  );
  assert.ok(blocking.length > 0);
  const pointers = new Set(blocking.map((loss) => loss.sourcePointer));
  for (const pointer of [
    "/$self",
    "/sourceDescriptions/1/type",
    "/workflows/0/steps/0/timeout",
    "/workflows/0/steps/1/channelPath",
    "/workflows/0/steps/1/correlationId",
    "/workflows/0/steps/1/action",
    "/workflows/0/steps/1/dependsOn",
    "/workflows/0/steps/1/outputs/detail",
  ])
    assert.ok(pointers.has(pointer), pointer);
  for (const loss of blocking) {
    assert.equal(loss.code, "arazzo.export.version-downgrade-loss");
    assert.equal(loss.dimension, "export");
    assert.equal(loss.executionImpact, "blocks-definition");
  }

  // The same document exports as 1.1.0 unchanged.
  const same = exportArazzo(read, { version: "1.1.0" });
  assert.deepEqual(same.losses, []);
  assert.deepEqual(same.document, full110(), "1.1.0 round trip is exact");
});

test("AC-IMP-14 a 1.0.1 description upgrades cleanly and a clean 1.1.0 one downgrades", () => {
  const read = readArazzo(storeWorkflow101());
  const upgraded = exportArazzo(read, { version: "1.1.0" });
  assert.equal(upgraded.document!.arazzo, "1.1.0");
  assert.deepEqual(
    upgraded.losses.map((loss) => [loss.code, loss.severity]),
    [["arazzo.export.version-changed", "info"]],
  );
  assert.deepEqual(
    { ...upgraded.document, arazzo: "1.0.1" },
    storeWorkflow101(),
    "an upgrade changes only the version string",
  );

  // Reading it back as 1.1.0 and going down again returns the original.
  const back = exportArazzo(readArazzo(upgraded.document), {
    version: "1.0.1",
  });
  assert.deepEqual(
    back.losses.filter((loss) => loss.severity === "blocking"),
    [],
  );
  assert.deepEqual(back.document, storeWorkflow101());
});

test("an unreadable or unknown-version description exports nothing and says why", () => {
  const unknown = storeWorkflow101();
  unknown.arazzo = "1.4.0";
  const read = readArazzo(unknown);
  const exported = exportArazzo(read, { version: "1.0.1" });
  assert.equal(exported.document, undefined);
  assert.deepEqual(
    exported.losses.map((loss) => loss.code),
    ["arazzo.version.unsupported"],
  );
  const review = reviewArazzoImport(unknown);
  assert.equal(review.studio.editable, false);
  assert.deepEqual(review.executable, []);
});

test("fields outside the specification are preserved for review and dropped from exports", () => {
  const document = storeWorkflow101();
  (document.workflows as Record<string, unknown>[])[0]!.vendorOnly = {
    note: "not a specification field",
  };
  const read = readArazzo(document);
  assert.ok(
    read.issues.some(
      (issue) =>
        issue.code === "arazzo.structure.unknown-field" &&
        issue.sourcePointer === "/workflows/0/vendorOnly" &&
        issue.severity === "warning",
    ),
  );
  assert.deepEqual(read.document!.workflows[0]!.unknown, {
    vendorOnly: { note: "not a specification field" },
  });
  const exported = exportArazzo(read, { version: "1.0.1" });
  const exportedWorkflows = exported.document!.workflows as Record<
    string,
    unknown
  >[];
  assert.equal("vendorOnly" in exportedWorkflows[0]!, false);
  assert.ok(
    exported.losses.some(
      (loss) => loss.code === "arazzo.export.unknown-field-dropped",
    ),
  );
  // An x- extension is not vendor noise: it round-trips.
  const extended = storeWorkflow101();
  (extended.workflows as Record<string, unknown>[])[0]!["x-team"] =
    "connections";
  const extendedExport = exportArazzo(readArazzo(extended), {
    version: "1.0.1",
  });
  assert.deepEqual(extendedExport.losses, []);
  assert.deepEqual(extendedExport.document, extended);
});
