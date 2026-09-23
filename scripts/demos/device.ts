import type { ProviderDouble } from "../../tests/doubles/auth-provider/server.js";

/**
 * The simulated device in a device-authorization demo: a command-line tool
 * that asks the provider to be authorized (RFC 8628 section 3.1), prints the
 * user code and verification URL a person needs, and polls the token
 * endpoint until it is answered (section 3.4).
 *
 * Everything it shows comes from the provider's own answers. Its screen is a
 * stage prop the harness renders off camera and draws beside the page; it is
 * labelled as simulated on every frame, and the product it names is invented.
 * The access token it finally receives is reported through `protect` and
 * never printed - the screen says only that one was saved.
 */
export type DeviceScreen = "requested" | "polling" | "connected";

export type SimulatedDevice = {
  /** The client the device asked as, and the name it prints for itself. */
  client: string;
  name: string;
  userCode: string;
  /** The verification URI: what a person types, with no code in it. */
  verificationUri: string;
  /** The same page with the code in its query, for a device that links. */
  verificationUriComplete: string;
  interval: number;
  /**
   * Resolves once a poll is answered with a token, with the account the
   * token belongs to according to the provider's userinfo endpoint.
   */
  connected: Promise<string>;
  /** The account a poll was answered for, once one has been. */
  connectedAs(): string | undefined;
  /** How many polls were answered `authorization_pending`. */
  pending(): number;
  stop(): void;
};

/** An invented command-line tool; no real product has this name. */
export const deviceClient = {
  client: "driftwood-terminal",
  name: "Driftwood Terminal",
  command: "driftwood login",
};

export async function startDevice(
  provider: ProviderDouble,
  options: {
    protect(value: string): void;
    onScreen(screen: DeviceScreen): void;
  },
): Promise<SimulatedDevice> {
  const answer = await provider.requestDevice(deviceClient.client);
  options.protect(answer.device_code);
  let stopped = false;
  let pending = 0;
  let account: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  /** Seconds between polls: the provider's, and more if it says slow down. */
  let interval = answer.interval;
  const connected = new Promise<string>((resolve, reject) => {
    const poll = async () => {
      if (stopped) return;
      const { body } = await provider.pollDevice(
        deviceClient.client,
        answer.device_code,
      );
      if (typeof body.access_token === "string") {
        options.protect(body.access_token);
        const who = (await (
          await fetch(`${provider.origin}/userinfo`, {
            headers: { authorization: `Bearer ${body.access_token}` },
          })
        ).json()) as { sub?: string };
        if (!who.sub) return reject(new Error("no subject"));
        account = who.sub;
        options.onScreen("connected");
        return resolve(who.sub);
      }
      if (body.error !== "authorization_pending" && body.error !== "slow_down")
        return reject(new Error(`device poll ended: ${String(body.error)}`));
      pending++;
      options.onScreen("polling");
      // The interval the provider asked for is the least a device waits,
      // and a `slow_down` answer lengthens it for every poll after.
      interval = pollInterval(interval, body.error);
      timer = setTimeout(() => void poll().catch(reject), interval * 1000);
      timer.unref();
    };
    timer = setTimeout(() => void poll().catch(reject), interval * 1000);
    timer.unref();
  });
  // A demo that ends early must not leave an unhandled rejection behind.
  connected.catch(() => {});
  return {
    ...deviceClient,
    userCode: answer.user_code,
    verificationUri: answer.verification_uri,
    verificationUriComplete: answer.verification_uri_complete,
    interval: answer.interval,
    connected,
    connectedAs: () => account,
    pending: () => pending,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * The wait before the next poll, in seconds. RFC 8628 section 3.5: on
 * `slow_down` the device adds five seconds to its interval, for this and
 * every later poll; `authorization_pending` leaves it as it was.
 */
export function pollInterval(current: number, error: unknown): number {
  return error === "slow_down" ? current + 5 : current;
}

const escape = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!,
  );

/**
 * The device's screen in one state, as HTML for the harness to render and
 * the lines it prints, for the harness to check against protected values.
 */
export function deviceScreen(
  device: Pick<
    SimulatedDevice,
    "name" | "userCode" | "verificationUri" | "interval"
  > & { product: string },
  screen: DeviceScreen,
  account?: string,
): { html: string; text: string[] } {
  const url = device.verificationUri.replace(/^https?:\/\//, "");
  const lines: { text: string; className?: string }[] = [
    { text: `$ ${deviceClient.command}`, className: "prompt" },
    { text: `${device.name} needs your ${device.product} account.` },
    { text: "Open this page in a browser:" },
    { text: url, className: "url" },
    { text: "and enter the code:" },
    { text: device.userCode, className: "code" },
    ...(screen === "connected"
      ? [
          {
            text: `✓ Signed in as ${account ?? "your account"}`,
            className: "ok",
          },
          { text: "Access token saved (not shown).", className: "ok" },
        ]
      : [
          {
            text:
              screen === "polling"
                ? `… Waiting for approval, polling every ${device.interval} s`
                : "… Asking the provider for a token",
            className: "wait",
          },
        ]),
  ];
  const title = ["Simulated device", "not a real product"];
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:transparent}
    .prop{display:inline-block;width:336px;box-sizing:border-box;border-radius:10px;overflow:hidden;
      border:1px solid #475569;background:#0b1220;color:#e2e8f0;box-shadow:0 8px 24px rgba(2,6,23,.35)}
    .bar{display:flex;justify-content:space-between;align-items:center;padding:7px 11px;background:#1e293b;
      font:bold 11px "DejaVu Sans",sans-serif;letter-spacing:.07em;text-transform:uppercase;color:#fbbf24}
    .bar span+span{color:#94a3b8;font-weight:normal;letter-spacing:.03em;text-transform:none}
    .screen{padding:10px 12px 12px;font:12.5px/1.55 "DejaVu Sans Mono",monospace}
    .prompt{color:#94a3b8}.url{color:#93c5fd;word-break:break-all}
    .code{margin:6px 0 8px;padding:5px 0;text-align:center;font-size:25px;font-weight:bold;letter-spacing:.14em;
      color:#fff;background:#111c33;border:1px dashed #64748b;border-radius:6px}
    .wait{color:#fbbf24}.ok{color:#34d399;font-weight:bold}
    </style></head><body><div class="prop"><div class="bar"><span>${title[0]}</span><span>${title[1]}</span></div>
    <div class="screen">${lines
      .map(
        (line) =>
          `<div${line.className ? ` class="${line.className}"` : ""}>${escape(line.text)}</div>`,
      )
      .join("")}</div></div></body></html>`;
  return { html, text: [...title, ...lines.map((line) => line.text)] };
}
