import type {
  CeremonyPage,
  HumanParticipation,
  HumanParticipationRequest,
  HumanParticipationResult,
} from "../../src/server/browser-driver.js";

/**
 * A person taking part in a ceremony, as a test double.
 *
 * The point of a handoff is that someone acts in the browser the agent was
 * already using: they clear the widget, approve the prompt, or answer the
 * dialog, and the agent picks up where the page now is. This double does
 * exactly that — it drives the same `CeremonyPage`, which is what
 * `surface: "provider-browser"` means in the handoff contract.
 *
 * What it deliberately does not do is grant anything. It returns a claim, and
 * the driver still has to re-read the page and verify with the provider, so a
 * test cannot pass merely because a person said they were finished.
 */

export type HumanParticipantOptions = {
  /** Refuse to take part, exercising the DECLINE path. */
  decline?: boolean;
  /** Nobody can be reached, exercising the own-browser-unavailable path. */
  unavailable?: boolean;
  /** Claim completion without doing anything, to prove a claim is not a grant. */
  claimOnly?: boolean;
  /** Credentials a person types into a browser dialog the agent cannot reach. */
  credentials?: { username: string; password: string };
  maxRequests?: number;
  /** Every request made, for asserting what the host was actually asked. */
  onRequest?: (request: HumanParticipationRequest) => void;
};

const completionPatterns = [
  /not a robot|i am human|verify|continue|submit|confirm/i,
  /approve|allow|authorize|grant/i,
];

export function createHumanParticipant(
  page: CeremonyPage,
  options: HumanParticipantOptions = {},
): HumanParticipation & { requests(): readonly HumanParticipationRequest[] } {
  const requests: HumanParticipationRequest[] = [];
  return {
    contract: {
      surface: "provider-browser",
      recipient: "initiating-subject",
      delegation: "a2h-authorize",
      resume: "verify",
    },
    ...(options.maxRequests === undefined
      ? {}
      : { maxRequests: options.maxRequests }),
    requests: () => [...requests],
    request: async (
      request: HumanParticipationRequest,
    ): Promise<HumanParticipationResult> => {
      requests.push(request);
      options.onRequest?.(request);
      if (options.decline) return "declined";
      if (options.unavailable) return "unavailable";
      if (options.claimOnly) return "completed";

      if (request.reason === "native-dialog") {
        // A browser dialog has no page to fill. The person answers it, which
        // leaves the credentials with the browser; the agent then resumes at
        // whatever the provider serves, never holding the values itself.
        if (!options.credentials || !page.authenticate) return "unavailable";
        await page.authenticate(request.url, options.credentials);
        await page.goto(request.url);
        return "completed";
      }

      // Everything else is done on the page itself: satisfy the widget, then
      // press whatever it offers to continue.
      const snapshot = await page.snapshot();
      const control = snapshot.elements.find(
        (element) =>
          element.kind === "button" &&
          completionPatterns.some((pattern) =>
            pattern.test(
              [element.text, element.label].filter(Boolean).join(" "),
            ),
          ),
      );
      if (!control) return "unavailable";
      await page.click(control);
      await page.settle();
      return "completed";
    },
  };
}
