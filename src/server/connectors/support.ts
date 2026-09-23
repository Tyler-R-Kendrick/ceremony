import {
  computeSupportLabel,
  parseSupportEvidence,
  supportEvidenceSchema,
  supportLabelAtLeast,
  supportLabelSchema,
  type SupportEvidence,
  type SupportLabel,
  type SupportLabelResult,
} from "../../core/connectors/index.js";
import type { ApprovedDestination } from "./binding.js";
import { ConnectorError } from "./errors.js";
import type { Clock } from "./ports.js";
import { recordedSupportEvidence } from "./recorded-evidence.js";

/*
 * The runtime half of evidence-derived support labels.
 *
 * The rules live in `supportLabelRules` (core); this module only decides
 * which entries a deployment evaluates and what, if anything, a label gates.
 *
 * Which entries. By default, the entries this repository recorded in its
 * ledgers, as generated into `recorded-evidence.ts` by
 * `scripts/connector-support-matrix.ts`. Those are about the adapter code,
 * which is what a deployment runs, and none of them is live: a label above
 * `local` needs an entry the host supplies itself, for instance from its own
 * attended certification. Host entries are validated when the service is
 * built, against the service's clock, so a malformed or future-dated entry
 * stops the deployment from starting rather than quietly earning a label.
 *
 * What it gates. Nothing, unless the host opts in. A label is information
 * for a person or an assistant choosing a connector; turning it into a
 * refusal is a policy decision a deployment makes deliberately, with
 * `minimumForProduction`. When set, a binding that can reach anything other
 * than a loopback fixture needs an adapter label at least that strong, and
 * this is rechecked at approval, at connect and at every invocation, because
 * evidence expires between them. A binding with no destinations at all is
 * treated as production: the gate fails closed, never open.
 */

export interface SupportLabelOptions {
  /** Entries beyond the recorded ones: a host's own live runs or attended certifications. */
  evidence?: readonly unknown[];
  /** Whether the repository's recorded entries are evaluated too. Default true. */
  recorded?: boolean;
  /**
   * Opt-in host policy: the weakest label a production binding's adapter may
   * have. Absent means labels are shown but gate nothing.
   */
  minimumForProduction?: SupportLabel;
}

export interface SupportLabeler {
  readonly minimumForProduction?: SupportLabel;
  /** The label and its basis for one adapter, as of now. */
  describe(adapterId: string, configured: boolean): SupportLabelResult;
  label(adapterId: string, configured: boolean): SupportLabel;
  /** Whether a binding with these destinations is subject to the production minimum. */
  isProduction(destinations: readonly ApprovedDestination[]): boolean;
  /** Throws `denied` when the opt-in minimum applies and the adapter's label is below it. */
  require(
    adapterId: string,
    destinations: readonly ApprovedDestination[],
    configured: boolean,
  ): void;
}

export function createSupportLabeler(
  options: SupportLabelOptions & { now: Clock },
): SupportLabeler {
  const minimum =
    options.minimumForProduction === undefined
      ? undefined
      : supportLabelSchema.parse(options.minimumForProduction);
  // The recorded entries were validated when they were generated, against
  // the day they were recorded; a test clock set before that day must not
  // turn them into a startup failure. They are still parsed here so an edited
  // module cannot smuggle in a shape the rules do not know.
  const recorded: SupportEvidence[] =
    options.recorded === false
      ? []
      : recordedSupportEvidence.map((entry) =>
          supportEvidenceSchema.parse(entry),
        );
  const host = parseSupportEvidence(options.evidence ?? [], {
    asOf: options.now(),
  });
  const entries = [...recorded, ...host];
  const describe = (adapterId: string, configured: boolean) =>
    computeSupportLabel(adapterId, entries, {
      asOf: options.now(),
      configured,
    });
  const isProduction = (destinations: readonly ApprovedDestination[]) =>
    destinations.length === 0 ||
    destinations.some(
      (destination) => destination.network !== "loopback-fixture",
    );
  return {
    ...(minimum ? { minimumForProduction: minimum } : {}),
    describe,
    label: (adapterId, configured) => describe(adapterId, configured).label,
    isProduction,
    require(adapterId, destinations, configured) {
      if (!minimum || !isProduction(destinations)) return;
      if (!supportLabelAtLeast(describe(adapterId, configured).label, minimum))
        throw new ConnectorError("denied", {
          detail: "support.below-minimum",
        });
    },
  };
}
