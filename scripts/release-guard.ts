import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/*
 * The first thing `npm publish` runs (it is the head of `prepublishOnly`), and
 * the first step of .github/workflows/release.yml.
 *
 * `"private": true` used to be what stopped an accidental publish. It had to
 * go for the package to be publishable at all, so this takes over its job with
 * a narrower rule: a publish happens only when the caller names the release
 * tag in CEREMONY_RELEASE_TAG, and only when that tag is exactly `v` plus the
 * version in package.json. The release workflow sets it from the tag that
 * triggered it; a person typing `npm publish` at a checkout has not, and is
 * refused before anything is built or uploaded. A tag that names another
 * version is refused too, so a tag can never publish a version it does not
 * say.
 *
 * It decides; it does not check the code. `prepublishOnly` runs `check`,
 * `build` and `test:package` after it.
 */

export type Manifest = { name?: string; version?: string; private?: boolean };

/** Why this publish must not happen, or `undefined` when it may. */
export function releaseRefusal(
  manifest: Manifest,
  env: Record<string, string | undefined>,
): string | undefined {
  const tag = env.CEREMONY_RELEASE_TAG;
  if (!manifest.version) return "package.json has no version to publish.";
  if (manifest.private)
    return 'package.json is marked "private", so npm would refuse it anyway.';
  if (!tag)
    return (
      "Refusing to publish: CEREMONY_RELEASE_TAG is not set. Releases are " +
      "published by .github/workflows/release.yml from a v* tag, not from a " +
      "local checkout."
    );
  if (tag !== `v${manifest.version}`)
    return (
      `Refusing to publish: the tag ${JSON.stringify(tag)} does not match ` +
      `package.json's version ${manifest.version}. Tag the release ` +
      `v${manifest.version}, or change the version and tag again.`
    );
  return undefined;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as Manifest;
  const refusal = releaseRefusal(manifest, process.env);
  if (refusal) {
    console.error(refusal);
    process.exitCode = 1;
  } else {
    console.log(
      `Releasing ${manifest.name}@${manifest.version} from tag ${process.env.CEREMONY_RELEASE_TAG}.`,
    );
  }
}
