/**
 * A small host for the GitHub App ceremony, for exercising the kernel in a
 * real browser. GitHub is a double that lives in this process; the journal
 * and the vault are in memory. The page can also play the environment: expire
 * the token, remove the installation, delete the app, or start a new run on
 * what is left.
 */
import { createServer } from "node:http";
import { build } from "esbuild";
import {
  advance,
  memoryJournal,
  memoryVault,
  type Adapters,
  type HumanAnswer,
  type JournalEntry,
  type OperatorDecl,
  type RunStatus,
} from "../../src/kernel/index.js";
import {
  githubAppAccess,
  type GitHubAppCredentials,
} from "../../src/kernel/flows/github-app.js";

/** Markers a secret would carry if one ever reached the page. */
export const SECRET_MARKERS = ["PRIVATE-KEY-", "ghs_SECRET_", "manifest-code-"];

class GitHubDouble {
  readonly apps = new Map<number, { owner: string; key: string }>();
  readonly installations = new Map<
    number,
    { appId: number; account: string }
  >();
  readonly codes = new Map<string, number>();
  readonly tokens = new Set<string>();
  private serial = 100;

  createApp(owner: string): string {
    this.serial += 1;
    this.apps.set(this.serial, { owner, key: `PRIVATE-KEY-${this.serial}` });
    const code = `manifest-code-${this.serial}`;
    this.codes.set(code, this.serial);
    return code;
  }

  install(appId: number, account: string): number {
    this.serial += 1;
    this.installations.set(this.serial, { appId, account });
    return this.serial;
  }
}

type Flow = Adapters<
  typeof githubAppAccess.facts,
  typeof githubAppAccess.operators
>;

function adapters(github: GitHubDouble): Flow {
  const valid = (credentials: GitHubAppCredentials | undefined): boolean =>
    credentials !== undefined &&
    github.apps.get(credentials.appId)?.key === credentials.privateKey;
  return {
    probes: {
      target: async ({ read }) => {
        const stored = (await read("target")) as
          { login: string; kind: "User" | "Organization" } | undefined;
        return stored === undefined
          ? { held: false }
          : { held: true, value: stored };
      },
      appConfig: async () => ({ held: false }),
      app: async ({ read }) => {
        const stored = (await read("app")) as GitHubAppCredentials | undefined;
        return stored !== undefined && valid(stored)
          ? { held: true, value: stored }
          : { held: false };
      },
      installation: async ({ read }) => {
        const credentials = (await read("app")) as
          GitHubAppCredentials | undefined;
        const target = (await read("target")) as { login: string } | undefined;
        if (!valid(credentials) || target === undefined) return { held: false };
        for (const [installationId, installation] of github.installations) {
          if (
            installation.appId === credentials?.appId &&
            installation.account === target.login
          ) {
            return { held: true, value: { installationId } };
          }
        }
        return { held: false };
      },
      token: async ({ read }) => {
        const stored = (await read("token")) as
          { token: string; expiresAt: string } | undefined;
        return stored !== undefined && github.tokens.has(stored.token)
          ? { held: true, value: stored }
          : { held: false };
      },
    },
    operators: {
      adoptConfiguredApp: async () => ({ outcome: "mismatch" }),
      convertManifest: async ({ values }) => {
        const appId = github.codes.get(values.manifestCode);
        if (appId === undefined) return { outcome: "codeRejected" };
        github.codes.delete(values.manifestCode);
        const app = github.apps.get(appId);
        if (app === undefined) return { outcome: "codeRejected" };
        if (app.owner !== values.target.login) return { outcome: "wrongOwner" };
        return {
          outcome: "converted",
          values: {
            app: { appId, slug: `ceremony-${appId}`, privateKey: app.key },
          },
        };
      },
      mintToken: async ({ values }) => {
        if (!valid(values.app)) return { outcome: "appRejected" };
        if (!github.installations.has(values.installation.installationId)) {
          return { outcome: "installationGone" };
        }
        const token = `ghs_SECRET_${github.tokens.size + 1}_${Date.now()}`;
        github.tokens.add(token);
        return {
          outcome: "minted",
          values: { token: { token, expiresAt: "2099-01-01T00:00:00Z" } },
        };
      },
    },
  };
}

const github = new GitHubDouble();
const vaultValues = new Map<string, unknown>();
let entries: JournalEntry[] = [];
let run = 1;

interface PageAnswer {
  readonly requestId?: string;
  readonly action?: string;
  readonly fields?: Readonly<Record<string, string>>;
}

/** Turn what the page sent into an answer. Values never come from the page. */
function answerFor(
  operator: string,
  page: PageAnswer,
): HumanAnswer | undefined {
  if (page.requestId === undefined || page.action === undefined)
    return undefined;
  const spec = (githubAppAccess.operators as Record<string, OperatorDecl>)[
    operator
  ]?.interface;
  const action = spec?.actions.find(
    (candidate) => candidate.id === page.action,
  );
  if (action === undefined) return undefined;
  const outcome = action.outcome;
  const target = vaultValues.get("target") as { login: string } | undefined;
  const app = vaultValues.get("app") as GitHubAppCredentials | undefined;
  let values: Record<string, unknown> | undefined;
  if (operator === "chooseTarget" && outcome === "chosen") {
    const login = (page.fields?.login ?? "").trim() || "octo";
    values = { target: { login: login.slice(0, 39), kind: "User" } };
  } else if (operator === "registerApp" && outcome === "created") {
    // The person went to GitHub and came back: the double does their part.
    values = { manifestCode: github.createApp(target?.login ?? "octo") };
  } else if (operator === "installApp" && outcome === "installed" && app) {
    values = {
      installation: {
        installationId: github.install(app.appId, target?.login ?? "octo"),
      },
    };
  }
  // The page only ever names an action; the kernel accepts it if offered.
  return {
    requestId: page.requestId,
    action: action.id,
    ...(values ? { values } : {}),
  };
}

async function step(page: PageAnswer): Promise<unknown> {
  const deps = {
    runId: `run-${run}`,
    adapters: adapters(github),
    journal: memoryJournal(entries),
    vault: memoryVault(vaultValues),
  };
  const open = await advance(githubAppAccess, deps);
  const answer =
    open.status === "awaiting"
      ? answerFor(open.request.operator, page)
      : undefined;
  const status: RunStatus =
    answer === undefined ? open : await advance(githubAppAccess, deps, answer);
  if (status.status === "failed") {
    const failure = status.failure;
    return {
      status: "failed",
      ending:
        failure.kind === "terminal"
          ? failure.reason
          : failure.kind === "unreachable"
            ? "unreachable"
            : failure.kind,
      leftBehind: status.leftBehind,
    };
  }
  return status;
}

function disturb(event: string): void {
  // Removing what a token rests on revokes the token, as GitHub does.
  if (event === "expire-token") github.tokens.clear();
  if (event === "remove-installation") {
    github.installations.clear();
    github.tokens.clear();
  }
  if (event === "delete-app") {
    github.apps.clear();
    github.installations.clear();
    github.tokens.clear();
  }
  if (event === "new-run") {
    entries = [];
    run += 1;
  }
}

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ceremony kernel harness</title>
    <style>
      * { box-sizing: border-box; margin: 0; }
      body { font-family: ui-monospace, "DejaVu Sans Mono", monospace; background: #f6f5f1; color: #1b1b18; }
      #stage { position: relative; width: 100%; background: #fff; --scale: 1; font-size: calc(16px * var(--scale)); line-height: 1.5; overflow: hidden; }
      #stage h1 { font-size: calc(20px * var(--scale)); line-height: 1.5; font-weight: 600; overflow-wrap: anywhere; }
      #stage p { overflow-wrap: anywhere; }
      #stage label { display: block; height: 100%; }
      #stage input { display: block; width: 100%; height: max(44px, calc(44px * var(--scale))); margin-top: 4px; font: inherit; padding: 0 12px; border: 1px solid #77756c; border-radius: 6px; }
      #stage button { width: 100%; height: 100%; font: inherit; line-height: 1.5; padding: 0 16px; border: 1px solid #1b1b18; border-radius: 6px; background: #fff; color: inherit; overflow-wrap: anywhere; cursor: pointer; }
      #stage button[data-emphasis="primary"] { background: #1b1b18; color: #fff; }
      #stage button:disabled { opacity: 0.55; cursor: default; }
      #stage button:focus-visible, #stage input:focus-visible, #world button:focus-visible { outline: 3px solid #2f6fed; outline-offset: 2px; }
      #ending, #left-behind { padding: 24px 16px 0; }
      #left-behind { padding-bottom: 24px; }
      #world { display: flex; flex-wrap: wrap; gap: 8px; padding: 16px; border-top: 1px solid #d8d6cd; }
      #world button { min-height: 44px; min-width: 44px; padding: 0 12px; font: inherit; font-size: 14px; border: 1px solid #77756c; border-radius: 6px; background: #f6f5f1; cursor: pointer; }
    </style>
  </head>
  <body data-phase="working" data-operator="" data-ending="" data-scale="1">
    <main id="stage" aria-live="polite"></main>
    <section id="world" aria-label="What the world does">
      <button type="button" data-world="expire-token">Token expires</button>
      <button type="button" data-world="remove-installation">Installation removed</button>
      <button type="button" data-world="delete-app">App deleted</button>
      <button type="button" data-world="new-run">Start a new run</button>
      <button type="button" id="scale">Larger text</button>
    </section>
    <script type="module" src="/app.js"></script>
  </body>
</html>`;

export async function start(port: number): Promise<{ close(): void }> {
  const bundle = await build({
    entryPoints: [new URL("./app.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    write: false,
    platform: "browser",
    target: "es2022",
  });
  const script = bundle.outputFiles[0]?.text ?? "";
  const server = createServer((request, response) => {
    const send = (status: number, type: string, body: string): void => {
      response.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
      });
      response.end(body);
    };
    if (request.method === "GET" && request.url === "/") {
      return send(200, "text/html; charset=utf-8", page);
    }
    if (request.method === "GET" && request.url === "/app.js") {
      return send(200, "text/javascript; charset=utf-8", script);
    }
    if (request.method !== "POST") return send(404, "text/plain", "not found");
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      void (async () => {
        try {
          const body = JSON.parse(raw === "" ? "{}" : raw) as PageAnswer & {
            event?: string;
          };
          if (request.url === "/api/world") disturb(body.event ?? "");
          else if (request.url !== "/api/advance") {
            return send(404, "text/plain", "not found");
          }
          send(
            200,
            "application/json",
            JSON.stringify(
              await step(request.url === "/api/world" ? {} : body),
            ),
          );
        } catch {
          send(
            400,
            "application/json",
            JSON.stringify({ error: "bad request" }),
          );
        }
      })();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  return { close: () => server.close() };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT ?? 4180);
  await start(port);
  console.log(`http://127.0.0.1:${port}`);
}
