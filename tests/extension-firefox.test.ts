import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The installable Gecko artifact, exercised as an artifact: built from this
 * checkout's sources into a staging tree (shared output directories race with
 * the other artifact tests), then opened and read back. What it proves is the
 * contents of the file a person would install — not that Firefox accepts it.
 * Nothing here loads the add-on into a browser, and nothing here should be read
 * as evidence that it does.
 */
const root = fileURLToPath(new URL("../", import.meta.url));

type Built = {
  staging: string;
  xpi: string;
  entries: string[];
  manifest: Record<string, unknown>;
  chromiumManifest: Record<string, unknown>;
  config: { appOrigins: string[]; appBridge: string };
  chromiumConfig: { appOrigins: string[]; appBridge: string };
  metadata: Record<string, Record<string, unknown>>;
  extracted: string;
};

async function buildArtifacts(): Promise<Built> {
  const staging = await mkdtemp(join(tmpdir(), "ceremony-firefox-build-"));
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
    symlink(join(root, "node_modules"), join(staging, "node_modules"), "dir"),
  ]);
  execFileSync(process.execPath, ["scripts/build-extension.mjs"], {
    cwd: staging,
    timeout: 120_000,
    stdio: "pipe",
  });
  const xpi = join(
    staging,
    "extension-dist/ceremony-browser-login-firefox.xpi",
  );
  const extracted = join(staging, "extracted-firefox");
  execFileSync("unzip", ["-q", xpi, "-d", extracted], {
    timeout: 60_000,
    stdio: "pipe",
  });
  const listing = execFileSync("unzip", ["-Z1", xpi], {
    timeout: 30_000,
    encoding: "utf8",
  });
  const read = async (path: string) =>
    JSON.parse(await readFile(join(staging, path), "utf8"));
  return {
    staging,
    xpi,
    entries: listing.split("\n").filter(Boolean).sort(),
    manifest: await read("extension-dist/firefox/manifest.json"),
    chromiumManifest: await read("extension-dist/chromium/manifest.json"),
    config: await read("extension-dist/firefox/config.json"),
    chromiumConfig: await read("extension-dist/chromium/config.json"),
    metadata: await read("extension-dist/metadata.json"),
    extracted,
  };
}

const built = await buildArtifacts();
test.after(() => rm(built.staging, { recursive: true, force: true }));

test("the Firefox artifact is an installable add-on with a parseable MV3 manifest", () => {
  assert.deepEqual(built.entries, [
    "config.json",
    "content.js",
    "inference.worker.js",
    "manifest.json",
    "relay.js",
    "ui.css",
    "ui.html",
    "ui.js",
    "wasm/ort-wasm-simd-threaded.jsep.mjs",
    "wasm/ort-wasm-simd-threaded.jsep.wasm",
    "wasm/ort-wasm-simd-threaded.mjs",
    "wasm/ort-wasm-simd-threaded.wasm",
    "worker.js",
  ]);
  const manifest = built.manifest;
  assert.equal(manifest["manifest_version"], 3);
  assert.equal(manifest["version"], built.chromiumManifest["version"]);
  // Gecko needs a stable add-on id, and MV3 there is an event page rather than
  // a service worker. Both are required for the file to install at all.
  const gecko = (
    manifest["browser_specific_settings"] as {
      gecko?: { id?: string; strict_min_version?: string };
    }
  ).gecko;
  assert.match(gecko?.id ?? "", /^[^@\s]+@[^@\s]+$/);
  assert.match(gecko?.strict_min_version ?? "", /^\d+\.\d+$/);
  assert.deepEqual(manifest["background"], { scripts: ["worker.js"] });
  assert.equal("service_worker" in (manifest["background"] as object), false);
  assert.equal("key" in manifest, false);
  // `externally_connectable` is Chromium's webpage bridge; Gecko ignores it, so
  // shipping it would be a claim the artifact cannot keep.
  assert.equal("externally_connectable" in manifest, false);
  assert.ok(
    (
      manifest["content_security_policy"] as { extension_pages?: string }
    ).extension_pages?.includes("script-src 'self'"),
  );
});

test("the Firefox artifact asks for no more access than the Chromium one", () => {
  assert.deepEqual(
    built.manifest["permissions"],
    built.chromiumManifest["permissions"],
  );
  assert.deepEqual(
    built.manifest["host_permissions"],
    built.chromiumManifest["host_permissions"],
  );
  // Declared the same way on both: HTTPS hosts are optional and requested per
  // site at run time, never granted by the manifest.
  assert.deepEqual(built.manifest["optional_host_permissions"], [
    "https://*/*",
  ]);
  assert.deepEqual(
    built.manifest["optional_host_permissions"],
    built.chromiumManifest["optional_host_permissions"],
  );
  const hosts = [
    ...new Set(
      built.config.appOrigins.map((origin) => {
        const url = new URL(origin);
        return `${url.protocol}//${url.hostname}/*`;
      }),
    ),
  ];
  // The relay is the app bridge, and it is admitted on the app hosts alone —
  // the same hosts Chromium's `externally_connectable` names, not a wider set.
  assert.deepEqual(built.manifest["content_scripts"], [
    {
      matches: hosts,
      js: ["relay.js"],
      run_at: "document_start",
      all_frames: false,
    },
  ]);
  assert.deepEqual(
    hosts,
    (built.chromiumManifest["externally_connectable"] as { matches: string[] })
      .matches,
  );
});

test("each artifact answers only on the bridge its own manifest admits", async () => {
  assert.equal(built.config.appBridge, "content-relay");
  assert.equal(built.chromiumConfig.appBridge, "externally-connectable");
  assert.deepEqual(built.config.appOrigins, built.chromiumConfig.appOrigins);
  // A match pattern carries no port, so the exact origin has to be checked by
  // code. The relay carries the list rather than fetching a readable resource.
  const relay = await readFile(join(built.extracted, "relay.js"), "utf8");
  for (const origin of built.config.appOrigins)
    assert.ok(relay.includes(origin), origin);
  assert.equal(
    (await readdir(built.extracted)).includes("web_accessible_resources"),
    false,
  );
});

test("the Firefox artifact declares no credential storage and carries no secrets", async () => {
  const forbidden = [
    "cookies",
    "webRequest",
    "webRequestBlocking",
    "nativeMessaging",
    "debugger",
    "downloads",
    "history",
    "management",
    "identity",
    "privacy",
    "clipboardRead",
    "unlimitedStorage",
    "browsingData",
    "pageCapture",
  ];
  const permissions = built.manifest["permissions"] as string[];
  for (const permission of forbidden)
    assert.equal(permissions.includes(permission), false, permission);
  assert.equal(permissions.includes("storage"), true);
  const text = new Map<string, string>();
  for (const entry of built.entries) {
    if (entry.endsWith(".wasm")) continue;
    text.set(entry, await readFile(join(built.extracted, entry), "utf8"));
  }
  for (const [entry, contents] of text) {
    // Run state lives in `storage.session` only: nothing this extension writes
    // may survive the browser, and nothing it writes is a credential.
    assert.equal(
      /storage\s*\.\s*(local|sync|managed)\b/.test(contents),
      false,
      `${entry} must not reach a durable storage area`,
    );
    for (const secret of [
      "BEGIN PRIVATE KEY",
      "BEGIN RSA PRIVATE KEY",
      "BEGIN OPENSSH PRIVATE KEY",
      "client_secret",
      "AWS_SECRET",
      "CEREMONY_",
      "fixture-pass",
    ])
      assert.equal(
        contents.includes(secret),
        false,
        `${entry} must not contain ${secret}`,
      );
    // The Chromium build embeds a public SPKI to pin its unpacked id. It is not
    // a secret, but it is Chromium's identity and has no business travelling in
    // the Gecko artifact.
    assert.equal(
      contents.includes(built.chromiumManifest["key"] as string),
      false,
      `${entry} must not carry Chromium's packaging key`,
    );
  }
  // No sources, no environment files, no profiles: the archive is an explicit
  // file list, never a recursive copy of the tree it was built from.
  for (const entry of built.entries)
    assert.equal(
      /\.(ts|tsx|map|pem|key|crt|env)$|(^|\/)\.env|(^|\/)node_modules\//.test(
        entry,
      ),
      false,
      entry,
    );
});

test("extension sources reach the browser only through the platform facade", async () => {
  // A bare `chrome.` would typecheck against the ambient declaration and then
  // behave differently on Gecko, which is exactly the divergence the facade
  // exists to prevent. `platform.ts` is where the two dialects are allowed to
  // be named at all.
  const directory = join(root, "extensions/browser-login");
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith(".ts") || entry === "platform.ts") continue;
    const contents = await readFile(join(directory, entry), "utf8");
    const reached = contents
      .split("\n")
      .filter((line) => /(^|[^\w.])chrome\s*\./.test(line));
    assert.deepEqual(reached, [], `${entry} must go through platform.ts`);
  }
});

test("build metadata covers both targets and matches the bytes on disk", async () => {
  const firefox = built.metadata["firefox"]!;
  assert.equal(firefox["version"], built.manifest["version"]);
  assert.equal(firefox["protocol"], 1);
  assert.equal(
    firefox["extensionId"],
    (built.manifest["browser_specific_settings"] as { gecko: { id: string } })
      .gecko.id,
  );
  assert.equal(firefox["artifact"], "ceremony-browser-login-firefox.xpi");
  // Unsigned and labelled as such. Nothing in this repo signs or publishes it.
  assert.equal(firefox["signed"], false);
  assert.equal(firefox["distribution"], "development-only");
  assert.equal(
    firefox["sha256"],
    createHash("sha256")
      .update(await readFile(built.xpi))
      .digest("hex"),
  );

  // The Chromium target keeps its own artifact, name, id shape and published
  // metadata exactly as before.
  const chromium = built.metadata["chromium"]!;
  assert.equal(chromium["protocol"], 1);
  assert.equal(
    chromium["downloadUrl"],
    "/extension/ceremony-browser-login.zip",
  );
  assert.match(chromium["extensionId"] as string, /^[a-p]{32}$/);
  const published = JSON.parse(
    await readFile(
      join(built.staging, "examples/web/public/extension/metadata.json"),
      "utf8",
    ),
  );
  assert.deepEqual(published, {
    version: chromium["version"],
    protocol: 1,
    extensionId: chromium["extensionId"],
    downloadUrl: "/extension/ceremony-browser-login.zip",
    sha256: chromium["sha256"],
  });
  assert.equal(
    chromium["sha256"],
    createHash("sha256")
      .update(
        await readFile(
          join(
            built.staging,
            "examples/web/public/extension/ceremony-browser-login.zip",
          ),
        ),
      )
      .digest("hex"),
  );
});
