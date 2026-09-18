import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "extensions/browser-login");
const output = join(root, "extension-dist/chromium");
const published = join(root, "examples/web/public/extension");
// Public SPKI only. The ephemeral private key was discarded, not saved.
const key =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyiFDEY6iYQ3rlnyMgRxSX6HFZo06DbEtgMsKr1LBCinYZUxyL2cYcgtoDG3cjAMhpYDNLIsvrecVqwH/Df+OWhQR8wvxw9WVhVC7aLjLEiFhduqDW3wWc00w33L8eagH66teird9ZTl1cAXOoX1G0LGYm5kMotgHbtCsHEbYPQQem+Fw+9OeWGvUZzQTpjI2vxa+YhvzhfyTzjOfU9DMFSf8ArS09DoBzTwJlehSnbdHiYX4pd232LcA9MCQZNRMjlFvMz4wylfIrkFieI5LCH3jS5fa1zon4bqxlVu62WM9hOXdXrU7zksvh4pG9fFL5w2Gj9UgpsUGq2dnFBrOYQIDAQAB";
const extensionId = createHash("sha256")
  .update(Buffer.from(key, "base64"))
  .digest("hex")
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (digit) =>
    String.fromCharCode(97 + parseInt(digit, 16)),
  );
const appOrigins = [
  ...new Set([
    "http://127.0.0.1:4173",
    ...(process.env.CEREMONY_EXTENSION_APP_ORIGINS ?? "")
      .split(",")
      .filter(Boolean)
      .map((value) => {
        const url = new URL(value);
        // The same rule the extension itself applies to a login origin: HTTPS,
        // or the loopback address, which cannot be reached from off the machine
        // and is how the owned fixture and the local app are already served.
        const loopback =
          url.protocol === "http:" && url.hostname === "127.0.0.1";
        if (
          (url.protocol !== "https:" && !loopback) ||
          url.origin !== value ||
          url.username ||
          url.password ||
          value.includes("*")
        ) {
          throw new Error(
            "CEREMONY_EXTENSION_APP_ORIGINS requires comma-separated exact HTTPS (or http://127.0.0.1) origins without paths",
          );
        }
        return url.origin;
      }),
  ]),
];
const manifest = JSON.parse(
  await readFile(join(source, "manifest.json"), "utf8"),
);
manifest.key = key;
manifest.externally_connectable = {
  matches: [
    ...new Set(
      appOrigins.map((origin) => {
        const url = new URL(origin);
        return `${url.protocol}//${url.hostname}/*`;
      }),
    ),
  ],
};
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "wasm"), { recursive: true });
await mkdir(published, { recursive: true });
const shared = {
  bundle: true,
  platform: "browser",
  target: "chrome120",
  minify: true,
  legalComments: "inline",
  sourcemap: false,
};
await build({
  ...shared,
  entryPoints: ["worker", "ui", "inference.worker"].map((name) =>
    join(source, `${name}.ts`),
  ),
  outdir: output,
  format: "esm",
});
await build({
  ...shared,
  entryPoints: [join(source, "content.ts")],
  outfile: join(output, "content.js"),
  format: "iife",
});
for (const name of ["ui.html", "ui.css"])
  await copyFile(join(source, name), join(output, name));
await writeFile(
  join(output, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
await writeFile(
  join(output, "config.json"),
  // Which bridge this artifact was built for is a fact the worker refuses to
  // guess: only the path the manifest actually admits may answer an app.
  JSON.stringify({ appOrigins, appBridge: "externally-connectable" }, null, 2) +
    "\n",
);
const require = createRequire(import.meta.url);
const wasmRoot = dirname(require.resolve("onnxruntime-web"));
// ONNX can dynamically import either backend loader; both stay extension-local.
const wasm = ["ort-wasm-simd-threaded", "ort-wasm-simd-threaded.jsep"].flatMap(
  (name) => [`${name}.mjs`, `${name}.wasm`],
);
for (const name of wasm)
  await copyFile(join(wasmRoot, name), join(output, "wasm", name));
const files = [
  "manifest.json",
  "config.json",
  "worker.js",
  "content.js",
  "ui.js",
  "ui.html",
  "ui.css",
  "inference.worker.js",
  ...wasm.map((name) => `wasm/${name}`),
];
const archive = join(root, "extension-dist/ceremony-browser-login.zip");
await rm(archive, { force: true });
// No recursive source-tree archive: credentials, fixtures and profiles cannot leak.
execFileSync("zip", ["-X", "-q", archive, ...files], { cwd: output });
const metadata = {
  version: manifest.version,
  protocol: 1,
  extensionId,
  downloadUrl: "/extension/ceremony-browser-login.zip",
  sha256: createHash("sha256")
    .update(await readFile(archive))
    .digest("hex"),
};
await copyFile(archive, join(published, "ceremony-browser-login.zip"));
await writeFile(
  join(published, "metadata.json"),
  JSON.stringify(metadata, null, 2) + "\n",
);

// Gecko variant. Same sources, same checks, three unavoidable differences:
// MV3 background there is an event page rather than a service worker, the
// add-on needs a stable `browser_specific_settings.gecko.id`, and there is no
// `externally_connectable`, so the app bridge becomes a content script the
// manifest admits on the app origins alone.
const geckoOutput = join(root, "extension-dist/firefox");
const geckoManifest = JSON.parse(
  await readFile(join(source, "manifest.firefox.json"), "utf8"),
);
if (geckoManifest.version !== manifest.version)
  throw new Error("manifest.firefox.json version must match manifest.json");
// Match patterns admit no port, so this narrows the relay to the app hosts; the
// relay and the worker both still require the exact origin including its port.
geckoManifest.content_scripts = [
  {
    matches: [
      ...new Set(
        appOrigins.map((origin) => {
          const url = new URL(origin);
          return `${url.protocol}//${url.hostname}/*`;
        }),
      ),
    ],
    js: ["relay.js"],
    run_at: "document_start",
    all_frames: false,
  },
];
await rm(geckoOutput, { recursive: true, force: true });
await mkdir(join(geckoOutput, "wasm"), { recursive: true });
const gecko = { ...shared, target: "firefox115" };
await build({
  ...gecko,
  entryPoints: ["ui", "inference.worker"].map((name) =>
    join(source, `${name}.ts`),
  ),
  outdir: geckoOutput,
  format: "esm",
});
// An event page is a classic script, not a module, on every MV3 Firefox this
// artifact claims to support.
await build({
  ...gecko,
  entryPoints: [join(source, "worker.ts")],
  outfile: join(geckoOutput, "worker.js"),
  format: "iife",
});
await build({
  ...gecko,
  entryPoints: [join(source, "content.ts")],
  outfile: join(geckoOutput, "content.js"),
  format: "iife",
});
await build({
  ...gecko,
  entryPoints: [join(source, "relay.ts")],
  outfile: join(geckoOutput, "relay.js"),
  format: "iife",
  // Inlined rather than fetched: a web-accessible config would be readable by
  // the very pages the relay is guarding against.
  define: { __CEREMONY_APP_ORIGINS__: JSON.stringify(appOrigins) },
});
for (const name of ["ui.html", "ui.css"])
  await copyFile(join(source, name), join(geckoOutput, name));
await writeFile(
  join(geckoOutput, "manifest.json"),
  JSON.stringify(geckoManifest, null, 2) + "\n",
);
await writeFile(
  join(geckoOutput, "config.json"),
  JSON.stringify({ appOrigins, appBridge: "content-relay" }, null, 2) + "\n",
);
for (const name of wasm)
  await copyFile(join(wasmRoot, name), join(geckoOutput, "wasm", name));
const geckoFiles = [...files, "relay.js"].sort();
const geckoArchive = join(
  root,
  "extension-dist/ceremony-browser-login-firefox.xpi",
);
await rm(geckoArchive, { force: true });
execFileSync("zip", ["-X", "-q", geckoArchive, ...geckoFiles], {
  cwd: geckoOutput,
});
const geckoMetadata = {
  version: geckoManifest.version,
  protocol: 1,
  extensionId: geckoManifest.browser_specific_settings.gecko.id,
  artifact: "ceremony-browser-login-firefox.xpi",
  // Unsigned. Firefox release and beta install only signed add-ons, so this
  // loads as a temporary add-on in about:debugging, or permanently only in
  // Developer Edition, Nightly or ESR with signature enforcement relaxed.
  signed: false,
  distribution: "development-only",
  sha256: createHash("sha256")
    .update(await readFile(geckoArchive))
    .digest("hex"),
};
await writeFile(
  join(root, "extension-dist/metadata.json"),
  JSON.stringify(
    {
      chromium: { ...metadata, unpackedPath: output },
      firefox: { ...geckoMetadata, unpackedPath: geckoOutput },
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    {
      chromium: { ...metadata, unpackedPath: output },
      firefox: { ...geckoMetadata, unpackedPath: geckoOutput },
    },
    null,
    2,
  ),
);
