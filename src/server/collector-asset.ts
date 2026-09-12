import { readFile } from "node:fs/promises";

/**
 * The built private-collector document, with its broker origin filled in.
 *
 * The bundle ships with a placeholder because one build serves every
 * deployment, and `registerPrivateCollector` only learns which origin it is
 * registering for at registration time.
 */

const PLACEHOLDER = "__CEREMONY_BROKER_ORIGIN__";

/**
 * The origin is substituted into a string literal inside a `<script>`, so it is
 * checked rather than trusted. It comes from host configuration today, but a
 * value that could close the literal or the tag would be an injection into a
 * document whose whole job is to handle credentials — and configuration is not
 * a reason to skip a check that costs nothing.
 */
export function collectorDocument(html: string, brokerOrigin: string): string {
  const origin = new URL(brokerOrigin).origin;
  if (origin !== brokerOrigin || !origin.startsWith("https://"))
    throw new Error("The collector broker must be an exact HTTPS origin");
  if (!/^https:\/\/[a-zA-Z0-9.\-:[\]]+$/.test(origin))
    throw new Error("The collector broker origin has unexpected characters");
  if (!html.includes(PLACEHOLDER))
    throw new Error("The built collector has no broker placeholder");
  return html.replaceAll(PLACEHOLDER, origin);
}

/**
 * Reads the artifact `npm run build:mcp-app` produces. Absent means the build
 * step has not run: a caller leaves the collector unregistered and says so,
 * rather than registering one that cannot work.
 *
 * No production caller supplies this yet, and the build still pays for the
 * bundle. Wiring it needs a decision this code cannot make on its own:
 * registerPrivateCollector takes a CeremonyController, which only the
 * reference application constructs, while the hosted deployment drives the
 * teaching runs model whose ids are not controller instance ids. Until that is
 * settled, in-chat collection stays unavailable and private input remains a
 * browser handoff.
 */
export async function readCollectorHtml(
  from = new URL("../../artifacts/mcp-app/collector.html", import.meta.url),
): Promise<string | undefined> {
  try {
    const html = await readFile(from, "utf8");
    return html.includes(PLACEHOLDER) ? html : undefined;
  } catch {
    return undefined;
  }
}
