import {
  actionsFor,
  fieldsFor,
  type CeremonyAction,
  type CeremonySnapshot,
  type CeremonyTransport,
  type ConnectorManifest,
  type FlowKind,
  type Step,
} from "../../src/core/index.js";

/**
 * An in-page transport for the showcase.
 *
 * The components, manifests, templates and snapshot schema are the real ones;
 * only the thing behind them is not. Every snapshot below is parsed by the
 * production `snapshotSchema` before the UI accepts it, so a shape the server
 * could not produce fails here too.
 *
 * Nothing is persisted, no provider is contacted, and no credential leaves the
 * tab it was typed into.
 */

const TEN_MINUTES = 10 * 60 * 1000;

function afterBegin(kind: FlowKind): Step {
  if (kind === "oauth-code" || kind === "github-app") return "redirect";
  if (kind === "device") return "waiting";
  if (kind === "authmd-anonymous") return "anonymous";
  return "input";
}

/** What the product's own notice slot should say about a run with no provider. */
function standingNotice(step: Step, secret: boolean): string | undefined {
  if (step === "complete")
    return "Nothing was connected. This walkthrough has no provider behind it.";
  if (step === "input" && secret)
    return "Nothing typed here is sent anywhere or kept — use made-up values, not a password you rely on.";
  return undefined;
}

interface Attempt {
  snapshot: CeremonySnapshot;
  manifest: ConnectorManifest;
  anonymous: boolean;
  claimed: boolean;
}

export interface Waiting {
  id: string;
  service: string;
  method: string;
  userCode?: string;
}

export function createShowcaseTransport(
  manifests: readonly ConnectorManifest[],
  announce: (waiting: Waiting[]) => void,
) {
  const live = new Map<string, Attempt>();
  let next = 1;

  const build = (
    attempt: Omit<Attempt, "snapshot">,
    methodId: string,
    step: Step,
    id: string,
    revision: number,
    message?: string,
  ): CeremonySnapshot => {
    const { manifest, anonymous, claimed } = attempt;
    const method =
      manifest.methods.find((entry) => entry.id === methodId) ??
      manifest.methods[0]!;
    const fields = fieldsFor(step, method);
    const notice =
      message ??
      standingNotice(
        step,
        fields.some((field) => field.type === "password"),
      );
    return {
      id,
      revision,
      connectorId: manifest.id,
      connectorName: manifest.name,
      description: manifest.description,
      method,
      step,
      fields,
      actions: actionsFor(step, anonymous && !claimed),
      expiresAt: Date.now() + TEN_MINUTES,
      ...(notice ? { message: notice } : {}),
      ...(step === "redirect"
        ? {
            authorizationUrl: `https://provider.example/authorize?connector=${manifest.id}`,
            // A live prerequisite is why the client keeps polling: the provider,
            // not this page, is what finishes a redirect.
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
              connectionRef: `demo-${id}`,
              ownership: anonymous
                ? claimed
                  ? ("claimed" as const)
                  : ("anonymous" as const)
                : ("authenticated" as const),
              scopes: method.scopes,
            },
            prerequisites: [
              {
                id: "prepare",
                label: "Prepare the integration",
                status: "succeeded" as const,
              },
              {
                id: "approve",
                label: "Approve access",
                status: "succeeded" as const,
              },
              {
                id: "verify",
                label: "Verify the granted access",
                status: "succeeded" as const,
              },
            ],
          }
        : {}),
    };
  };

  const publish = () => {
    announce(
      [...live.values()]
        .filter(({ snapshot }) =>
          ["redirect", "waiting"].includes(snapshot.step),
        )
        .map(({ snapshot, manifest }) => ({
          id: snapshot.id,
          service: manifest.name,
          method: snapshot.method.label,
          ...(snapshot.userCode ? { userCode: snapshot.userCode } : {}),
        })),
    );
  };

  const put = (attempt: Attempt) => {
    live.set(attempt.snapshot.id, attempt);
    publish();
    return attempt.snapshot;
  };

  const move = (attempt: Attempt, step: Step, message?: string) => {
    const claimed = attempt.claimed || attempt.snapshot.step === "claim";
    const carried = { ...attempt, claimed };
    return put({
      ...carried,
      snapshot: build(
        carried,
        attempt.snapshot.method.id,
        step,
        attempt.snapshot.id,
        attempt.snapshot.revision + 1,
        message,
      ),
    });
  };

  const advance = (
    attempt: Attempt,
    action: CeremonyAction["action"],
  ): Step => {
    const { step, method } = attempt.snapshot;
    switch (action) {
      case "cancel":
        return "cancelled";
      case "retry":
        return "intro";
      case "begin":
        return afterBegin(method.kind);
      case "submit":
      case "finish":
        return "complete";
      case "claim":
        return "claim";
      default:
        return step;
    }
  };

  const transport: CeremonyTransport = {
    start: async (connectorId, methodId) => {
      const manifest = manifests.find((entry) => entry.id === connectorId);
      if (!manifest) throw new Error("Unknown connector.");
      const method =
        manifest.methods.find((entry) => entry.id === methodId) ??
        manifest.methods[0]!;
      const anonymous =
        method.contract?.completion.ownership.includes("anonymous") ?? false;
      const id = `demo-${next++}`;
      const attempt = { manifest, anonymous, claimed: false };
      return put({
        ...attempt,
        snapshot: build(attempt, method.id, "intro", id, 0),
      });
    },
    read: async (id) => {
      const attempt = live.get(id);
      if (!attempt) throw new Error("This attempt is no longer available.");
      return attempt.snapshot;
    },
    act: async (id, action) => {
      const attempt = live.get(id);
      if (!attempt) throw new Error("This attempt is no longer available.");
      if (action.revision !== attempt.snapshot.revision)
        throw new Error("This screen is out of date. Refresh status.");
      return move(attempt, advance(attempt, action.action));
    },
  };

  /** What the provider's own surface would do, reached from the panel beside it. */
  const provider = {
    approve: (id: string) => {
      const attempt = live.get(id);
      if (attempt) move(attempt, "complete");
    },
    refuse: (id: string) => {
      const attempt = live.get(id);
      if (attempt)
        move(attempt, "error", `${attempt.manifest.name} refused the request.`);
    },
  };

  return { transport, provider };
}
