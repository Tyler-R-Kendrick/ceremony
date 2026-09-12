import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Build a browsable page from the evidence `npm run test:flows` leaves behind.
 *
 * Every ceremony is recorded, but forty-odd separate `.webm` files are not
 * something a reviewer will sit through. This turns the directory into one
 * page: each ceremony's recording beside the transcript the driver produced,
 * what it was expected to do, and whatever the page logged. Opening it needs
 * nothing installed, and the recordings play where they already are.
 *
 * Everything here is of our own doubles, so nothing provider-owned is
 * retained and the deterministic verification policy is unchanged.
 */

const root =
  process.argv[2] && !process.argv[2].startsWith("--")
    ? process.argv[2]
    : "artifacts/flows";

/** Headline families first; a reviewer should meet the ordinary cases early. */
const familyOrder = [
  "Forms/session auth",
  "Registration",
  "OTP / magic link / MFA",
  "OAuth authorization code + PKCE",
  "OAuth delegated actor (proposed)",
  "Signed agent identity (proposed)",
  "OAuth device authorization",
  "Passkeys / WebAuthn",
];

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );

function read(directory) {
  const manifest = join(root, directory, "ceremony.json");
  if (!existsSync(manifest)) return undefined;
  const ceremony = JSON.parse(readFileSync(manifest, "utf8"));
  const log = (name) => {
    const path = join(root, directory, name);
    return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  };
  return {
    ...ceremony,
    directory,
    hasRecording: existsSync(join(root, directory, "ceremony.webm")),
    console: log("console.log"),
    errors: log("errors.log"),
  };
}

if (!existsSync(root)) {
  // CI builds this with `if: always()`, so it runs when `test:flows` failed
  // before writing anything. Saying so beats an ENOENT stack trace.
  console.error(`No ceremony evidence under ${root}: nothing was recorded.`);
  process.exit(1);
}

const flows = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => read(entry.name))
  .filter(Boolean)
  .sort((a, b) => {
    const family = (flow) => {
      const index = familyOrder.indexOf(flow.family);
      return index === -1 ? familyOrder.length : index;
    };
    // Within a family: the ordinary success first, then the ones that cost
    // somebody something, then the refusals. A reviewer should meet the
    // capability before they meet its edges.
    const interest = (flow) =>
      flow.status !== "completed" ? 2 : (flow.handoffs ?? 0) > 0 ? 1 : 0;
    return (
      family(a) - family(b) ||
      interest(a) - interest(b) ||
      (a.scenario < b.scenario ? -1 : 1)
    );
  });

if (flows.length === 0) {
  console.error(`No ceremony evidence under ${root}`);
  process.exit(1);
}

/**
 * A ceremony did what the catalog said it would, or it did not. Handoffs are
 * part of that: a run that reached the goal by interrupting someone when it
 * was not supposed to has not done what was asked.
 */
const asExpected = (flow) =>
  flow.status === flow.expected.status &&
  (flow.expected.reason === undefined ||
    flow.reason === flow.expected.reason) &&
  (flow.expected.handoffs === undefined ||
    flow.handoffs === flow.expected.handoffs) &&
  (flow.expected.callback !== true || flow.callback === true);

const outcome = (flow) =>
  `${flow.status}${flow.reason ? `: ${flow.reason}` : ""}`;

const handoffs = flows.reduce((total, flow) => total + (flow.handoffs ?? 0), 0);
const needingAPerson = flows.filter((flow) => (flow.handoffs ?? 0) > 0).length;

const pathOf = (value) => {
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
};

const card = (flow) => {
  const asked = (flow.handoffs ?? 0) > 0;
  return `
  <article class="flow${asked ? " asked" : ""}" id="${escape(flow.scenario)}">
    <div class="head">
      <h3><a href="#${escape(flow.scenario)}">${escape(flow.scenario)}</a></h3>
      <p class="title">${escape(flow.title ?? "")}</p>
      <p class="meta">
        <span class="badge ${asExpected(flow) ? "ok" : "bad"}">${escape(outcome(flow))}</span>
        <span class="tag">${escape(flow.flowKind)}</span>
        <span class="tag">${flow.steps} step${flow.steps === 1 ? "" : "s"}</span>
        ${
          asked
            ? `<span class="tag asked">${flow.handoffs} handoff${
                flow.handoffs === 1 ? "" : "s"
              }</span>`
            : `<span class="tag">nobody interrupted</span>`
        }
      </p>
    </div>
    <div class="body">
      ${
        flow.hasRecording
          ? `<video controls preload="metadata" loop playsinline
                    src="${escape(flow.directory)}/ceremony.webm"></video>`
          : `<p class="missing">No recording was captured for this ceremony.</p>`
      }
      <div class="detail">
        <h4>What the driver did</h4>
        <ol class="transcript">
          ${
            flow.transcript
              ?.map(
                (step) => `<li>
                  <span class="act${step.action === "handoff" ? " asked" : ""}">${escape(step.action)}</span>
                  ${step.role ? `<span class="role">${escape(step.role)}</span>` : ""}
                  ${step.reason ? `<span class="role">${escape(step.reason)}</span>` : ""}
                  <span class="at">${escape(pathOf(step.path))}</span>
                </li>`,
              )
              .join("") || `<li class="none">No steps were taken.</li>`
          }
        </ol>
        ${flow.console ? `<h4>Console</h4><pre>${escape(flow.console)}</pre>` : ""}
        ${
          flow.errors
            ? `<h4>Page errors</h4><pre class="bad">${escape(flow.errors)}</pre>`
            : ""
        }
      </div>
    </div>
  </article>`;
};

const families = [...new Set(flows.map((flow) => flow.family))];
const slug = (family) => family.replace(/\W+/g, "-").toLowerCase();

const styles = `
  :root {
    --ground: #f7f8fa; --card: #ffffff; --ink: #12151b; --dim: #626a7a;
    --line: #dde1e9; --rule: #eceff4;
    --ok: #0a6b46; --ok-bg: #e2f4ec;
    --bad: #98211f; --bad-bg: #fdeae9;
    --asked: #8a5200; --asked-bg: #fcf0d9; --asked-edge: #e0a538;
  }
  :root:not([data-theme="light"]) {
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #0f1116; --card: #171a21; --ink: #e6e8ee; --dim: #939bab;
      --line: #272b35; --rule: #1f232b;
      --ok: #64dda6; --ok-bg: #10301f;
      --bad: #ff9e99; --bad-bg: #391513;
      --asked: #f0bd6b; --asked-bg: #33260e; --asked-edge: #8a6520;
    }
  }
  :root[data-theme="dark"] {
    --ground: #0f1116; --card: #171a21; --ink: #e6e8ee; --dim: #939bab;
    --line: #272b35; --rule: #1f232b;
    --ok: #64dda6; --ok-bg: #10301f;
    --bad: #ff9e99; --bad-bg: #391513;
    --asked: #f0bd6b; --asked-bg: #33260e; --asked-edge: #8a6520;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0; padding-block: 0 72px; padding-inline: 20px;
    background: var(--ground); color: var(--ink);
    font-family: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system,
      "Segoe UI", Roboto, sans-serif;
    font-size: 15px; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1080px; margin-inline: auto; }

  .top { padding-block: 48px 28px; display: flex; flex-direction: column; gap: 20px; }
  h1 {
    margin: 0; font-size: clamp(1.7rem, 1.2rem + 1.6vw, 2.3rem);
    font-weight: 600; letter-spacing: -0.025em; text-wrap: balance;
  }
  .lede { margin: 0; color: var(--dim); max-width: 64ch; }
  .lede code {
    font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.88em;
  }

  .totals {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1px; margin: 0; padding: 0; list-style: none;
    background: var(--line); border: 1px solid var(--line); border-radius: 12px;
    overflow: hidden;
  }
  .totals li { background: var(--card); padding: 14px 16px; }
  .totals strong {
    display: block; font-size: 1.75rem; font-weight: 600; line-height: 1.1;
    font-variant-numeric: tabular-nums; letter-spacing: -0.02em;
  }
  .totals li.asked strong { color: var(--asked); }
  .totals span {
    display: block; margin-top: 3px; color: var(--dim);
    font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.07em;
  }

  nav { display: flex; flex-wrap: wrap; gap: 7px; }
  nav a {
    font-size: 0.82rem; color: var(--dim); text-decoration: none;
    border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px;
    background: var(--card);
  }
  nav a:hover, nav a:focus-visible { color: var(--ink); border-color: var(--dim); }

  h2 {
    margin: 48px 0 0; padding-bottom: 8px; border-bottom: 1px solid var(--rule);
    font-size: 0.78rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.1em; color: var(--dim); scroll-margin-top: 16px;
  }

  .flow {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 18px; margin-top: 14px; scroll-margin-top: 16px;
    display: flex; flex-direction: column; gap: 16px;
  }
  /* The one structural device on the page, and it encodes the only fact that
     matters most here: this ceremony could not be finished without a person. */
  .flow.asked { border-left: 3px solid var(--asked-edge); }

  .head { display: flex; flex-direction: column; gap: 6px; }
  .flow h3 {
    margin: 0; font-size: 0.92rem; font-weight: 500;
    font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .flow h3 a { color: inherit; text-decoration: none; }
  .flow h3 a:hover, .flow h3 a:focus-visible { text-decoration: underline; }
  .title { margin: 0; color: var(--dim); font-size: 0.9rem; text-wrap: balance; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 0; }
  .badge, .tag {
    font-size: 0.73rem; border-radius: 5px; padding: 2px 8px; white-space: nowrap;
    border: 1px solid var(--line); color: var(--dim);
  }
  .badge {
    font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    border-color: transparent;
  }
  .badge.ok { background: var(--ok-bg); color: var(--ok); }
  .badge.bad { background: var(--bad-bg); color: var(--bad); }
  .tag.asked { background: var(--asked-bg); color: var(--asked); border-color: transparent; }

  .body { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr); gap: 20px; }
  @media (max-width: 780px) { .body { grid-template-columns: 1fr; } }
  video {
    width: 100%; max-width: 100%; border-radius: 8px;
    border: 1px solid var(--line); background: #0b0d11; display: block;
    /* Recordings are a browser viewport, so reserve that shape up front and
       let a differently sized one letterbox rather than shift the layout. */
    aspect-ratio: 1280 / 634; height: auto; object-fit: contain;
  }

  .detail { min-width: 0; }
  .detail h4 {
    margin: 0 0 7px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--dim);
  }
  .detail h4 ~ h4 { margin-top: 16px; }
  .transcript {
    margin: 0; padding: 0; list-style: none;
    display: flex; flex-direction: column; gap: 4px;
    counter-reset: step;
  }
  .transcript li {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px;
    font-size: 0.83rem; min-width: 0;
  }
  .transcript li::before {
    counter-increment: step; content: counter(step);
    font-variant-numeric: tabular-nums; color: var(--dim);
    font-size: 0.72rem; min-width: 1.1em; text-align: right;
  }
  .transcript li.none::before { content: ""; min-width: 0; }
  .act {
    font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem; color: var(--ink);
  }
  .act.asked { color: var(--asked); font-weight: 500; }
  .role { color: var(--dim); font-size: 0.8rem; }
  .at {
    margin-left: auto; color: var(--dim); font-size: 0.75rem;
    font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow-wrap: anywhere;
  }
  .none { color: var(--dim); }
  pre {
    margin: 0; padding: 9px 11px; background: var(--ground);
    border: 1px solid var(--rule); border-radius: 7px;
    font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.76rem; overflow-x: auto; white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  pre.bad { color: var(--bad); border-color: var(--bad-bg); }
  .missing { color: var(--dim); font-size: 0.87rem; margin: 0; }

  footer {
    margin-top: 56px; padding-top: 22px; border-top: 1px solid var(--rule);
    color: var(--dim); font-size: 0.85rem; max-width: 68ch;
  }
  footer p { margin: 0; }
  a:focus-visible, video:focus-visible, h3 a:focus-visible {
    outline: 2px solid var(--asked-edge); outline-offset: 2px;
  }
`;

const content = `
<div class="wrap">
<header class="top">
  <h1>Auth ceremony recordings</h1>
  <p class="lede">
    Every scenario in the catalog, driven through real Chromium by the
    <code>agent-browser</code> CLI and recorded as it ran. Each card pairs the
    video with the steps the driver actually took. The
    <strong>${needingAPerson}</strong> marked along their left edge are the ones
    it could not finish alone.
  </p>
  <ul class="totals">
    <li><strong>${flows.length}</strong><span>ceremonies</span></li>
    <li><strong>${flows.filter(asExpected).length}</strong><span>as the catalog says</span></li>
    <li class="asked"><strong>${needingAPerson}</strong><span>needed a person</span></li>
    <li class="asked"><strong>${handoffs}</strong><span>handoffs in total</span></li>
  </ul>
  <nav>${families
    .map(
      (family) =>
        `<a href="#family-${escape(slug(family))}">${escape(family)}</a>`,
    )
    .join("")}</nav>
</header>
${families
  .map(
    (family) => `
  <h2 id="family-${escape(slug(family))}">${escape(family)}</h2>
  ${flows
    .filter((flow) => flow.family === family)
    .map(card)
    .join("")}`,
  )
  .join("")}
<footer>
  <p>
    Every page in these recordings is served by this repository's own provider
    doubles, seeded with synthetic identities and regenerated per instance from
    a seed. Nothing here is a real provider: a green run is evidence that the
    driver understood pages of this shape, not that any live service behaves
    this way.
  </p>
</footer>
</div>
`;

const fonts =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?' +
  "family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600" +
  '&display=swap">';

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Auth ceremony recordings</title>
${fonts}
<style>${styles}</style>
</head>
<body>
${content}</body>
</html>
`;

// The published form carries no document scaffolding: the Artifact host
// supplies `<head>` and `<body>` itself, so emitting them again would nest a
// document inside a document.
const fragment = `<title>Auth ceremony recordings</title>
${fonts}
<style>${styles}</style>
${content}`;

const bodyOnly = process.argv.indexOf("--body-only");
if (bodyOnly !== -1) {
  const target = process.argv[bodyOnly + 1];
  if (!target) {
    console.error("--body-only needs a path to write");
    process.exit(1);
  }
  writeFileSync(target, fragment);
  console.log(`${target}: ${flows.length} ceremonies (publishable fragment)`);
}

writeFileSync(join(root, "index.html"), page);
console.log(
  `${root}/index.html: ${flows.length} ceremonies, ` +
    `${flows.filter(asExpected).length} as expected, ${handoffs} handoffs`,
);
