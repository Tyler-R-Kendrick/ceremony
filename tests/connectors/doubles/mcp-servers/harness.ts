import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

/*
 * Starts a fixture MCP server as its own process. The client under test then
 * speaks real HTTP to it over a loopback port; nothing in this repository
 * generates both sides of the conversation. The child prints one JSON line
 * with its origin when it is listening, and exposes its recorded wire log and
 * a small control surface on paths outside the MCP endpoint.
 */

export type FixtureWire = {
  at: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
};

export type FixtureReport = {
  wire: FixtureWire[];
  effects: Array<{ tool: string; at: number; arguments: unknown }>;
  inputsSeen?: unknown[];
  elicitations?: unknown[];
  toolCalls: number;
  sessions?: number;
  mode: string;
};

export type FixtureServer = {
  origin: string;
  endpoint: string;
  /** Everything the server received, excluding the control paths. */
  report(): Promise<FixtureReport>;
  control(input: { mode?: string; reset?: boolean }): Promise<void>;
  stop(): Promise<void>;
};

const SERVERS = {
  current: "current-server.ts",
  legacy: "legacy-server.ts",
} as const;

export async function startMcpFixture(
  kind: keyof typeof SERVERS,
  options: { token?: string; secondToken?: string } = {},
): Promise<FixtureServer> {
  const script = fileURLToPath(new URL(SERVERS[kind], import.meta.url));
  // stdio ["ignore","pipe","pipe"] gives a child with no stdin and both
  // output streams present; the inferred type says exactly that.
  const child = spawn(
    process.execPath,
    ["--no-experimental-webstorage", "--import", "tsx", script],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=8192",
        ...(options.token ? { FIXTURE_TOKEN: options.token } : {}),
        ...(options.secondToken
          ? { FIXTURE_TOKEN_B: options.secondToken }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.setEncoding("utf8");

  const origin = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(
        new Error(`fixture ${kind} did not start: ${stderr.slice(0, 2000)}`),
      );
    }, 30_000);
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const line = buffer
        .split("\n")
        .find((candidate) => candidate.includes('"ready"'));
      if (!line) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line).origin as string);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `fixture ${kind} exited with ${code}: ${stderr.slice(0, 2000)}`,
        ),
      );
    });
  });

  return {
    origin,
    endpoint: `${origin}/mcp`,
    async report() {
      const response = await fetch(`${origin}/__wire`);
      return (await response.json()) as FixtureReport;
    },
    async control(input) {
      await fetch(`${origin}/__control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          once(child, "exit"),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
  };
}

/** Requests the fixture received on its MCP endpoint, in arrival order. */
export function mcpRequests(report: FixtureReport): FixtureWire[] {
  return report.wire.filter((entry) => entry.path === "/mcp");
}

/** JSON-RPC method names the fixture saw, in order. */
export function methodsSeen(report: FixtureReport): string[] {
  return mcpRequests(report)
    .map((entry) => (entry.body as { method?: unknown } | undefined)?.method)
    .filter((method): method is string => typeof method === "string");
}
