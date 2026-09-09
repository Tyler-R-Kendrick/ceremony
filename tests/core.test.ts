import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionsFor,
  fieldsFor,
  defaultTemplate,
  flowKinds,
  manifestSchema,
  validateInput,
} from "../src/core/index.js";
import { validateTemplate } from "../src/react/templates.js";
import { manifests } from "../examples/manifests.js";
import { trustedUrl } from "../src/server/adapters.js";
import { githubAppManifest } from "../src/server/github.js";

test("all bundled templates validate for every state", () => {
  for (const kind of flowKinds)
    assert.deepEqual(validateTemplate(defaultTemplate(kind)).errors, []);
});
test("templates reject missing controls, unknown components, effects and malformed source", () => {
  for (const source of [
    'root = Stack([Title("Hello"), Details(), Access(), Notice()])',
    'root = Stack([Title("Hello"), Details(), Access(), Actions(), Actions(), Notice()])',
    'root = Stack([Title("Hello"), Details(), Access(), Actions(), Notice(), Evil()])',
    'root = Stack([Title("Hello"), Details(), Access(), Actions(), Notice()])\nx = Query("steal", {})',
    '$state = "complete"\nroot = Stack([Title("Hello"), Details(), Access(), Actions(), Notice()])',
    'root = Stack([Title("Hello"), Details(), Access(), Actions(), Notice()])\nx = Text("orphan")',
    'root = Stack([Title("unterminated',
  ]) {
    const template = defaultTemplate("basic");
    template.screens.intro = source;
    assert.ok(validateTemplate(template).errors.length, source);
  }
});
test("template literal text cannot become executable source and imported shape is strict", () => {
  const template = defaultTemplate("basic");
  template.screens.intro = `root = Stack([Title(${JSON.stringify('hello "); Evil(); <script>secret</script>')}), Details(), Access(), Actions(), Notice()])`;
  assert.deepEqual(validateTemplate(template).errors, []);
  assert.ok(
    validateTemplate({ ...template, endpoint: "https://evil.example" }).errors
      .length,
  );
});
test("manifest and input validation reject duplicate IDs, unknown fields and unmasked credentials", () => {
  const manifest = manifests[0]!;
  assert.equal(
    manifestSchema.safeParse({
      ...manifest,
      methods: [manifest.methods[0], manifest.methods[0]],
    }).success,
    false,
  );
  const method = manifests
    .flatMap((value) => value.methods)
    .find((value) => value.kind === "basic")!;
  assert.equal(
    manifestSchema.safeParse({
      ...manifest,
      methods: [
        {
          ...method,
          fields: method.fields.map((field) => ({ ...field, type: "text" })),
        },
      ],
    }).success,
    false,
  );
  assert.throws(() =>
    validateInput(method.fields, {
      username: "demo",
      password: "secret",
      redirect_uri: "evil",
    }),
  );
  assert.throws(() =>
    validateInput(method.fields, { username: "demo", password: "" }),
  );
  assert.deepEqual(actionsFor("complete"), []);
  assert.deepEqual(actionsFor("error", true), ["finish", "claim", "cancel"]);
});
test("real connector examples cover every implemented auth family without invented methods", () => {
  assert.deepEqual(
    new Set(
      [...manifests, githubAppManifest].flatMap((item) =>
        item.methods.map((method) => method.kind),
      ),
    ),
    new Set(flowKinds),
  );
  assert.deepEqual(
    manifests.map((item) => item.id),
    ["github", "stripe", "jira", "supabase", "neon"],
  );
  const neon = manifests.find((item) => item.id === "neon")!.methods[0]!;
  assert.deepEqual(fieldsFor("claim", neon), []);
  assert.equal(
    fieldsFor("claim", { ...neon, claimFields: undefined })[0]?.name,
    "email",
  );
  assert.equal(
    manifestSchema.safeParse({
      ...manifests[0],
      methods: [{ ...manifests[0]!.methods[0], claimFields: [] }],
    }).success,
    false,
  );
});
test("provider URL boundaries reject unsafe schemes, embedded credentials and unexpected origins", () => {
  const config = { issuer: "https://provider.example" };
  for (const url of [
    "http://provider.example",
    "javascript:alert(1)",
    "https://user:secret@provider.example",
    "https://evil.example",
    "https://provider.example/#fragment",
  ])
    assert.throws(() => trustedUrl(url, config));
  assert.equal(
    trustedUrl("https://provider.example/verify", config).pathname,
    "/verify",
  );
  assert.throws(() =>
    trustedUrl("http://evil.example", {
      issuer: "http://evil.example",
      allowLoopbackHttp: true,
    }),
  );
});
