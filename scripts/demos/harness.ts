import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compose,
  connectCDP,
  ensureFfmpeg,
  extractThumbnail,
  InteractionTimeline,
  launchChrome,
  moveCursorTo,
  pause,
  Recorder,
  RecordingContext,
  type CDPClient,
} from "@webreel/core";
import type { ElementHandle, JSHandle, Page } from "playwright-core";
import type { CeremonyRole } from "../../src/core/browser-contracts.js";
import type {
  CeremonyPage,
  CeremonyResult,
} from "../../src/server/browser-driver.js";
import type { CeremonyInterpreter } from "../../src/server/browser-interpreter.js";
import {
  createPlaywrightCeremonyPage,
  type PlaywrightPageLike,
} from "../../src/server/browser-page.js";
import type {
  ElementHandleLike,
  JsHandleLike,
} from "../../src/server/browser-targets.js";
import { chromium } from "../../src/server/playwright.js";
import {
  caption,
  panel as panelOf,
  type CaptionEvent,
  type Panel,
  type PanelEvent,
  type Phase,
  type ValueSource,
} from "./captions.js";
import type { DemoEntry } from "./catalog.js";
import { pathnameOf } from "./phases.js";

/**
 * Records one demo: webreel owns the browser and the camera, Ceremony's own
 * driver owns every provider-side action.
 *
 * webreel (`@webreel/core`) launches Chrome and screen-records one tab. The
 * ceremony driver — `runCeremony` over `createPlaywrightCeremonyPage` —
 * attaches to that same Chrome over CDP and drives that tab. Nothing in this
 * file clicks or types on a provider page. It only *watches* the driver:
 *
 * - the interpreter is wrapped so each proposed step becomes a caption before
 *   the driver acts on it, and
 * - the page the adapter is given hands back element handles whose
 *   `fill`/`click`/`check` first move webreel's cursor to that element.
 *
 * Both seams slow the run down so a person can follow it; neither changes
 * what the driver decides, sees or submits. Captions come only from
 * `captions.ts`, and every value a scenario marks with `protect` is checked
 * against everything shown before a video is kept.
 */

/**
 * CSS viewport; the device scale makes the video 1280x720. The provider
 * pages are unstyled HTML, so they are shown at 2x rather than restyled —
 * nothing is injected into a page the driver reads.
 */
const viewport = { width: 640, height: 360 };
const zoom = 2;
const videoSize = { width: 1280, height: 720 };
const fps = 25;
const hud = {
  fontSize: 18,
  background: "rgba(15,23,42,0.86)",
  color: "rgba(255,255,255,0.95)",
  fontFamily: "DejaVu Sans, sans-serif",
  borderRadius: 10,
  position: "bottom" as const,
};

export type DemoOutcome = {
  /** The driver's result, checked for protected values before keeping. */
  result?: CeremonyResult;
  /** Whether the demo showed what it set out to show. */
  ok: boolean;
};

export type DemoSession = {
  entry: DemoEntry;
  /** The recorded tab, for navigation only. */
  page: Page;
  /** Mark a value that must never appear in a caption, card or transcript. */
  protect(value: string): void;
  /** Show one caption line (and the chain step, when the demo has one). */
  say(event: CaptionEvent): void;
  /** Advance the chain position shown beside captions and in the panel. */
  step(phase: Phase): void;
  /** Show a side panel beside the provider page, or clear it. */
  panel(event: PanelEvent | undefined): void;
  hold(ms: number): Promise<void>;
  /** Move the cursor out of the way once the driver has finished acting. */
  park(): Promise<void>;
  /** Use the current frame as the poster image. */
  poster(): void;
  /** A full-frame card: title, facts. Text is fixed or built from captions. */
  card(
    input: {
      title: string;
      lines: readonly string[];
      tone?: "intro" | "result" | "connector";
      /** Leave the side panel up and keep the text clear of it. */
      keepPanel?: boolean;
    },
    ms: number,
  ): Promise<void>;
  /** The driver's page adapter, instrumented to move the cursor before acting. */
  ceremonyPage(): CeremonyPage;
  /** Caption each proposal before the driver acts on it. */
  narrate(
    inner: CeremonyInterpreter,
    options: {
      sources?: Partial<Record<CeremonyRole, ValueSource>>;
      phase?: (
        previous: Phase | undefined,
        observed: {
          pathname: string;
          action: string;
          role?: string | undefined;
        },
      ) => Phase | undefined;
      thinkMs?: number;
    },
  ): CeremonyInterpreter;
};

export type DemoFiles = {
  video: string;
  poster: string;
  preview?: string | undefined;
  seconds: number;
  bytes: number;
};

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!,
  );

function cardHtml(input: {
  title: string;
  lines: readonly string[];
  tone?: "intro" | "result" | "connector";
  keepPanel?: boolean;
}): string {
  const accent =
    input.tone === "result"
      ? "#34d399"
      : input.tone === "connector"
        ? "#fbbf24"
        : "#93c5fd";
  const kicker =
    input.tone === "result"
      ? "Result"
      : input.tone === "connector"
        ? "Connector · server side, not in the browser"
        : "Ceremony demo · self-hosted test provider";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0f172a;color:#e2e8f0;font-family:"DejaVu Sans",sans-serif}
    main{box-sizing:border-box;height:100%;padding:22px 30px;display:flex;flex-direction:column;justify-content:center${input.keepPanel ? ";max-width:420px" : ""}}
    .kicker{color:${accent};font-size:8.5px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:5px}
    h1{font-size:19px;margin:0 0 11px;color:#fff}
    ul{margin:0;padding:0;list-style:none}
    li{font-size:9.5px;line-height:1.42;margin:0 0 4.5px;padding-left:12px;position:relative}
    li:before{content:"";position:absolute;left:0;top:.5em;width:5px;height:5px;border-radius:1.5px;background:${accent}}
    li.chain{padding-left:0;color:#fff;font-weight:bold}
    li.chain:before{display:none}
    </style></head><body><main>
    <div class="kicker">${kicker}</div>
    <h1>${escapeHtml(input.title)}</h1>
    <ul>${input.lines
      .map((line) =>
        line.startsWith("§")
          ? `<li class="chain">${escapeHtml(line.slice(1))}</li>`
          : `<li>${escapeHtml(line)}</li>`,
      )
      .join("")}</ul></main></body></html>`;
}

const panelMarks = {
  done: ["✓", "#34d399"],
  current: ["▶", "#93c5fd"],
  pending: ["○", "#64748b"],
  info: ["·", "#94a3b8"],
} as const;

function panelHtml(content: Panel): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:transparent;font-family:"DejaVu Sans",sans-serif}
    .panel{display:inline-block;width:196px;box-sizing:border-box;padding:9px 11px 7px;border-radius:8px;
      background:rgba(15,23,42,.92);color:#e2e8f0;border:1px solid #334155}
    h2{margin:0 0 6px;font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:#93c5fd}
    p{margin:0 0 4px;font-size:9px;line-height:1.3;display:flex;gap:6px}
    b{display:inline-block;width:9px;flex:none;text-align:center}
    .current{color:#fff;font-weight:bold}.pending{color:#94a3b8}.info{color:#94a3b8;font-style:italic}
    </style></head><body><div class="panel"><h2>${escapeHtml(content.title)}</h2>${content.rows
      .map(
        (row) =>
          `<p class="${row.mark}"><b style="color:${panelMarks[row.mark][1]}">${panelMarks[row.mark][0]}</b>${escapeHtml(row.text)}</p>`,
      )
      .join("")}</div></body></html>`;
}

/** Where a panel sits in the 1280x720 frame: right side, below any heading. */
const panelPosition = { right: 28, top: 150 };

/**
 * webreel's own headless mode starts chrome-headless-shell with begin-frame
 * control, which stops `requestAnimationFrame` — and with it Playwright's
 * actionability checks — unless someone issues frames. Its headed mode has no
 * such flag, so it is given a Chrome that runs headless on its own. The
 * wrapper is written per run and removed afterwards.
 */
function headlessChromeWrapper(): { path: string; remove: () => void } {
  const binary = process.env.DEMO_CHROME_BINARY ?? chromium.executablePath();
  const directory = mkdtempSync(join(tmpdir(), "ceremony-demo-chrome-"));
  const path = join(directory, "chrome");
  writeFileSync(
    path,
    // The scale is fixed on the command line as well as by emulation: a
    // cross-process navigation briefly paints at the default scale before
    // emulation reattaches, which shows up as a torn frame in the video.
    `#!/bin/sh\nexec ${JSON.stringify(binary)} --headless=new --disable-gpu --force-device-scale-factor=${zoom} --window-size=${viewport.width},${viewport.height} "$@"\n`,
  );
  chmodSync(path, 0o755);
  return {
    path,
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** Rough HUD width, mirroring webreel's own layout, so a row never overflows. */
function hudFits(labels: readonly string[]): boolean {
  const size = hud.fontSize;
  const width =
    labels.reduce((sum, label) => sum + label.length * size * 0.6, 0) +
    32 +
    14 * (labels.length - 1) +
    72;
  return width < videoSize.width - 24;
}

export async function recordDemo(
  entry: DemoEntry,
  outputDirectory: string,
  body: (session: DemoSession) => Promise<DemoOutcome>,
  options: { previewDirectory?: string | undefined } = {},
): Promise<DemoFiles> {
  mkdirSync(outputDirectory, { recursive: true });
  const video = join(outputDirectory, `${entry.id}.mp4`);
  const poster = join(outputDirectory, `${entry.id}.png`);
  const protectedValues = new Set<string>();
  const shown: string[] = [];

  const wrapper = headlessChromeWrapper();
  const previousChromePath = process.env.CHROME_PATH;
  process.env.CHROME_PATH = wrapper.path;
  let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
  let client: CDPClient | undefined;
  let recorder: Recorder | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let raw: string | undefined;
  try {
    chrome = await launchChrome({ headless: false });
    // The only page target in a fresh profile is the one webreel records.
    client = await connectCDP(chrome.port);
    await client.Page.enable();
    await client.Runtime.enable();
    await client.Emulation.setDeviceMetricsOverride({
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: zoom,
      mobile: false,
    });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${chrome.port}`);
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) throw new Error("webreel's Chrome has no page to record");

    const context = new RecordingContext();
    // The overlay works in video pixels, not CSS pixels: at webreel's own
    // `zoom` its caption box sits a fixed 48 CSS px (96 video px) above the
    // bottom edge, which covers the submit button of a tall form.
    context.resetCursorPosition(videoSize.width, videoSize.height);
    context.setMode("record");
    const timeline = new InteractionTimeline(
      videoSize.width,
      videoSize.height,
      {
        zoom: 1,
        fps,
        initialCursor: context.getCursorPosition(),
        cursorSize: 28,
        hud,
      },
    );
    context.setTimeline(timeline);
    recorder = new Recorder(videoSize.width, videoSize.height, {
      fps,
      crf: 20,
    });
    recorder.setTimeline(timeline);
    // Panels are drawn once, before recording, from the closed set a demo can
    // show; the video pass overlays them afterwards, so nothing is ever drawn
    // into a provider page.
    const chain = entry.chain ?? [];
    const panelEvents: PanelEvent[] = [
      ...chain.map((phase) => ({
        kind: "chain" as const,
        chain,
        current: phase,
      })),
      ...(chain.length
        ? [
            {
              kind: "chain" as const,
              chain,
              current: chain.at(-1)!,
              finished: true,
            },
          ]
        : []),
      ...(["provisioned", "waiting", "received"] as const).map((stage) => ({
        kind: "inbox" as const,
        stage,
      })),
    ];
    const panelImages = new Map<string, { png: Buffer; text: string[] }>();
    for (const event of panelEvents) {
      const content = panelOf(event);
      await page.setContent(panelHtml(content));
      panelImages.set(JSON.stringify(event), {
        png: await page.locator(".panel").screenshot({ omitBackground: true }),
        text: [content.title, ...content.rows.map((row) => row.text)],
      });
    }
    const panelSpans: { png: Buffer; start: number; end: number }[] = [];
    let openPanel: { key: string; png: Buffer; start: number } | undefined;
    const closePanel = () => {
      if (openPanel)
        panelSpans.push({ ...openPanel, end: timeline.getFrameCount() });
      openPanel = undefined;
    };

    await page.setContent(cardHtml({ title: entry.title, lines: [] }));
    await recorder.start(client, video, context);
    raw = recorder.getTempVideoPath();

    let posterFrame: number | undefined;
    let current: Extract<CaptionEvent, { kind: "step" }> | undefined;
    let line: CaptionEvent | undefined;
    const render = () => {
      if (!line) return timeline.hideHud();
      const joined = current
        ? `${caption(current)}  │  ${caption(line)}`
        : caption(line);
      const labels = hudFits([joined]) ? [joined] : [caption(line)];
      shown.push(...labels);
      timeline.showHud(labels);
    };
    const cursor = client;

    const before = async (
      kind: "fill" | "click" | "check",
      handle: ElementHandle,
    ) => {
      await handle.scrollIntoViewIfNeeded().catch(() => {});
      const box = await handle.boundingBox().catch(() => null);
      if (box) {
        // Aim inside the control, a little in from its left edge for a
        // field and at the middle of a button, as a person would point.
        const x =
          kind === "fill"
            ? box.x + Math.min(box.width / 2, 40)
            : box.x + box.width / 2;
        await moveCursorTo(
          context,
          cursor,
          x * zoom,
          (box.y + box.height / 2) * zoom,
        );
      }
      await pause(kind === "click" ? 260 : 160);
      if (kind !== "fill") timeline.setCursorScale(0.8);
    };
    const after = async (kind: "fill" | "click" | "check") => {
      await pause(110);
      timeline.setCursorScale(1);
      // Drift off the control once it is pressed, so the pointer is not left
      // resting on whatever the next page happens to put in the same place.
      if (kind !== "fill")
        await moveCursorTo(
          context,
          cursor,
          context.cursorX + 120,
          context.cursorY + 56,
        );
      await pause(kind === "fill" ? 800 : 300);
    };

    const session: DemoSession = {
      entry,
      page,
      protect(value) {
        if (value) protectedValues.add(value);
      },
      say(event) {
        line = event;
        render();
      },
      step(phase) {
        const index = chain.indexOf(phase);
        if (index < 0 || current?.phase === phase) return;
        current = {
          kind: "step",
          index: index + 1,
          total: chain.length,
          phase,
        };
        render();
        session.panel({ kind: "chain", chain, current: phase });
      },
      panel(event) {
        const key = event === undefined ? undefined : JSON.stringify(event);
        if (key === openPanel?.key) return;
        closePanel();
        if (key === undefined) return;
        const image = panelImages.get(key);
        if (!image) throw new Error(`No panel was prepared for ${key}`);
        shown.push(...image.text);
        openPanel = { key, png: image.png, start: timeline.getFrameCount() };
      },
      hold: (ms) => pause(ms),
      park: () =>
        moveCursorTo(
          context,
          cursor,
          videoSize.width - 48,
          videoSize.height * 0.62,
        ),
      poster() {
        posterFrame = timeline.getFrameCount();
      },
      async card(input, ms) {
        line = undefined;
        timeline.hideHud();
        if (!input.keepPanel) closePanel();
        // A card is not a page anyone acts on; the pointer leaves the frame.
        timeline.setCursorPath([{ x: -40, y: -40 }]);
        context.setCursorPosition(-40, -40);
        // Let one capture go by without the overlay before the page changes,
        // so no frame pairs the new card with the previous caption.
        await pause(160);
        shown.push(input.title, ...input.lines);
        await page.setContent(cardHtml(input));
        await pause(ms);
      },
      ceremonyPage: () =>
        createPlaywrightCeremonyPage(observedPage(page, before, after)),
      narrate(inner, narration) {
        let phase: Phase | undefined;
        return async (input) => {
          const action = await inner(input);
          if (!action) return action;
          const element =
            action.element === undefined
              ? undefined
              : input.snapshot.elements[action.element];
          if (narration.phase) {
            phase = narration.phase(phase, {
              pathname: pathnameOf(input.snapshot.path),
              action: action.action,
              role: action.role,
            });
            if (phase) session.step(phase);
          }
          if (action.action === "fill" && action.role)
            session.say({
              kind: "fill",
              actor: "agent",
              role: action.role,
              ...(narration.sources?.[action.role]
                ? { source: narration.sources[action.role]! }
                : {}),
            });
          else if (action.action === "click" && element)
            session.say({
              kind: "click",
              actor: "agent",
              control: element.kind,
              ...(phase ? { phase } : {}),
            });
          else if (action.action === "check")
            session.say({ kind: "check", actor: "agent" });
          else if (action.action === "wait")
            session.say({ kind: "wait", actor: "agent" });
          else if (action.action === "done")
            session.say({ kind: "claim-done", actor: "agent" });
          else if (action.action === "blocked")
            session.say({ kind: "blocked", reason: action.reason ?? "" });
          await pause(narration.thinkMs ?? 650);
          return action;
        };
      },
    };

    const outcome = await body(session);
    await pause(400);
    closePanel();
    await recorder.stop();
    recorder = undefined;

    // Nothing is kept until everything shown has been checked.
    const transcript = JSON.stringify(outcome.result?.transcript ?? []);
    for (const value of protectedValues) {
      if (value.length < 4) continue;
      if (shown.some((text) => text.includes(value)))
        throw new Error(
          `${entry.id}: a protected value reached a caption or card`,
        );
      if (transcript.includes(value))
        throw new Error(
          `${entry.id}: a protected value reached the transcript`,
        );
    }
    if (!outcome.ok)
      throw new Error(`${entry.id}: the run did not show what it set out to`);

    await compose(raw, timeline.toJSON(), video);
    const ffmpeg = await ensureFfmpeg();
    overlayPanels(ffmpeg, video, panelSpans);
    const seconds = timeline.getFrameCount() / fps;
    extractThumbnail(
      ffmpeg,
      video,
      poster,
      posterFrame === undefined ? seconds / 2 : posterFrame / fps,
    );
    let preview: string | undefined;
    if (options.previewDirectory && entry.docsPreview) {
      mkdirSync(options.previewDirectory, { recursive: true });
      preview = join(options.previewDirectory, `${entry.id}.mp4`);
      // Small enough to commit: two-thirds scale, no audio, higher CRF.
      execFileSync(ffmpeg, [
        "-y",
        "-v",
        "error",
        "-i",
        video,
        "-vf",
        "scale=854:-2:flags=lanczos,fps=15",
        "-c:v",
        "libx264",
        "-preset",
        "veryslow",
        "-crf",
        "30",
        "-pix_fmt",
        "yuv420p",
        "-an",
        "-movflags",
        "+faststart",
        preview,
      ]);
      // Markdown renders a GIF inline where it will not play a video, so the
      // docs embed this and link the MP4. A small palette keeps it well under
      // the size a repository should carry.
      execFileSync(ffmpeg, [
        ...["-y", "-v", "error", "-i", video, "-vf"],
        "fps=6,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=48[p];[b][p]paletteuse=dither=none",
        join(options.previewDirectory, `${entry.id}.gif`),
      ]);
      copyFileSync(poster, join(options.previewDirectory, `${entry.id}.png`));
    }
    return { video, poster, preview, seconds, bytes: statSync(video).size };
  } finally {
    if (recorder) await recorder.stop().catch(() => {});
    if (raw) rmSync(raw, { force: true });
    await browser?.close().catch(() => {});
    await client?.close().catch(() => {});
    chrome?.kill();
    if (previousChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = previousChromePath;
    wrapper.remove();
  }
}

/**
 * Draw the side panels over the composed video, each for the frames it was
 * open. Frame numbers are the timeline's, which is what the composed video is
 * made of, so a panel appears exactly when the event that opened it happened.
 */
function overlayPanels(
  ffmpeg: string,
  video: string,
  spans: readonly { png: Buffer; start: number; end: number }[],
): void {
  const visible = spans.filter((span) => span.end > span.start);
  if (visible.length === 0) return;
  const directory = mkdtempSync(join(tmpdir(), "ceremony-demo-panels-"));
  try {
    const inputs: string[] = [];
    const filters: string[] = [];
    let previous = "0:v";
    visible.forEach((span, index) => {
      const file = join(directory, `panel-${index}.png`);
      writeFileSync(file, span.png);
      inputs.push("-i", file);
      const next = `v${index}`;
      filters.push(
        `[${previous}][${index + 1}:v]overlay=x=W-w-${panelPosition.right}:y=${panelPosition.top}:enable='between(n,${span.start},${span.end - 1})'[${next}]`,
      );
      previous = next;
    });
    const output = join(directory, "with-panels.mp4");
    execFileSync(ffmpeg, [
      ...["-y", "-v", "error", "-i", video, ...inputs],
      ...["-filter_complex", filters.join(";"), "-map", `[${previous}]`],
      ...["-c:v", "libx264", "-preset", "medium", "-crf", "20"],
      ...["-pix_fmt", "yuv420p", "-movflags", "+faststart", output],
    ]);
    copyFileSync(output, video);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The adapter's view of the recorded page, with one addition: element handles
 * it acts through announce the action first, so the cursor arrives before the
 * driver's own `fill`/`click`/`check` runs. Handles are passed through to
 * Playwright unwrapped wherever the adapter hands them back to the page.
 */
function observedPage(
  page: Page,
  before: (
    kind: "fill" | "click" | "check",
    handle: ElementHandle,
  ) => Promise<void>,
  after: (kind: "fill" | "click" | "check") => Promise<void>,
): PlaywrightPageLike {
  const real = new WeakMap<object, JSHandle>();
  const unwrap = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    const held = real.get(value);
    if (held) return held;
    if (Array.isArray(value)) return value.map(unwrap);
    if (Object.getPrototypeOf(value) === Object.prototype)
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, unwrap(item)]),
      );
    return value;
  };
  const acting =
    (
      kind: "fill" | "click" | "check",
      element: ElementHandle,
      run: () => Promise<void>,
    ) =>
    async () => {
      await before(kind, element);
      try {
        await run();
      } finally {
        await after(kind);
      }
    };
  const wrap = (handle: JSHandle): JsHandleLike => {
    const element = handle.asElement();
    const base: JsHandleLike = {
      evaluate: (source, arg) =>
        handle.evaluate(source as never, unwrap(arg) as never),
      getProperty: async (name) => wrap(await handle.getProperty(name)),
      asElement: () => (element ? elementLike : null),
      dispose: () => handle.dispose(),
      jsonValue: () => handle.jsonValue(),
    };
    const elementLike: ElementHandleLike | null = element
      ? {
          ...base,
          fill: (value) => acting("fill", element, () => element.fill(value))(),
          click: () => acting("click", element, () => element.click())(),
          check: () => acting("check", element, () => element.check())(),
          selectOption: async (value) => {
            await before("fill", element);
            try {
              return await element.selectOption(value);
            } finally {
              await after("fill");
            }
          },
        }
      : null;
    real.set(base, handle);
    if (elementLike) real.set(elementLike, handle);
    return base;
  };
  return {
    url: () => page.url(),
    goto: (url, gotoOptions) => page.goto(url, gotoOptions),
    evaluateHandle: async (source) => wrap(await page.evaluateHandle(source)),
    evaluate: (fn, arg) => page.evaluate(fn as never, unwrap(arg) as never),
    waitForLoadState: (state, loadOptions) =>
      page.waitForLoadState(state, loadOptions),
    frames: () => page.frames(),
    mainFrame: () => page.mainFrame(),
  };
}
