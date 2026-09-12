import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  snapshotPageSource,
  type PageSnapshot,
} from "../../src/core/browser-contracts.js";
import type { CeremonyPage } from "../../src/server/browser-driver.js";

const run = promisify(execFile);

/**
 * A `CeremonyPage` driven through Vercel's `agent-browser` CLI.
 *
 * The value over the Playwright adapter is evidence: this runner can record the
 * ceremony as video, read the page's console and errors, and audit
 * accessibility, so a failing auth flow leaves something a person can actually
 * look at. The snapshot still comes from the shared `snapshotDocument`, shipped
 * into the page with `eval`, so a contract proved here means what it means in
 * the other two runners.
 *
 * **This runner is for the scenario doubles only.** Those pages are ours, so a
 * recording or console dump retains nothing provider-owned. Verification's rule
 * that it never keeps raw provider or DOM diagnostics is unchanged, and nothing
 * here may be pointed at a live provider.
 *
 * One consequence of driving a CLI: values are passed as process arguments and
 * are therefore visible in the process list while a command runs. That is
 * acceptable for doubles seeded with synthetic values and is another reason
 * this runner stays away from real credentials.
 */

const indexAttribute = "data-ceremony-index";

/**
 * Recording shells out to `ffmpeg`, which the CLI looks for by that exact name
 * on PATH. Playwright already ships one, but names it `ffmpeg-linux`, so a
 * checkout that has everything it needs can still report "ffmpeg not found".
 * Linking it under the expected name costs nothing and makes recording work
 * wherever the browsers were installed; PATH must carry it before the CLI's
 * session daemon starts, which is why every call passes the same environment.
 */
function recorderPath(): string | undefined {
  const roots = [
    process.env["PLAYWRIGHT_BROWSERS_PATH"],
    join(process.env["HOME"] ?? "", ".cache", "ms-playwright"),
  ].filter((root): root is string => root !== undefined && existsSync(root));
  for (const root of roots) {
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith("ffmpeg")) continue;
      for (const name of ["ffmpeg-linux", "ffmpeg-mac", "ffmpeg"]) {
        const candidate = join(root, entry, name);
        if (!existsSync(candidate)) continue;
        const shim = join(tmpdir(), "ceremony-recorder");
        mkdirSync(shim, { recursive: true });
        const linked = join(shim, "ffmpeg");
        if (!existsSync(linked)) symlinkSync(candidate, linked);
        return shim;
      }
    }
  }
  return undefined;
}

export type AgentBrowserOptions = {
  /** Session name; each ceremony gets its own so browsers stay isolated. */
  session: string;
  /** Where recordings and logs are written. Omit to capture nothing. */
  artifacts?: string;
  /** Milliseconds to let a page settle after an action. */
  settleMs?: number;
  binary?: string;
};

export type AgentBrowserPage = CeremonyPage & {
  /** Console messages the page produced, oldest first. */
  console(): Promise<string>;
  /** Uncaught page errors. */
  errors(): Promise<string>;
  /** An axe-core audit of the page as the ceremony left it. */
  accessibility(): Promise<string>;
  startRecording(name: string): Promise<string | undefined>;
  stopRecording(): Promise<void>;
  close(): Promise<void>;
};

export function createAgentBrowserPage(
  options: AgentBrowserOptions,
): AgentBrowserPage {
  const binary = options.binary ?? "./node_modules/.bin/agent-browser";
  const settleMs = options.settleMs ?? 150;
  const shim = recorderPath();
  const searchPath = [shim, process.env["PATH"]]
    .filter(Boolean)
    .join(delimiter);
  let recording: string | undefined;

  const call = async (...args: string[]): Promise<string> => {
    const { stdout } = await run(
      binary,
      ["--session", options.session, ...args],
      {
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PATH: searchPath },
      },
    );
    return stdout.trim();
  };
  /** A read that has nothing to report is not a failure. */
  const read = async (...args: string[]): Promise<string> => {
    try {
      return await call(...args);
    } catch {
      return "";
    }
  };
  const selector = (index: number) => `[${indexAttribute}="${index}"]`;

  return {
    url: async () => call("get", "url"),
    goto: async (target) => {
      await call("open", target);
    },
    snapshot: async (): Promise<PageSnapshot> =>
      JSON.parse(await call("eval", snapshotPageSource(indexAttribute))),
    fill: async (element, value) => {
      if (element.kind === "select") {
        await call("select", selector(element.index), value);
        return;
      }
      // A date control is not a text box: typing into one does not land a
      // value, so it is set the way a browser registers one and told that it
      // changed. Everything else goes through the CLI's own fill.
      if (element.type === "date" || element.type === "time") {
        await call(
          "eval",
          `(() => {
            const field = document.querySelector(${JSON.stringify(
              selector(element.index),
            )});
            if (!field) return "missing";
            field.value = ${JSON.stringify(value)};
            for (const name of ["input", "change"])
              field.dispatchEvent(new Event(name, { bubbles: true }));
            return field.value;
          })()`,
        );
        return;
      }
      await call("fill", selector(element.index), value);
    },
    check: async (element) => {
      await call("check", selector(element.index));
    },
    click: async (element) => {
      await call("click", selector(element.index));
    },
    settle: async () => {
      await call("wait", String(settleMs));
    },
    console: () => read("console"),
    errors: () => read("errors"),
    accessibility: () => read("a11y", "--json"),
    startRecording: async (name) => {
      if (!options.artifacts) return undefined;
      const target = join(options.artifacts, `${name}.webm`);
      await mkdir(dirname(target), { recursive: true });
      try {
        await call("record", "start", target);
        recording = target;
        return target;
      } catch {
        // ffmpeg is optional; a missing recorder must not fail a ceremony.
        recording = undefined;
        return undefined;
      }
    },
    stopRecording: async () => {
      if (!recording) return;
      recording = undefined;
      await read("record", "stop");
    },
    close: async () => {
      await read("close");
    },
  };
}
