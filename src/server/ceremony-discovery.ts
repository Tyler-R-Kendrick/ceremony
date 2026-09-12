import {
  type CeremonyGoal,
  type CeremonyRole,
  type PageSnapshot,
  type SnapshotElement,
} from "../core/browser-contracts.js";
import {
  ceremonyPlanSchema,
  PLAN_LIMITS,
  type CeremonyPlan,
  type PlanDatum,
  type PlanPath,
  type PlanStep,
} from "../core/ceremony-plan.js";
import type { CeremonyPage } from "./browser-driver.js";

/**
 * Work out what a provider's authentication actually requires, by reading it.
 *
 * **Discovery reads; it does not act.** It navigates and follows links, and it
 * never fills a field or presses a submit button. That is the property that
 * makes it safe to point at a provider you do not own: it cannot consume an
 * address, create an account, trip a rate limiter or spend a one-time code.
 * Everything it reports was visible on a page that a visitor could have loaded.
 *
 * What it produces is a `CeremonyPlan` — the steps, what each needs first, the
 * data a caller has to be able to supply, and the different ways through. What
 * it cannot settle by reading, it says so in `uncertain` rather than guessing,
 * because a plan that looks confident about something nobody checked is worse
 * than one that admits the gap.
 */

/** A model may name a page discovery's own rules cannot. It is never required. */
export type PageClassification = {
  kind: PlanStep["kind"];
  label: string;
  humanReason?: PlanStep["humanReason"];
};
export type CeremonyClassifier = (input: {
  goal: CeremonyGoal;
  snapshot: PageSnapshot;
}) => Promise<PageClassification | undefined>;

export type DiscoveryOptions = {
  page: CeremonyPage;
  entryUrl: string;
  goal: CeremonyGoal;
  /** Origins discovery may read. It stops rather than leaving them. */
  allowedOrigins: readonly string[];
  /** Optional inference for a page the shape rules cannot name. */
  classifier?: CeremonyClassifier;
  /** Pages to load at most. Discovery is bounded, never exhaustive. */
  maxPages?: number;
  /** Links to follow deep at most, counted from the entry page. */
  maxDepth?: number;
  id?: string;
  title?: string;
};

export type DiscoveryResult = {
  plan: CeremonyPlan;
  /**
   * What reading alone could not settle. Each entry is a sentence a person can
   * act on, not a code.
   */
  uncertain: readonly string[];
  /** Pages actually loaded, in order, as origin+pathname. */
  visited: readonly string[];
};

/* -------------------------------------------------------------------------- */
/* Reading a page                                                             */
/* -------------------------------------------------------------------------- */

const rolePatterns = {
  confirmPassword: /confirm|repeat|again|verify your password/i,
  email: /e-?mail/i,
  identifier: /user\s?name|\blogin\b|\baccount\b|\bidentifier\b|\bhandle\b/i,
  displayName:
    /display name|your name|full name|application name|token name|key name/i,
  birthDate: /birth|birthday/i,
  verification: /confirmation code|verification code|digit code|\bcode\b/i,
  totp: /authenticator|two-factor|one-time|2fa/i,
  userCode: /device code|user code|code shown/i,
} as const;

const describe = (element: SnapshotElement) =>
  `${element.label ?? ""} ${element.placeholder ?? ""} ${element.name ?? ""}`;

/**
 * Name what a field is asking for.
 *
 * Discovery has to be able to say what a ceremony needs without a model in the
 * loop — a plan that only exists when inference is available is not a plan you
 * can rely on. A classifier can refine a page's kind, never rename its data.
 */
export function inferRole(
  element: SnapshotElement,
  page: readonly SnapshotElement[],
): CeremonyRole | undefined {
  if (element.kind !== "input" && element.kind !== "select") return undefined;
  const text = describe(element);
  if (element.type === "password") {
    if (rolePatterns.confirmPassword.test(text)) return "password-confirm";
    const passwords = page.filter((other) => other.type === "password");
    // Position decides only when nothing else does. A page is free to put the
    // confirmation box first, and then the other box is the password however
    // late it appears — reading the second box as the confirmation regardless
    // would make both of them the confirmation and neither the password.
    const named = passwords.some((other) =>
      rolePatterns.confirmPassword.test(describe(other)),
    );
    if (!named && passwords.length > 1 && passwords[1]?.index === element.index)
      return "password-confirm";
    return "password";
  }
  if (rolePatterns.totp.test(text)) return "totp-code";
  if (rolePatterns.userCode.test(text)) return "user-code";
  if (rolePatterns.verification.test(text)) return "verification-code";
  if (element.type === "email" || rolePatterns.email.test(text)) return "email";
  if (element.type === "date" || rolePatterns.birthDate.test(text))
    return "birth-date";
  if (rolePatterns.displayName.test(text)) return "display-name";
  if (rolePatterns.identifier.test(text)) return "username";
  return undefined;
}

/** Roles whose value arrives out of band rather than from the caller's hand. */
const outOfBandRoles: readonly CeremonyRole[] = [
  "verification-code",
  "totp-code",
  "user-code",
];

const secretRolesForPlan: readonly CeremonyRole[] = [
  "password",
  "password-confirm",
  "verification-code",
  "totp-code",
];

/**
 * Links worth following: they lead to another way in. A link that *does*
 * something — sends mail, revokes, signs out — is never followed, because
 * discovery must not cause an effect.
 */
const followable =
  /sign\s?in|log\s?in|sign\s?up|regist|create an?\s|passkey|security key|another way|different|instead|forgot|reset|recover/i;
const destructive =
  /resend|send|delete|remove|revoke|cancel|sign\s?out|log\s?out|deactivate|close account|unsubscribe/i;

function isFollowable(element: SnapshotElement): boolean {
  if (element.kind !== "link") return false;
  const text = element.text ?? "";
  if (!text.trim() || destructive.test(text)) return false;
  return followable.test(text);
}

/** What kind of step this page is, from its shape alone. */
function classifyByShape(snapshot: PageSnapshot): PageClassification {
  const fields = snapshot.elements.filter(
    (element) => element.kind === "input" || element.kind === "select",
  );
  const heading = snapshot.headings[0] ?? snapshot.title;
  if (snapshot.challenge)
    return {
      kind: "human",
      label: heading || "Clear the security check",
      humanReason: "challenge",
    };
  if (snapshot.passkey && !fields.some((field) => field.type === "password"))
    return {
      kind: "human",
      label: heading || "Use the platform authenticator",
      humanReason: "passkey",
    };
  if (fields.length > 0)
    return { kind: "form", label: heading || "Complete the form" };
  const buttons = snapshot.elements.filter(
    (element) => element.kind === "button",
  );
  if (buttons.length > 1)
    return { kind: "decision", label: heading || "Approve or refuse" };
  return { kind: "navigate", label: heading || "Continue" };
}

/* -------------------------------------------------------------------------- */
/* Walking the provider                                                       */
/* -------------------------------------------------------------------------- */

/** A route is the link captions clicked from the entry page, in order. */
type Route = readonly string[];

type Observed = {
  id: string;
  route: Route;
  snapshot: PageSnapshot;
  classification: PageClassification;
  /** Pages this one redirected through to get here, outermost first. */
  redirectedFrom: readonly string[];
};

function identifierFor(path: string, taken: Set<string>): string {
  const tail =
    new URL(path).pathname
      .split("/")
      .filter(Boolean)
      .join("-")
      .replace(/[^a-zA-Z0-9_.:-]/g, "") || "entry";
  const base = /^[a-zA-Z]/.test(tail) ? tail : `page-${tail}`;
  let id = base.slice(0, 90);
  let n = 2;
  while (taken.has(id)) id = `${base.slice(0, 86)}-${n++}`;
  taken.add(id);
  return id;
}

const originOf = (url: string) => new URL(url).origin;

/* -------------------------------------------------------------------------- */
/* Discovery                                                                  */
/* -------------------------------------------------------------------------- */

export async function discoverCeremony(
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const {
    page,
    entryUrl,
    goal,
    allowedOrigins,
    classifier,
    maxPages = 12,
    maxDepth = 2,
  } = options;
  const allowed = new Set(allowedOrigins.map((origin) => originOf(origin)));
  const uncertain: string[] = [];
  const visited: string[] = [];
  const observations: Observed[] = [];
  const takenIds = new Set<string>();
  const seenPaths = new Set<string>();

  /** Replay a route from the entry page. Only links are ever clicked. */
  const walk = async (route: Route): Promise<PageSnapshot | undefined> => {
    await page.goto(entryUrl);
    await page.settle();
    for (const caption of route) {
      const snapshot = await page.snapshot();
      const target = snapshot.elements.find(
        (element) => element.kind === "link" && element.text === caption,
      );
      if (!target) return undefined;
      await page.click(target);
      await page.settle();
    }
    return page.snapshot();
  };

  const queue: Route[] = [[]];
  const extended = new Set<string>();
  while (queue.length > 0 && visited.length < maxPages) {
    const route = queue.shift()!;
    const snapshot = await walk(route);
    if (!snapshot) {
      uncertain.push(
        `A link named "${route.at(-1)}" was not on the page the second time, so that branch was not explored.`,
      );
      continue;
    }
    const landed = await page.url();
    if (!allowed.has(originOf(landed))) {
      uncertain.push(
        `Following "${route.at(-1)}" left the origins discovery was permitted to read, so where it leads is unknown.`,
      );
      continue;
    }
    // The entry page redirecting elsewhere is the provider saying something has
    // to happen first. That is a prerequisite, and it is observable for free.
    const redirectedFrom =
      route.length === 0 && originOf(landed) === originOf(entryUrl)
        ? redirectChain(entryUrl, snapshot.path)
        : [];

    if (seenPaths.has(snapshot.path)) continue;
    seenPaths.add(snapshot.path);
    visited.push(snapshot.path);

    const classification =
      (await classifier?.({ goal, snapshot }).catch(() => undefined)) ??
      classifyByShape(snapshot);
    observations.push({
      id: identifierFor(snapshot.path, takenIds),
      route,
      snapshot,
      classification,
      redirectedFrom,
    });

    if (route.length >= maxDepth) continue;
    for (const element of snapshot.elements) {
      if (!isFollowable(element) || !element.text) continue;
      const next = [...route, element.text];
      const key = next.join(" > ");
      if (extended.has(key)) continue;
      extended.add(key);
      queue.push(next);
    }
  }

  if (observations.length === 0)
    throw new Error("Discovery read no page it was permitted to read");

  return {
    ...buildPlan(observations, { ...options, goal }, uncertain),
    uncertain,
    visited,
  };
}

/** A redirect away from the requested path is recorded as one hop. */
function redirectChain(requested: string, landed: string): readonly string[] {
  const from = new URL(requested);
  const to = new URL(landed);
  return from.pathname === to.pathname ? [] : [from.pathname];
}

/* -------------------------------------------------------------------------- */
/* Turning observations into a plan                                           */
/* -------------------------------------------------------------------------- */

function buildPlan(
  observations: readonly Observed[],
  options: DiscoveryOptions,
  uncertain: string[],
): { plan: CeremonyPlan } {
  const steps: PlanStep[] = [];
  const data: Record<string, PlanDatum> = {};
  /** Step ids each observation contributes, in the order they must run. */
  const chainOf = new Map<string, string[]>();

  for (const observed of observations) {
    const { snapshot, classification } = observed;
    const uses: string[] = [];
    const chain: string[] = [];

    const roles = new Map<CeremonyRole, string>();
    for (const element of snapshot.elements) {
      const role = inferRole(element, snapshot.elements);
      if (!role || roles.has(role)) continue;
      const key = role.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      roles.set(role, key);
      uses.push(key);
      data[key] ??= {
        role,
        secret: secretRolesForPlan.includes(role),
        source: { from: "caller" },
        always: false,
      };
    }

    // A field asking for a code the provider sent means a step happened that
    // discovery never triggered: something delivered it. Naming that step is
    // what makes the plan runnable, and it is inferred, not observed.
    for (const [role, key] of roles) {
      if (!outOfBandRoles.includes(role)) continue;
      const producerId = `${observed.id}-delivery`;
      if (!steps.some((step) => step.id === producerId)) {
        steps.push({
          id: producerId,
          kind: "out-of-band",
          label: `Read the ${role.replace(/-/g, " ")} the provider sent`,
          needs: [],
          uses: [],
          produces: [key],
        });
        uncertain.push(
          `The ${role.replace(/-/g, " ")} on ${new URL(snapshot.path).pathname} arrives out of band; discovery did not trigger a send, so how it is delivered is not confirmed.`,
        );
      }
      data[key] = {
        ...data[key]!,
        source: { from: "step", step: producerId },
      };
      chain.push(producerId);
    }

    const step: PlanStep = {
      id: observed.id,
      kind: classification.kind,
      label: classification.label.slice(0, 120),
      at: snapshot.path,
      needs: [...chain],
      uses,
      produces: [],
      ...(classification.humanReason
        ? { humanReason: classification.humanReason }
        : {}),
    };
    steps.push(step);
    chain.push(observed.id);
    chainOf.set(observed.id, chain);

    for (const hop of observed.redirectedFrom)
      uncertain.push(
        `${hop} redirected to ${new URL(snapshot.path).pathname}, so that page is reached only after this one.`,
      );
  }

  // Every observation reached by following links from the entry page is its own
  // way through. The entry page is on all of them.
  const entry = observations[0]!;
  const branches = observations.filter(
    (observed) => observed.route.length > 0 && observed.id !== entry.id,
  );
  const entryChain = chainOf.get(entry.id)!;
  const routes: { id: string; label: string; chain: string[] }[] = [];
  // Staying on the entry page is itself a way through when there is something
  // to do there. A page that only forwards you somewhere is not.
  if (entry.classification.kind !== "navigate")
    routes.push({
      id: "direct",
      label: entry.classification.label.slice(0, 120),
      chain: entryChain,
    });
  for (const observed of branches)
    routes.push({
      id: `via-${observed.id}`.slice(0, 96),
      label:
        `${entry.classification.label} → ${observed.route.join(" → ")}`.slice(
          0,
          120,
        ),
      chain: [...entryChain, ...chainOf.get(observed.id)!],
    });
  if (routes.length === 0)
    routes.push({
      id: "direct",
      label: entry.classification.label.slice(0, 120),
      chain: entryChain,
    });
  routes.splice(PLAN_LIMITS.paths);

  const used = new Set(routes.flatMap((route) => route.chain));
  const keptSteps = steps.filter((step) => used.has(step.id));
  const keptData = Object.fromEntries(
    Object.entries(data).filter(([key]) =>
      keptSteps.some((step) => step.uses.includes(key)),
    ),
  );
  // A step may only require what every route that runs it also runs first.
  const byId = new Map(keptSteps.map((step) => [step.id, step]));
  for (const step of keptSteps)
    step.needs = step.needs.filter((need) =>
      routes
        .filter((route) => route.chain.includes(step.id))
        .every(
          (route) =>
            route.chain.indexOf(need) !== -1 &&
            route.chain.indexOf(need) < route.chain.indexOf(step.id),
        ),
    );

  const paths: PlanPath[] = routes.map((route) => {
    const chain = route.chain.filter((id) => byId.has(id));
    return {
      id: route.id,
      label: route.label,
      steps: chain,
      handoffs: chain.filter((id) => byId.get(id)?.kind === "human").length,
      when: [],
    };
  });

  for (const [key, datum] of Object.entries(keptData))
    keptData[key] = {
      ...datum,
      always: paths.every((path) =>
        path.steps.some((id) => byId.get(id)?.uses.includes(key)),
      ),
    };

  const plan = ceremonyPlanSchema.parse({
    schemaVersion: 1,
    id: options.id ?? "discovered",
    title: options.title ?? `Discovered ${options.goal} ceremony`,
    goal: options.goal,
    origin: originOf(options.entryUrl),
    data: keptData,
    steps: keptSteps,
    paths,
  } satisfies CeremonyPlan);
  return { plan };
}
