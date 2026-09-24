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
import {
  checkboxConsent,
  type CeremonyRole,
} from "../../src/core/browser-contracts.js";
import type { RecordedTraceEntry } from "../../src/core/recorded-ceremony.js";
import type { DriverAction } from "../../src/core/browser-contracts.js";
import {
  assertFillsMatchLabels,
  type Decision,
} from "../../tests/doubles/fill-labels.js";
import type {
  CeremonyPage,
  CeremonyResult,
} from "../../src/server/browser-driver.js";
import type { CeremonyInterpreter } from "../../src/server/browser-interpreter.js";
import {
  redactionTracker,
  removeUnlessFinished,
  type Redaction,
} from "./redaction.js";
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
 * CSS viewport, one CSS pixel per video pixel: an ordinary 1280x720 browser
 * window, so a consent screen or a sign-in card fits the way it would on a
 * laptop. Nothing is injected into a page the driver reads.
 */
const viewport = { width: 1280, height: 720 };
const zoom = 1;
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
  /**
   * Scroll so the page's last button sits clear of the caption row, e.g. a
   * consent screen's Allow/Cancel while the viewer reads it. Presentation
   * only: nothing is pressed, and the driver re-reads the page anyway.
   */
  reveal(): Promise<void>;
  /**
   * Cover every element the selectors match with a solid box in the video for
   * as long as it is on screen, or stop watching with `undefined`. For a
   * value a provider page itself displays (an issued client secret, a setup
   * key) or one the driver types in plain sight (an authenticator code): the
   * page is left alone and the box is drawn into the composited video,
   * starting no later than the last poll that did not see it there.
   * `revealedBy` is the text of the button that puts the value on the page:
   * the boxes then start no later than that click, and a take in which the
   * value was revealed but never located is refused.
   */
  redact(
    selectors: string | readonly string[] | undefined,
    revealedBy?: string,
  ): void;
  /**
   * Render a stage prop off camera: a side card drawn from the demo's own
   * state rather than from the caption vocabulary, such as the screen of the
   * simulated device in a device-authorization demo. `text` is every line it
   * prints; it is checked against protected values like any caption.
   */
  prop(key: string, html: string, text: readonly string[]): Promise<void>;
  /** Show a rendered prop beside the page on `side`, or clear it. */
  showProp(key: string | undefined, side?: "left" | "right"): void;
  /** Use the current frame as the poster image. */
  poster(): void;
  /** A full-frame card: title, facts. Text is fixed or built from captions. */
  card(
    input: {
      title: string;
      lines: readonly string[];
      tone?: "intro" | "result" | "connector" | "device";
      /** Leave the side panel up and keep the text clear of it. */
      keepPanel?: boolean;
    },
    ms: number,
  ): Promise<void>;
  /** The driver's page adapter, instrumented to move the cursor before acting. */
  ceremonyPage(): CeremonyPage;
  /** Pass as the driver's `onApplied`; collects what `checkFills` judges. */
  applied(entry: RecordedTraceEntry): void;
  /**
   * After each driver run: every fill applied since the last check must have
   * gone into the field labelled for it, and no forward button may have been
   * pressed with a required field still empty (`assertFillsMatchLabels`, the
   * same gate the contract suites use). A failure ends the recording.
   */
  checkFills(result: CeremonyResult): void;
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

/** A take that failed for the camera's reasons, not the run's. */
export class RetryableTake extends Error {}

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
  tone?: "intro" | "result" | "connector" | "device";
  keepPanel?: boolean;
  /** A prop stays up on the left: the text sits between it and the panel. */
  clearLeft?: boolean;
}): string {
  const accent =
    input.tone === "result"
      ? "#34d399"
      : input.tone === "connector" || input.tone === "device"
        ? "#fbbf24"
        : "#93c5fd";
  const kicker =
    input.tone === "result"
      ? "Result"
      : input.tone === "connector"
        ? "Connector · server side, not in the browser"
        : input.tone === "device"
          ? "Simulated device · outside the browser"
          : "Ceremony demo · self-hosted test provider";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html{zoom:2}
    html,body{margin:0;height:100%;background:#0f172a;color:#e2e8f0;font-family:"DejaVu Sans",sans-serif}
    main{box-sizing:border-box;height:100%;padding:22px 30px;display:flex;flex-direction:column;justify-content:center${input.keepPanel ? (input.clearLeft ? ";margin-left:185px;max-width:290px" : ";max-width:420px") : ""}}
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
    html{zoom:1.5}
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
const panelPosition = { margin: 28, top: 150 };

/** The most a preview committed under `docs/demos/` may weigh. */
const maxPreviewBytes = 1_100_000;

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
  let appliedEntries: RecordedTraceEntry[] = [];
  let fillChecks = 0;
  const shown: string[] = [];

  const wrapper = headlessChromeWrapper();
  const previousChromePath = process.env.CHROME_PATH;
  process.env.CHROME_PATH = wrapper.path;
  let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
  let client: CDPClient | undefined;
  let recorder: Recorder | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let raw: string | undefined;
  let propBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
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
      ...(["empty", "held", "used"] as const).map((stage) => ({
        kind: "custody" as const,
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
    const panelSpans: PanelSpan[] = [];
    const panelSide = entry.panelSide ?? "right";
    let openPanel: { key: string; png: Buffer; start: number } | undefined;
    const closePanel = () => {
      if (openPanel)
        panelSpans.push({
          ...openPanel,
          side: panelSide,
          end: timeline.getFrameCount(),
        });
      openPanel = undefined;
    };
    // Props are rendered in a browser of their own, never in the recorded
    // tab, so drawing one mid-run puts nothing on camera but the prop.
    const props = new Map<string, { png: Buffer; text: readonly string[] }>();
    let openProp:
      | { key: string; png: Buffer; start: number; side: "left" | "right" }
      | undefined;
    const closeProp = () => {
      if (openProp)
        panelSpans.push({ ...openProp, end: timeline.getFrameCount() });
      openProp = undefined;
    };

    await page.setContent(cardHtml({ title: entry.title, lines: [] }));
    // webreel's capture loop waits on each screenshot with no deadline, so
    // one that never returns freezes the video while the run goes on. A
    // screenshot that takes this long is abandoned as a failed capture, and
    // the loop carries on with the next one.
    const camera = client;
    const recordingClient = {
      ...camera,
      Runtime: camera.Runtime,
      Page: {
        ...camera.Page,
        captureScreenshot: (
          params: Parameters<CDPClient["Page"]["captureScreenshot"]>[0],
        ) =>
          Promise.race([
            camera.Page.captureScreenshot(params),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("screenshot timed out")),
                2_000,
              ).unref(),
            ),
          ]),
      },
    } as CDPClient;
    await recorder.start(recordingClient, video, context);
    const recordingStarted = Date.now();
    raw = recorder.getTempVideoPath();

    let posterFrame: number | undefined;
    const redactions: Redaction[] = [];
    /** A redacted value revealed by an action but never found on screen. */
    let unlocatedRedaction = false;
    let redacting:
      | {
          selectors: readonly string[];
          revealedBy?: string;
          /** One tracker per selector and match, by `selector:match`. */
          trackers: Map<string, ReturnType<typeof redactionTracker>>;
          /** When the last completed poll was asked. */
          asked: number;
          /** Whether a reveal was applied and nothing was found after it. */
          awaiting: boolean;
          timer: NodeJS.Timeout;
          busy: boolean;
        }
      | undefined;
    const stopRedacting = () => {
      if (!redacting) return;
      clearInterval(redacting.timer);
      for (const tracker of redacting.trackers.values()) {
        tracker.stop();
        redactions.push(...tracker.boxes);
      }
      if (redacting.awaiting) unlocatedRedaction = true;
      redacting = undefined;
    };
    const pollRedaction = async () => {
      const watching = redacting;
      // One poll at a time, so each result is read against the one before.
      if (!watching || watching.busy) return;
      watching.busy = true;
      const asked = timeline.getFrameCount();
      const found = await page
        .evaluate((queries: readonly string[]) => {
          const boxes: Record<
            string,
            { x: number; y: number; w: number; h: number }
          > = {};
          queries.forEach((query, at) =>
            document.querySelectorAll(query).forEach((element, index) => {
              const rect = element.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0)
                boxes[`${at}:${index}`] = {
                  x: rect.x,
                  y: rect.y,
                  w: rect.width,
                  h: rect.height,
                };
            }),
          );
          return boxes;
        }, watching.selectors)
        .catch(() => ({}) as Record<string, never>);
      watching.busy = false;
      if (redacting !== watching) return;
      for (const [key, tracker] of watching.trackers)
        tracker.seen(found[key] ?? null, asked);
      for (const [key, box] of Object.entries(found)) {
        if (watching.trackers.has(key)) continue;
        // A match seen for the first time was not there at the last poll,
        // so its box starts no later than that poll, as a tracked one's does.
        const tracker = redactionTracker(() => timeline.getFrameCount());
        tracker.seen(null, watching.asked);
        tracker.seen(box, asked);
        watching.trackers.set(key, tracker);
      }
      if (Object.keys(found).length > 0) watching.awaiting = false;
      watching.asked = asked;
    };
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
      // The click that puts a redacted value on the page anchors its box, so
      // the box covers it from here even if every poll after it stalls.
      const revealedBy = redacting?.revealedBy;
      if (kind === "click" && revealedBy !== undefined) {
        const text = await handle
          .evaluate((element: Element) => element.textContent ?? "")
          .catch(() => "");
        if (text.replace(/\s+/g, " ").trim() === revealedBy && redacting) {
          for (const tracker of redacting.trackers.values())
            tracker.revealing();
          redacting.asked = timeline.getFrameCount();
          redacting.awaiting = true;
        }
      }
      // Scroll only when the control is near an edge or under the caption
      // row, and then to the middle, the way a person scrolls a tall form
      // while filling it in; a control already in view leaves the page still.
      await handle
        .evaluate((element: Element) => {
          const rect = element.getBoundingClientRect();
          if (rect.top < 72 || rect.bottom > window.innerHeight - 150)
            element.scrollIntoView({
              block: "center",
              inline: "nearest",
              behavior: "instant",
            });
        })
        .catch(() => {});
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
      redact(selectors, revealedBy) {
        stopRedacting();
        if (!selectors) return;
        const list = typeof selectors === "string" ? [selectors] : selectors;
        if (list.length === 0) return;
        const timer = setInterval(() => void pollRedaction(), 40);
        timer.unref();
        redacting = {
          selectors: list,
          ...(revealedBy !== undefined ? { revealedBy } : {}),
          trackers: new Map(),
          asked: timeline.getFrameCount(),
          awaiting: false,
          timer,
          busy: false,
        };
      },
      async prop(key, html, text) {
        propBrowser ??= await chromium.launch();
        const offstage = await propBrowser.newPage({
          viewport: { width: 640, height: 720 },
        });
        try {
          await offstage.setContent(html);
          props.set(key, {
            png: await offstage
              .locator(".prop")
              .screenshot({ omitBackground: true }),
            text,
          });
        } finally {
          await offstage.close();
        }
      },
      showProp(key, side = "left") {
        if (openProp && key === openProp.key && side === openProp.side) return;
        closeProp();
        if (key === undefined) return;
        const image = props.get(key);
        if (!image) throw new Error(`No prop was rendered for ${key}`);
        shown.push(...image.text);
        openProp = {
          key,
          png: image.png,
          side,
          start: timeline.getFrameCount(),
        };
      },
      reveal: async () => {
        await page
          .evaluate(() => {
            const buttons = [...document.querySelectorAll("button")].filter(
              (button) => button.getClientRects().length > 0,
            );
            const last = buttons.at(-1);
            if (!last) return;
            const rect = last.getBoundingClientRect();
            if (rect.bottom > window.innerHeight - 150)
              window.scrollBy({
                top: rect.bottom - (window.innerHeight - 170),
                behavior: "instant",
              });
          })
          .catch(() => {});
      },
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
        if (!input.keepPanel) {
          closePanel();
          closeProp();
        }
        // A card is not a page anyone acts on; the pointer leaves the frame.
        timeline.setCursorPath([{ x: -40, y: -40 }]);
        context.setCursorPosition(-40, -40);
        // Let one capture go by without the overlay before the page changes,
        // so no frame pairs the new card with the previous caption.
        await pause(160);
        shown.push(input.title, ...input.lines);
        await page.setContent(
          cardHtml({
            ...input,
            clearLeft: input.keepPanel === true && openProp?.side === "left",
          }),
        );
        // A redacted element is gone once the card replaces its page; the
        // box stops here, not when the scenario stopped asking for it.
        session.redact(undefined);
        await pause(ms);
      },
      applied(entry) {
        appliedEntries.push(entry);
      },
      checkFills(result) {
        // What the driver applied, in the decision shape the gate reads: the
        // snapshot the step was decided on and the action taken on it.
        const decisions: Decision[] = appliedEntries.map((applied) => ({
          snapshot: applied.snapshot,
          action: {
            action: applied.action,
            ...(applied.element === undefined
              ? {}
              : { element: applied.element }),
            ...(applied.role ? { role: applied.role } : {}),
          } as DriverAction,
        }));
        appliedEntries = [];
        if (!decisions.some((decision) => decision.action.action === "fill"))
          throw new Error(`${entry.id}: a run applied no fills to check`);
        assertFillsMatchLabels(result.transcript, decisions);
        fillChecks += 1;
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
          else if (action.action === "check") {
            // Kinds only, read from the box the way the driver reads it: a
            // tick that accepts terms says it was consented to.
            const consent = element ? checkboxConsent(element).kinds : [];
            session.say({
              kind: "check",
              actor: "agent",
              ...(consent.length ? { consent } : {}),
            });
          } else if (action.action === "wait")
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
    closeProp();
    session.redact(undefined);
    await recorder.stop();
    recorder = undefined;
    // The video must cover the run. Under load webreel folds slow captures
    // into at most three frames each, and a stalled capture adds none; either
    // way the video would run fast or stop early while the run went on. Such
    // a take is refused rather than kept.
    const wallSeconds = (Date.now() - recordingStarted) / 1000;
    const videoSeconds = timeline.getFrameCount() / fps;
    if (videoSeconds < wallSeconds * 0.8)
      throw new RetryableTake(
        `${entry.id}: the video covers ${videoSeconds.toFixed(0)}s of a ${wallSeconds.toFixed(0)}s run`,
      );

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
    if (unlocatedRedaction)
      throw new RetryableTake(
        `${entry.id}: a value to redact was revealed and never located`,
      );
    if (fillChecks === 0)
      throw new Error(`${entry.id}: no driver run was checked for its fills`);
    if (!outcome.ok)
      throw new Error(`${entry.id}: the run did not show what it set out to`);

    const ffmpeg = await ensureFfmpeg();
    await removeUnlessFinished(video, async () => {
      await compose(raw!, timeline.toJSON(), video);
      overlayPanels(ffmpeg, video, panelSpans, redactions);
    });
    // Where every box went, by frame, beside the video: what a frame-by-frame
    // check of the redaction starts from. Positions and frame numbers only.
    writeFileSync(
      join(outputDirectory, `${entry.id}.redactions.json`),
      `${JSON.stringify({ fps, boxes: redactions }, null, 2)}\n`,
    );
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
      // docs embed this and link the MP4. A small palette keeps it under the
      // size a repository should carry; a long demo steps down in frame rate
      // and width until it fits.
      const gif = join(options.previewDirectory, `${entry.id}.gif`);
      for (const [rate, width, colors] of [
        [6, 720, 48],
        [5, 640, 40],
        [4, 600, 32],
      ] as const) {
        execFileSync(ffmpeg, [
          ...["-y", "-v", "error", "-i", video, "-vf"],
          `fps=${rate},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}[p];[b][p]paletteuse=dither=none`,
          gif,
        ]);
        if (statSync(gif).size <= maxPreviewBytes) break;
      }
      copyFileSync(poster, join(options.previewDirectory, `${entry.id}.png`));
    }
    return { video, poster, preview, seconds, bytes: statSync(video).size };
  } finally {
    if (recorder) await recorder.stop().catch(() => {});
    if (raw) rmSync(raw, { force: true });
    await browser?.close().catch(() => {});
    await propBrowser?.close().catch(() => {});
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
type PanelSpan = {
  png: Buffer;
  start: number;
  end: number;
  side: "left" | "right";
};

function overlayPanels(
  ffmpeg: string,
  video: string,
  spans: readonly PanelSpan[],
  redactions: readonly {
    x: number;
    y: number;
    w: number;
    h: number;
    start: number;
    end: number;
  }[] = [],
): void {
  const visible = spans.filter((span) => span.end > span.start);
  if (visible.length === 0 && redactions.length === 0) return;
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
        `[${previous}][${index + 1}:v]overlay=x=${span.side === "left" ? panelPosition.margin : `W-w-${panelPosition.margin}`}:y=${panelPosition.top}:enable='between(n,${span.start},${span.end - 1})'[${next}]`,
      );
      previous = next;
    });
    // Redaction boxes go on last, over everything, a few pixels larger than
    // the field and a few frames longer than it was seen.
    redactions.forEach((box, index) => {
      const next = `r${index}`;
      const x = Math.max(0, Math.floor(box.x) - 4);
      const y = Math.max(0, Math.floor(box.y) - 4);
      filters.push(
        `[${previous}]drawbox=x=${x}:y=${y}:w=${Math.ceil(box.w) + 8}:h=${Math.ceil(box.h) + 8}:color=0x334155@1:t=fill:enable='between(n,${box.start},${box.end + 3})'[${next}]`,
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
