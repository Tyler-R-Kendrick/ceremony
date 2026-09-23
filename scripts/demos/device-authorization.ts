import { deviceVerificationField } from "../../src/core/browser-contracts.js";
import {
  createSecrets,
  runCeremony,
  type CeremonyResult,
  type HumanParticipationRequest,
} from "../../src/server/browser-driver.js";
import {
  createHeuristicInterpreter,
  type CeremonyInterpreter,
} from "../../src/server/browser-interpreter.js";
import { generateIsolatedAccount } from "../../src/server/browser-executor.js";
import { createHumanParticipant } from "../../tests/doubles/human-participant.js";
import { createIdentity } from "../../tests/doubles/auth-provider/scenarios.js";
import {
  startAuthProvider,
  type ProviderDouble,
} from "../../tests/doubles/auth-provider/server.js";
import { caption, productNames, type Phase } from "./captions.js";
import {
  deviceScreen,
  startDevice,
  type DeviceScreen,
  type SimulatedDevice,
} from "./device.js";
import type { DemoSession } from "./harness.js";
import { pathnameOf } from "./phases.js";
import { disclosure, outcomeFacts } from "./story.js";

/**
 * Device authorization (RFC 8628), end to end.
 *
 * A simulated command-line tool asks the provider to be authorized and shows
 * a user code, as a TV or a CLI does. The agent opens the verification page
 * with nothing but the plan: it signs in, types the user code *because the
 * plan supplies it*, and approves the consent screen naming the device's
 * client. The device's own poll of the token endpoint is the evidence: the
 * run is verified only once that poll is answered with a token for the
 * person's account.
 *
 * The second segment is the same page with no code in the plan. The
 * heuristic reports the wall instead of guessing a value into the field; the
 * driver checks that the page really is a device verification page and asks
 * a person, naming the page by origin and path only. The person reads the
 * code off the device and types it, and the agent carries on from the
 * consent screen.
 *
 * The provider is the self-hosted double, "Acme Accounts" in its
 * identifier-first layout; the device and its product name are invented.
 */
export async function record(session: DemoSession) {
  const identity = createIdentity();
  const password = generateIsolatedAccount().password;
  session.protect(password);
  const provider = await startAuthProvider({
    seed: 54,
    layout: session.entry.layout,
    accounts: [
      {
        email: identity.email,
        username: identity.username,
        password,
        verified: true,
      },
    ],
  });
  const product = productNames[session.entry.layout] ?? "test provider";
  const devices: SimulatedDevice[] = [];
  try {
    // The device asks while the title card is up; its screens are drawn off
    // camera before they are needed.
    const first = prepareDevice(session, provider, product, "first");
    await session.card(
      {
        title: session.entry.title,
        lines: [
          session.entry.summary,
          ...disclosure(session.entry, provider.markup.seed),
          "The device on the left is simulated: an invented command-line tool that calls the provider's device authorization and token endpoints over HTTP.",
        ],
      },
      11_000,
    );
    const device = await first;
    devices.push(device.device);

    // Segment 1: the plan holds the code the device shows.
    session.step("device-request");
    device.show("requested");
    session.say({ kind: "device", stage: "requested" });
    await session.card(
      {
        title: "A device asks to be authorized",
        tone: "device",
        keepPanel: true,
        lines: [
          `${device.device.name} called ${product}'s device authorization endpoint and printed a user code and a verification URL.`,
          "It now polls the token endpoint and is told to keep waiting until a person approves it.",
          "The agent's plan was given the same user code. The agent types it only because the plan supplies it.",
        ],
      },
      7_000,
    );
    await session.page.goto(device.device.verificationUri, {
      waitUntil: "domcontentloaded",
    });
    const planned = await drive(session, provider, device, {
      secrets: createSecrets({
        email: identity.email,
        password,
        "user-code": device.device.userCode,
      }),
      password,
      account: identity.email,
    });
    const firstConnected = planned.connectedAs === identity.email;
    device.hide();
    await session.card(
      {
        title: firstConnected
          ? "The device is connected to the person's account"
          : "The device was not connected",
        tone: "result",
        lines: [
          ...outcomeFacts(planned.result),
          ...(firstConnected
            ? [
                "Sign in → device code (from the plan) → consent → the device's next poll returned an access token.",
                caption({ kind: "device", stage: "connected" }),
                "Verified by the device's own token poll and the provider's userinfo, not by the page saying so.",
              ]
            : []),
        ],
      },
      7_000,
    );

    // Segment 2: the same page, no code in the plan.
    const second = prepareDevice(session, provider, product, "second");
    await session.card(
      {
        title: "Same page, no code in the plan",
        tone: "intro",
        lines: [
          "A second device asks to be authorized. This time the plan holds the person's sign-in but not the device's code.",
          "The browser starts empty, and the agent opens the device's complete link, the one with the code in its query.",
          "The page does not read the code from the link, and the agent does not guess one. The driver asks a person.",
        ],
      },
      8_000,
    );
    const other = await second;
    devices.push(other.device);
    await session.page.context().clearCookies();
    await session.page.goto(other.device.verificationUriComplete, {
      waitUntil: "domcontentloaded",
    });
    session.step("device-request");
    other.show("requested");
    session.say({ kind: "device", stage: "requested" });
    await session.hold(3_000);
    const requests: HumanParticipationRequest[] = [];
    const person = createHumanParticipant(session.ceremonyPage(), {
      userCode: () => other.device.userCode,
      onRequest: (request) => {
        requests.push(request);
      },
    });
    const handed = await drive(session, provider, other, {
      secrets: createSecrets({ email: identity.email, password }),
      password,
      account: identity.email,
      human: {
        ...person,
        request: async (request) => {
          session.step("device-code");
          session.say({ kind: "decision", what: "no-code-hand-off" });
          await session.hold(2_400);
          session.say({ kind: "handoff", what: "device-code" });
          await session.hold(2_000);
          session.say({
            kind: "fill",
            actor: "person",
            role: "user-code",
            source: "device-screen",
          });
          return person.request(request);
        },
      },
    });
    const secondConnected = handed.connectedAs === identity.email;
    const request = requests[0];
    other.hide();
    const queryDropped =
      request !== undefined &&
      request.reason === "device-code" &&
      request.path === `${provider.origin}/device`;
    const ok = firstConnected && secondConnected && queryDropped;
    await session.card(
      {
        title: ok
          ? "A person entered the code; the agent did the rest"
          : "The hand-off run did not finish",
        tone: "result",
        lines: [
          ...outcomeFacts(handed.result),
          ...(request
            ? [
                `What the host was asked: reason "${request.reason}", page ${request.path}. The code in the link's query was dropped.`,
              ]
            : []),
          ...(ok
            ? [
                "The agent never typed a value it was not given: the person read the code off the device.",
                caption({ kind: "device", stage: "connected" }),
              ]
            : []),
        ],
      },
      8_000,
    );
    return { ok, result: handed.result };
  } finally {
    for (const device of devices) device.stop();
    await provider.close();
  }
}

/**
 * Ask for device authorization and draw the device's screens, off camera.
 * `show` puts a screen beside the page; the device's own polls move it on.
 */
async function prepareDevice(
  session: DemoSession,
  provider: ProviderDouble,
  product: string,
  label: string,
): Promise<{
  device: SimulatedDevice;
  show(screen: DeviceScreen): void;
  /** Take the device off camera, e.g. before a full-frame card. */
  hide(): void;
}> {
  let showing = false;
  let screen: DeviceScreen = "requested";
  const show = (next: DeviceScreen) => {
    // A connected device stays connected on screen.
    if (screen === "connected" && next !== "connected") next = screen;
    screen = next;
    showing = true;
    session.showProp(`${label}:${next}`, "left");
  };
  const device = await startDevice(provider, {
    protect: session.protect,
    // A poll that lands while the device is on camera updates its screen;
    // one that lands off camera is remembered for when it is shown.
    onScreen: (next) => {
      if (showing) show(next);
      else if (screen !== "connected") screen = next;
    },
  });
  const account = provider.accounts()[0]?.email;
  for (const state of ["requested", "polling", "connected"] as const) {
    const drawn = deviceScreen({ ...device, product }, state, account);
    await session.prop(`${label}:${state}`, drawn.html, drawn.text);
  }
  return {
    device,
    show,
    hide: () => {
      showing = false;
      session.showProp(undefined);
    },
  };
}

/**
 * One driver run at the verification page: sign in, then the device's code
 * (from the plan, or from a person), then consent. Verified by the device's
 * poll, which is the only thing that knows whether it was authorized.
 */
async function drive(
  session: DemoSession,
  provider: ProviderDouble,
  device: {
    device: SimulatedDevice;
    show(screen: DeviceScreen): void;
    hide(): void;
  },
  options: {
    secrets: ReturnType<typeof createSecrets>;
    password: string;
    account: string;
    human?: Parameters<typeof runCeremony>[0]["human"];
  },
): Promise<{ result: CeremonyResult; connectedAs: string | undefined }> {
  let consentPage = false;
  let signInSaid = false;
  let codeSaid = false;
  let consentShown = false;
  const narrated = session.narrate(createHeuristicInterpreter(), {
    sources: {
      email: "private-collector",
      password: "private-collector",
      "user-code": "plan",
    },
    phase: (previous, observed): Phase | undefined => {
      if (consentPage) return "consent";
      if (observed.role === "user-code") return "device-code";
      if (observed.pathname.startsWith("/signin")) return "sign-in";
      if (observed.pathname === "/device") return "device-code";
      return previous;
    },
  });
  const interpreter: CeremonyInterpreter = async (input) => {
    const path = pathnameOf(input.snapshot.path);
    consentPage = /^Authorize/.test(input.snapshot.title);
    if (!signInSaid && path.startsWith("/signin")) {
      signInSaid = true;
      session.step("sign-in");
      session.say({
        kind: "decision",
        what: "has-account-sign-in",
        layout: session.entry.layout,
      });
      await session.hold(2_000);
    }
    if (
      !codeSaid &&
      path === "/device" &&
      deviceVerificationField(input.snapshot) &&
      input.available.includes("user-code")
    ) {
      codeSaid = true;
      session.step("device-code");
      session.say({ kind: "decision", what: "code-in-plan" });
      await session.hold(2_400);
    }
    const atConsent = consentPage && !consentShown;
    if (atConsent) {
      session.step("consent");
      session.say({ kind: "provider", says: "device-consent" });
      await session.reveal();
      await session.hold(2_200);
    }
    const action = await narrated(input);
    if (atConsent) {
      consentShown = true;
      session.poster();
      await session.hold(1_200);
    }
    return action;
  };
  device.show("polling");
  const result = await runCeremony({
    page: session.ceremonyPage(),
    interpreter,
    goal: "sign-in",
    secrets: options.secrets,
    allowedOrigins: [provider.origin],
    onApplied: session.applied,
    protectedValues: [options.password],
    ...(options.human ? { human: options.human } : {}),
    maxSteps: 30,
    // A page saying "connected" is a claim. The device's next poll is the
    // evidence: it is answered with a token only once the person approved.
    verify: async () => {
      session.step("verified");
      session.say({ kind: "device", stage: "polling" });
      const who = await Promise.race([
        device.device.connected,
        new Promise<undefined>((resolve) =>
          setTimeout(
            () => resolve(undefined),
            (device.device.interval + 8) * 1000,
          ),
        ),
      ]);
      return who === options.account;
    },
  });
  session.checkFills(result);
  await session.park();
  const connectedAs = device.device.connectedAs();
  if (connectedAs) {
    device.show("connected");
    session.say({ kind: "provider", says: "device-connected" });
    await session.hold(1_600);
    session.say({ kind: "device", stage: "connected" });
    await session.hold(2_600);
  }
  return { result, connectedAs };
}
