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
        if (
          url.protocol !== "https:" ||
          url.origin !== value ||
          url.username ||
          url.password ||
          value.includes("*")
        ) {
          throw new Error(
            "CEREMONY_EXTENSION_APP_ORIGINS requires comma-separated exact HTTPS origins without paths",
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
  JSON.stringify({ appOrigins }, null, 2) + "\n",
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
console.log(JSON.stringify({ ...metadata, unpackedPath: output }, null, 2));
