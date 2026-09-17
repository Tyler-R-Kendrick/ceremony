import {
  admittedCatalogOrigin,
  executableProfile,
  type CatalogSequence,
} from "./catalog.js";
import { matchTemplate, type Observation, type Step } from "./templates.js";

export type InitialSelection = {
  kind: "combined" | "identifier";
  sequence: CatalogSequence;
  step: Step;
};

/** Select an alternative, not a concatenation of every supported login shape.
 * runStartOrigin must come from trusted run approval, not the current page.
 * This function proposes a step only; it does not authorize a submission.
 */
export function selectInitialStep(
  profileId: string,
  runStartOrigin: string,
  page: Observation,
): InitialSelection | undefined {
  try {
    const profile = executableProfile(profileId, runStartOrigin);
    if (!profile) return;
    admittedCatalogOrigin(profileId, page.origin, runStartOrigin);
    const step = matchTemplate(page);
    if (!step || !step.mapping.identifier) return;
    const kind = step.mapping.password ? "combined" : "identifier";
    const sequence = profile.sequences.find(
      (candidate) => candidate[0] === kind,
    );
    if (!sequence) return;
    return { kind, sequence, step };
  } catch {
    return;
  }
}
