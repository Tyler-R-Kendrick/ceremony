import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CeremonyResult } from "../../src/server/browser-driver.js";
import type { ProviderDouble } from "../../tests/doubles/auth-provider/server.js";
import { caption } from "./captions.js";
import type { DemoSession } from "./harness.js";

/**
 * The connector's side of an authorization-code demo: its callback page and
 * the server-side redemption, shown as cards beside the chain panel.
 *
 * The redirect URI belongs to its own local origin, as a connector's does in
 * production, so the browser lands on a callback page rather than on the
 * provider. The page never echoes its query: the code stays in the URL, which
 * the driver reads and nothing displays.
 */
export async function startConnectorCallback(): Promise<{
  uri: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Connector callback</title>
      <style>body{margin:0;height:100vh;display:flex;align-items:center;padding:0 30px;background:#f8fafc;color:#0f172a;font-family:"DejaVu Sans",sans-serif}
      h1{font-size:18px;margin:0 0 6px}p{font-size:10px;margin:0;color:#475569}</style></head>
      <body><div><h1>Connector callback received</h1><p>Returning to Ceremony. The authorization code is never displayed.</p></div></body></html>`);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    uri: `http://127.0.0.1:${port}/oauth/callback`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Redeem the callback on screen: state, code + verifier, the token's subject,
 * and a replay that must be refused. Returns whether every check held.
 */
export async function redeemOnScreen(
  session: DemoSession,
  provider: ProviderDouble,
  request: { verifier: string; state: string },
  result: CeremonyResult,
  subject: {
    expected: string | undefined;
    stage: "subject-matches" | "subject-is-person";
  },
): Promise<boolean> {
  const chain = session.entry.chain ?? [];
  const code =
    result.status === "completed" ? result.callback?.code : undefined;
  if (code) session.protect(code);
  session.step("token-exchange");
  session.say({ kind: "connector", stage: "callback" });
  await session.hold(2_200);

  const stateMatches =
    result.status === "completed" && result.callback?.state === request.state;
  const redeemed = code
    ? await provider.exchange(code, request.verifier)
    : undefined;
  const token = redeemed?.body["access_token"];
  if (typeof token === "string") session.protect(token);
  const subjectMatches =
    redeemed?.status === 200 &&
    subject.expected !== undefined &&
    redeemed.body["sub"] === subject.expected;
  const replay = code
    ? await provider.exchange(code, request.verifier)
    : undefined;
  const replayRefused = replay !== undefined && replay.status !== 200;

  const lines: string[] = [caption({ kind: "connector", stage: "callback" })];
  const show = async (title: string, ms: number) =>
    session.card(
      { title, tone: "connector", keepPanel: true, lines: [...lines] },
      ms,
    );
  for (const [ok, stage] of [
    [stateMatches, "state-matches"],
    [redeemed?.status === 200, "exchange"],
  ] as const) {
    if (!ok) break;
    lines.push(caption({ kind: "connector", stage }));
    session.say({ kind: "connector", stage });
    await show("Redeem the callback", 2_200);
  }
  const verified = Boolean(
    code && stateMatches && subjectMatches && replayRefused,
  );
  if (!verified) return false;
  session.step("verified");
  for (const stage of [subject.stage, "replay-refused"] as const) {
    lines.push(caption({ kind: "connector", stage }));
    session.say({ kind: "connector", stage });
    await show("Verified access", 2_400);
  }
  if (chain.length)
    session.panel({
      kind: "chain",
      chain,
      current: chain.at(-1)!,
      finished: true,
    });
  session.say({ kind: "verified", what: "token" });
  await show("Verified access", 2_600);
  return true;
}
