import {
  actionsFor,
  defaultTemplate,
  fieldsFor,
  flowKinds,
  snapshotSchema,
  type AuthMethod,
  type CeremonySnapshot,
  type ConnectorManifest,
  type FlowKind,
  type Step,
} from "../src/core/schema.js";
import { manifests } from "../examples/manifests.js";
import { githubAppManifest } from "../src/server/github.js";
import { authScenarios } from "../tests/doubles/auth-provider/scenarios.js";

/**
 * The data behind the published catalogue.
 *
 * Two things are gathered here, and both are read from the project rather than
 * written for the page. The scenario catalogue is the same list the auth
 * scenario doubles drive, so the page cannot claim coverage the suite does not
 * have. The screens are produced by the real templates from snapshots the
 * production schema accepts, so a screen the page shows is one the product can
 * render.
 *
 * What the page cannot do is contact a provider — a published artifact makes no
 * network requests at all — so these are specimens of real screens, and the
 * page says so rather than implying a session happened.
 */

export interface CatalogueEntry {
  id: string;
  title: string;
  family: string;
  flowKind: FlowKind;
  goal: string;
  preconditions: readonly string[];
  provides: readonly string[];
  /** What the driver is required to reach: completed, blocked, stalled… */
  outcome: string;
  /** Interruptions the scenario expects, where it states a number. */
  handoffs?: number;
}

function outcomeOf(expect: (typeof authScenarios)[number]["expect"]): string {
  const value = expect as Record<string, unknown>;
  if (typeof value.status === "string")
    return typeof value.reason === "string"
      ? `${value.status}: ${value.reason}`
      : value.status;
  return "unstated";
}

/** Every scenario the doubles drive, reduced to what a reader needs. */
export function catalogue(): CatalogueEntry[] {
  return authScenarios.map((scenario) => {
    const handoffs = (scenario.expect as { handoffs?: number }).handoffs;
    return {
      id: scenario.id,
      title: scenario.title,
      family: scenario.family,
      flowKind: scenario.flowKind,
      goal: scenario.goal,
      preconditions: scenario.preconditions ?? [],
      provides: scenario.provides ?? [],
      outcome: outcomeOf(scenario.expect),
      ...(typeof handoffs === "number" ? { handoffs } : {}),
    };
  });
}

/**
 * The steps each flow actually reaches, in order.
 *
 * Every template declares a screen for all ten steps, but a flow only walks
 * some of them: a redirect never asks for input, a device flow waits, and only
 * anonymous access can be claimed afterwards. Listing all ten per flow would
 * pad the page with screens that flow never shows.
 */
export const journeys: Record<FlowKind, readonly Step[]> = {
  "oauth-code": ["intro", "redirect", "complete"],
  "github-app": ["intro", "redirect", "complete"],
  device: ["intro", "waiting", "complete"],
  "authmd-anonymous": ["intro", "anonymous", "claim", "complete"],
  "api-key": ["intro", "input", "complete"],
  basic: ["intro", "input", "complete"],
  form: ["intro", "input", "complete"],
};

/** Where an attempt stops instead of finishing. Shared by every flow. */
export const walls: readonly Step[] = ["error", "cancelled", "expired"];

export const everyManifest: readonly ConnectorManifest[] = [
  ...manifests,
  githubAppManifest,
];

/** A real connector and method for each kind, never a manifest written here. */
export function carrierFor(kind: FlowKind): {
  manifest: ConnectorManifest;
  method: AuthMethod;
} {
  for (const manifest of everyManifest) {
    const method = manifest.methods.find((entry) => entry.kind === kind);
    if (method) return { manifest, method };
  }
  throw new Error(`No connector in this project declares a ${kind} method`);
}

/** Illustrative values for the screen specimens. Never a provider's answer. */
const specimenUuid = "11111111-1111-4111-8111-111111111111";

/**
 * One screen, as a snapshot the production schema accepts.
 *
 * Parsed rather than cast: a specimen the schema would refuse is a screen the
 * product cannot reach, and showing it would misrepresent the library.
 */
export function specimen(kind: FlowKind, step: Step): CeremonySnapshot {
  const { manifest, method } = carrierFor(kind);
  const anonymous =
    method.contract?.completion.ownership.includes("anonymous") ?? false;
  return snapshotSchema.parse({
    id: specimenUuid,
    revision: 0,
    connectorId: manifest.id,
    connectorName: manifest.name,
    description: manifest.description,
    method,
    step,
    fields: fieldsFor(step, method),
    actions: actionsFor(step, anonymous && step !== "claim"),
    expiresAt: Date.parse("2030-01-01T00:00:00Z"),
    ...(step === "redirect"
      ? {
          authorizationUrl: "https://provider.example/authorize",
          prerequisites: [
            {
              id: "prepare",
              label: "Prepare the integration",
              status: "succeeded" as const,
            },
            {
              id: "approve",
              label: `Approve access at ${manifest.name}`,
              status: "awaiting-human" as const,
            },
            {
              id: "verify",
              label: "Verify the granted access",
              status: "blocked" as const,
            },
          ],
        }
      : {}),
    ...(step === "waiting"
      ? {
          verificationUri: "https://provider.example/device",
          userCode: "WDJB-MJHT",
        }
      : {}),
    ...(step === "complete"
      ? {
          outcome: {
            connectionRef: specimenUuid,
            ownership: anonymous
              ? ("anonymous" as const)
              : ("authenticated" as const),
            scopes: method.scopes,
          },
        }
      : {}),
    ...(step === "error"
      ? { message: `${manifest.name} refused the request.` }
      : {}),
  });
}

/** Every scope some method of some connector in this project really declares. */
export function scopeVocabulary(): string[] {
  return [
    ...new Set(
      everyManifest.flatMap((manifest) =>
        manifest.methods.flatMap((method) => method.scopes),
      ),
    ),
  ].sort();
}

/**
 * What a host might declare the integration has to be able to do.
 *
 * The labels are copy, and copy belongs to the host — on this page the page is
 * the host, so it writes them. The scopes are not copy: each one is declared by
 * a method some connector here really ships, which is what makes the filtering
 * they drive a real result rather than a demonstration arranged to come out
 * well. `permissionScopesAreReal` is the assertion, and a test holds it.
 */
export const permissionChoices: readonly {
  id: string;
  label: string;
  scopes: readonly string[];
}[] = [
  { id: "profile", label: "Read your GitHub profile", scopes: ["read:user"] },
  {
    id: "contents",
    label: "Read repository contents",
    scopes: ["contents:read"],
  },
];

export function permissionScopesAreReal(): boolean {
  const vocabulary = new Set(scopeVocabulary());
  return permissionChoices.every((permission) =>
    permission.scopes.every((scope) => vocabulary.has(scope)),
  );
}

/**
 * What the page hands to the resolver running in the reader's browser.
 *
 * Manifests travel as data and are re-parsed by the production schema on the
 * other side, so the page cannot ship a connector the project would refuse.
 */
export function galleryPayload(): {
  connectors: { key: string; manifest: ConnectorManifest }[];
  permissions: typeof permissionChoices;
} {
  return {
    // Two connectors here are both named GitHub and both carry the id
    // `github` — one is the OAuth connector, one the App installation — so the
    // key is positional rather than the id it would collide on.
    connectors: everyManifest.map((manifest, index) => ({
      key: `connector-${index}`,
      manifest,
    })),
    permissions: permissionChoices,
  };
}

/**
 * A specimen is looked at, not operated.
 *
 * A published page reaches no network, so no control inside a rendered screen
 * can do the thing it names. Wiring one to a handler that quietly does nothing
 * is the worst of the options: it looks pressable, it invites a press, and the
 * press fails silently. So every control is taken out of the tab order here,
 * out of pointer events by the stylesheet, and the case it sits in says so
 * before anybody reaches for it.
 *
 * What it is not is `disabled`: that dims the control, and a catalogue that
 * shows a greyed Connect is showing a button the product never renders.
 */
export function asSpecimen(html: string): string {
  // `\b` keeps `<a` from matching `<article`, which is the element the card
  // itself is, and which carries no tab stop to remove.
  return html.replace(
    /<(button|a|input|select|textarea)\b/g,
    '<$1 tabindex="-1"',
  );
}

/** Controls a browser would put in the tab order, as a count. */
export function tabStops(html: string): number {
  return (
    html.match(/<(?:button|a|input|select|textarea)\b(?![^>]*tabindex)/g) ?? []
  ).length;
}

/** The template the product would pick for this kind. */
export const templateFor = (kind: FlowKind) => defaultTemplate(kind);

export { flowKinds };
