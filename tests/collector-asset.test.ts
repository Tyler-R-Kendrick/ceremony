import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectorDocument,
  readCollectorHtml,
} from "../src/server/collector-asset.js";

const built = `<!doctype html><div id="collector"></div><script>var o="__CEREMONY_BROKER_ORIGIN__";</script>`;

test("the broker origin replaces the placeholder", () => {
  const html = collectorDocument(built, "https://broker.example");
  assert.ok(html.includes('var o="https://broker.example"'));
  assert.ok(!html.includes("__CEREMONY_BROKER_ORIGIN__"));
});

/**
 * The origin lands inside a string literal in a script tag, in a document whose
 * whole job is handling credentials. It comes from host configuration, which is
 * a reason to expect it to be well formed and not a reason to skip checking.
 */
test("an origin that could break out of the script is refused", () => {
  for (const hostile of [
    'https://a.example"+alert(1)+"',
    "https://a.example</script><script>alert(1)</script>",
    "https://a.example/path",
    "https://a.example?x=1",
    "http://broker.example",
    "javascript:alert(1)",
  ])
    assert.throws(() => collectorDocument(built, hostile), Error, hostile);
});

test("a document with no placeholder is refused rather than served unchanged", () => {
  assert.throws(
    () =>
      collectorDocument(
        "<!doctype html><p>nothing here</p>",
        "https://b.example",
      ),
    /placeholder/,
  );
});

test("a missing build is absent, not an error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-"));
  assert.equal(
    await readCollectorHtml(pathToFileURL(join(directory, "collector.html"))),
    undefined,
  );
});

test("a built document that lost its placeholder is treated as unusable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-"));
  const path = join(directory, "collector.html");
  await writeFile(path, "<!doctype html><p>stale</p>");
  assert.equal(await readCollectorHtml(pathToFileURL(path)), undefined);
});

test("a real built document is read back whole", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-"));
  const path = join(directory, "collector.html");
  await writeFile(path, built);
  assert.equal(await readCollectorHtml(pathToFileURL(path)), built);
});
