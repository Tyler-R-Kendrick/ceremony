import {
  entryContextSchema,
  explainCeremonySelection,
  resolveConnection,
  type ConnectionRoute,
  type EntryContext,
  type MethodSelection,
} from "../src/core/resolution.js";
import { manifestSchema, type ConnectorManifest } from "../src/core/schema.js";
import { resolverMountId, resolverPayloadId } from "./gallery-ids.js";

/**
 * The one part of the published catalogue that runs.
 *
 * Everything else on the page is a rendering: real components and real
 * snapshots, but produced when the page was built. A published page reaches no
 * network at all, so it cannot contact a provider, and a screen here must not
 * pretend a session is happening — which is why every specimen is inoperable
 * rather than wired to a handler that quietly does nothing.
 *
 * Resolution needs no provider. It is a pure function of what the host declared
 * and what the connectors offer, so the real `resolveConnection` is compiled
 * into this page and runs in the reader's browser against the real manifests.
 * What changes here is what would change in an application: which route each
 * connector takes, what it costs a person, and what was ruled out and why.
 */

type Reason = MethodSelection["candidates"][number]["reason"];
type Identity = NonNullable<EntryContext["identity"]>;
type Interruptions = NonNullable<EntryContext["interruptions"]>;
type Surface = NonNullable<EntryContext["surface"]>;

export interface PermissionChoice {
  readonly id: string;
  readonly label: string;
  readonly scopes: readonly string[];
}

export interface GalleryPayload {
  readonly connectors: readonly { key: string; manifest: unknown }[];
  readonly permissions: readonly PermissionChoice[];
}

const routeLabels: Record<ConnectionRoute, string> = {
  "provider-approval": "Approve at the provider",
  "second-device": "Code on another device",
  "supplied-credential": "Credential you hold",
  "no-account": "No account needed",
};

/** Why a method was ruled out, in the terms the declaration was written in. */
const reasonLabels: Record<Reason, string> = {
  eligible: "eligible",
  unavailable: "the host reports it unavailable",
  "unsupported-surface": "it cannot run on this surface",
  "insufficient-scopes": "it cannot grant everything asked for",
  "wrong-identity": "it produces the wrong kind of ownership",
  "too-many-interruptions": "it interrupts more often than allowed",
};

const identityNotes: Record<Identity, string> = {
  either: "no opinion — whatever works",
  personal: "somebody has to own the result",
  anonymous: "it has to finish with nobody attached",
};

const interruptionNotes: Record<Interruptions, string> = {
  any: "stop a person as often as the route needs",
  "at-most-one": "one stop, and no more",
  none: "nobody may be interrupted at all",
};

const surfaceNotes: Record<Surface, string> = {
  browser: "somebody is here, at a browser",
  headless: "no browser, so no redirect can land",
};

const noteText: Record<string, Record<string, string>> = {
  identity: identityNotes,
  interruptions: interruptionNotes,
  surface: surfaceNotes,
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The declaration as a host would write it, restated as it changes. */
function declarationSource(intent: EntryContext): string {
  const permissions = intent.permissions ?? [];
  return [
    "createCeremonyClient({",
    "  manifest,",
    "  context: {",
    `    surface: ${JSON.stringify(intent.surface)},`,
    `    identity: ${JSON.stringify(intent.identity)},`,
    `    interruptions: ${JSON.stringify(intent.interruptions)},`,
    ...(permissions.length
      ? [
          "    permissions: [",
          ...permissions.map(
            (permission) =>
              `      { label: ${JSON.stringify(permission.label)}, scopes: ${JSON.stringify(permission.scopes ?? [])} },`,
          ),
          "    ],",
        ]
      : ["    permissions: [],"]),
    "  },",
    "});",
  ].join("\n");
}

/** The same meter the card draws, from the same number the resolver minimises. */
function cost(count: number, of = 3): HTMLElement {
  const meter = element("span", "cost");
  meter.dataset.cost = String(count);
  const track = element("span", "cost-pips");
  track.setAttribute("aria-hidden", "true");
  for (let index = 0; index < Math.max(of, count); index += 1) {
    const pip = element("span", "cost-pip");
    pip.dataset.on = index < count ? "true" : "false";
    track.append(pip);
  }
  meter.append(
    track,
    document.createTextNode(
      count === 0
        ? "interrupts nobody"
        : `${count} handoff${count === 1 ? "" : "s"}`,
    ),
  );
  return meter;
}

function rejections(
  entries: readonly { methodId: string; reason: Reason }[],
): HTMLElement | undefined {
  if (!entries.length) return undefined;
  const details = element("details", "ruled-out");
  details.append(element("summary", undefined, `${entries.length} ruled out`));
  const list = element("ul");
  for (const entry of entries) {
    const item = element("li");
    item.append(
      element("code", undefined, entry.methodId),
      document.createTextNode(` — ${reasonLabels[entry.reason]}`),
    );
    list.append(item);
  }
  details.append(list);
  return details;
}

/** One connector, resolved against the declaration as it currently stands. */
function resolution(
  manifest: ConnectorManifest,
  intent: EntryContext,
): HTMLElement {
  const card = element("article", "resolution");
  // The name and the route share a line; the description gets the full width
  // beneath them. Two connectors here are both called GitHub, so the
  // description is what tells them apart and must not be squeezed into a
  // column beside a chip.
  const head = element("div", "resolution-head");
  head.append(element("h3", undefined, manifest.name));
  card.append(head, element("p", "resolution-what", manifest.description));
  try {
    const resolved = resolveConnection(manifest, intent);
    card.dataset.state = "resolved";
    head.append(element("span", "route", routeLabels[resolved.route]));
    card.append(element("p", "sentence", resolved.summary));
    const foot = element("div", "resolution-foot");
    const chosen = element("p", "chosen");
    chosen.append(
      document.createTextNode("via "),
      element("code", undefined, resolved.method.id),
      document.createTextNode(" · "),
      element("code", "kind", resolved.method.kind),
    );
    foot.append(chosen, cost(resolved.handoffs));
    card.append(foot);
    const ruled = rejections(resolved.rejected);
    if (ruled) card.append(ruled);
  } catch {
    // Nothing satisfied the declaration. The candidate list is still the honest
    // answer to "why not", so it is shown rather than an empty card.
    card.dataset.state = "unavailable";
    head.append(element("span", "route", "No route"));
    card.append(
      element(
        "p",
        "sentence",
        "Nothing this connector offers satisfies the declaration.",
      ),
    );
    const ruled = rejections(
      explainCeremonySelection(manifest, intent).candidates.filter(
        (candidate) => candidate.reason !== "eligible",
      ),
    );
    if (ruled) card.append(ruled);
  }
  return card;
}

export function boot(root: HTMLElement, raw: unknown): void {
  const payload = raw as GalleryPayload;
  // Parsed, not trusted: a manifest the production schema refuses is not one
  // this project ships, and resolving it would misrepresent the library.
  const connectors = payload.connectors.map((entry) =>
    manifestSchema.parse(entry.manifest),
  );
  const form = root.querySelector("form");
  const output = root.querySelector<HTMLElement>("[data-resolutions]");
  const source = root.querySelector<HTMLElement>("[data-declaration]");
  const tally = root.querySelector<HTMLElement>("[data-tally]");
  if (!form || !output || !source || !tally) return;
  const notes = [...root.querySelectorAll<HTMLElement>("[data-note]")];

  const read = (data: FormData): EntryContext => {
    const chosen = new Set(data.getAll("permission").map(String));
    return entryContextSchema.parse({
      surface: String(data.get("surface") ?? "browser"),
      identity: String(data.get("identity") ?? "either"),
      interruptions: String(data.get("interruptions") ?? "any"),
      permissions: payload.permissions
        .filter((permission) => chosen.has(permission.id))
        .map((permission) => ({
          label: permission.label,
          scopes: [...permission.scopes],
        })),
    });
  };

  const paint = () => {
    const data = new FormData(form);
    const intent = read(data);
    source.textContent = declarationSource(intent);
    output.replaceChildren(
      ...connectors.map((manifest) => resolution(manifest, intent)),
    );
    const resolved = output.querySelectorAll('[data-state="resolved"]').length;
    tally.textContent = `${resolved} of ${connectors.length} connectors can satisfy this declaration`;
    for (const note of notes) {
      const field = note.dataset.note ?? "";
      note.textContent =
        noteText[field]?.[String(data.get(field) ?? "")] ?? note.textContent;
    }
  };

  form.addEventListener("change", paint);
  form.addEventListener("submit", (event) => event.preventDefault());
  paint();
  root.dataset.live = "true";
}

declare global {
  interface Window {
    ceremonyResolver?: { boot: typeof boot };
  }
}

window.ceremonyResolver = { boot };

const mount = document.getElementById(resolverMountId);
const payload = document.getElementById(resolverPayloadId);
if (mount && payload?.textContent)
  boot(mount, JSON.parse(payload.textContent) as unknown);
