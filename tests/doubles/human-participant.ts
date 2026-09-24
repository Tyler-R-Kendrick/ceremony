import {
  checkboxConsent,
  deviceVerificationField,
} from "../../src/core/browser-contracts.js";
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
  /**
   * The code a person reads off the device they are connecting, for a device
   * verification page. A function, because the device shows it only once the
   * flow has started.
   */
  userCode?: () => string | undefined;
  /** What a person picks in a choice the plan left to them, by field label. */
  choices?: Readonly<Record<string, string>>;
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
        //
        // The address comes from the page, not from the request. A person
        // acting in the browser is holding the browser, so it can be asked;
        // the request carries origin and pathname precisely so that the one
        // thing hosts display and log is not a URL with a code in it.
        if (!options.credentials || !page.authenticate) return "unavailable";
        const here = await page.url();
        await page.authenticate(here, options.credentials);
        await page.goto(here);
        return "completed";
      }

      // Everything else is done on the page itself: satisfy the widget, then
      // press whatever it offers to continue.
      const snapshot = await page.snapshot();

      // A person holding the device types the code it shows, then continues.
      // The agent was never given the code; it is the person's to enter.
      if (request.reason === "device-code") {
        const field = deviceVerificationField(snapshot);
        const code = options.userCode?.();
        if (!field || !code) return "unavailable";
        await page.fill(field, code);
      }
      // A person makes the choice the plan left open, and leaves the rest of
      // the form to the agent: the choice is theirs, the typing is not.
      if (request.reason === "choice") {
        if (!page.select) return "unavailable";
        let chose = false;
        for (const element of snapshot.elements) {
          if (element.kind !== "select" || element.filled) continue;
          const option =
            element.label === undefined
              ? undefined
              : options.choices?.[element.label];
          if (option === undefined) continue;
          await page.select(element, option);
          chose = true;
        }
        return chose ? "completed" : "unavailable";
      }
      // A person reads the terms they were asked about and ticks them
      // themselves - that tick is theirs, which is the whole point of asking.
      // The newsletter stays as they found it, and the agent submits.
      if (request.reason === "consent") {
        let ticked = false;
        for (const element of snapshot.elements) {
          if (element.kind !== "checkbox" || element.filled) continue;
          const consent = checkboxConsent(element);
          if (consent.marketing || consent.kinds.length === 0) continue;
          await page.check(element);
          ticked = true;
        }
        return ticked ? "completed" : "unavailable";
      }

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
