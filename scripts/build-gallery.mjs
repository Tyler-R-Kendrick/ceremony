import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CeremonyView } from "../src/react/index.js";
import {
  accountMountId,
  liveMountId,
  resolverPayloadId,
} from "./gallery-ids.js";
import { liveConnectors } from "./gallery-live-connectors.js";
import {
  asSpecimen,
  carrierFor,
  catalogue,
  flowKinds,
  galleryPayload,
  journeys,
  permissionChoices,
  specimen,
  templateFor,
  walls,
} from "./gallery-data.js";

/**
 * Builds the published auth catalogue.
 *
 * Every screen is rendered by the real CeremonyView from a snapshot the
 * production schema accepted, and every scenario row comes from the same
 * catalogue the auth scenario doubles drive. Nothing on the page is written
 * for the page.
 */

const root = new URL("../", import.meta.url);
const out = new URL("artifacts/gallery/", root);

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

// `inert` rather than `disabled`: a specimen must look exactly like the screen
// the product renders — greying its controls would show a button this library
// never draws — while still not responding to a press. A control that depresses
// under the mouse and then does nothing is the thing people report as broken,
// and there is nothing on its face to say it is a picture.
const frame = (html) => `<div class="screen" inert>
          <p class="specimen-tag">specimen · a picture of a screen, not a screen</p>
          ${asSpecimen(html)}
        </div>`;

/** A screen, rendered by the real component from a schema-valid specimen. */
function screen(kind, step) {
  const { manifest: connector, method } = carrierFor(kind);
  // Narrowed to the one method this specimen is of. The picker exists for a
  // real choice between routes, and a catalogue entry for `api-key` offering
  // two other kinds would be showing a choice nobody on this page is making.
  const manifest = { ...connector, methods: [method] };
  const model = {
    snapshot: specimen(kind, step),
    busy: false,
    refreshing: false,
    error: "",
    manifest,
    execute: async () => {},
    client: { manifest, intent: {} },
  };
  return renderToString(
    createElement(CeremonyView, {
      model,
      autoFocus: false,
      templates: [templateFor(method.kind)],
    }),
  );
}

const count = (total, noun) => `${total} ${noun}${total === 1 ? "" : "s"}`;

const stepNotes = {
  intro: "what is about to happen",
  input: "collected privately, never through the assistant",
  redirect: "the handoff, and what waits behind it",
  waiting: "the code, and where to enter it",
  anonymous: "usable immediately, owned by nobody",
  claim: "attaching a person to access that already works",
  complete: "what was granted, and to whom",
  error: "refused, with the reason kept",
  cancelled: "stopped deliberately",
  expired: "the window closed before anyone acted",
};

/**
 * Everything the page runs, compiled for the browser: the resolver, the live
 * connections, and the components both use.
 *
 * A separate file rather than an inline script: the page would otherwise have
 * to escape whatever the minifier happened to emit, and a bundle containing
 * the wrong six characters would end the script tag early and take the whole
 * section with it. It also keeps the document itself readable at its own size.
 */
const clientBundle = await build({
  entryPoints: [fileURLToPath(new URL("scripts/gallery-client.ts", root))],
  bundle: true,
  format: "iife",
  minify: true,
  target: "es2022",
  write: false,
  logLevel: "silent",
});
const clientSource = clientBundle.outputFiles[0].text;

const entries = catalogue();
const goals = [...new Set(entries.map((entry) => entry.goal))];
const registration = entries.filter((entry) => entry.goal === "registration");
const families = new Set(entries.map((entry) => entry.family));

const tags = (values, label) =>
  values.length
    ? `<span class="tags" aria-label="${escape(label)}">${values
        .map((value) => `<code>${escape(value)}</code>`)
        .join("")}</span>`
    : "";

const row = (entry) => `
  <tr data-kind="${escape(entry.flowKind)}">
    <td class="cell-id"><code>${escape(entry.id)}</code></td>
    <td class="cell-title">
      ${escape(entry.title)}
      <span class="cell-family">${escape(entry.family)}</span>
    </td>
    <td><code class="kind">${escape(entry.flowKind)}</code></td>
    <td class="cell-needs">${tags([...entry.provides], "roles required") || '<span class="none">nothing</span>'}</td>
    <td class="cell-outcome">${escape(entry.outcome)}${
      typeof entry.handoffs === "number"
        ? `<span class="cell-handoffs">${entry.handoffs} handoff${entry.handoffs === 1 ? "" : "s"}</span>`
        : ""
    }</td>
  </tr>`;

const table = (rows) => `
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th scope="col">Scenario</th>
          <th scope="col">What it does</th>
          <th scope="col">Flow</th>
          <th scope="col">Caller must supply</th>
          <th scope="col">Required outcome</th>
        </tr>
      </thead>
      <tbody>${rows.map(row).join("")}</tbody>
    </table>
  </div>`;

/**
 * The live resolver's controls.
 *
 * Every one of them is a thing a host can state about its own integration, and
 * not one of them is a protocol. That is the whole argument: a person cannot
 * answer "PKCE or device code?", and never has to, because everything needed to
 * decide it is something the host already knew.
 */
const declarations = [
  {
    name: "surface",
    legend: "Where does this run?",
    options: [
      { value: "browser", label: "In a browser" },
      { value: "headless", label: "Headless — a server, a job, an agent" },
    ],
    note: "somebody is here, at a browser",
  },
  {
    name: "identity",
    legend: "Whose access is this?",
    options: [
      { value: "either", label: "Either" },
      { value: "personal", label: "A person's" },
      { value: "anonymous", label: "Nobody's, for now" },
    ],
    note: "no opinion — whatever works",
  },
  {
    name: "interruptions",
    legend: "How much attention may it cost?",
    options: [
      { value: "any", label: "As much as it takes" },
      { value: "at-most-one", label: "At most one stop" },
      { value: "none", label: "Interrupt nobody" },
    ],
    note: "stop a person as often as the route needs",
  },
];

const choiceGroup = ({ name, legend, options, note }) => `
        <fieldset>
          <legend>${escape(legend)}</legend>
          <div class="choices">${options
            .map(
              ({ value, label }, index) => `
            <label>
              <input type="radio" name="${escape(name)}" value="${escape(value)}"${
                index === 0 ? " checked" : ""
              } />
              <span>${escape(label)}</span>
            </label>`,
            )
            .join("")}
          </div>
          <p class="note" data-note="${escape(name)}">${escape(note)}</p>
        </fieldset>`;

const permissionGroup = () => `
        <fieldset>
          <legend>What must it be able to do?</legend>
          <div class="choices">${permissionChoices
            .map(
              (permission) => `
            <label>
              <input type="checkbox" name="permission" value="${escape(permission.id)}" />
              <span>${escape(permission.label)} ${permission.scopes
                .map((scope) => `<code>${escape(scope)}</code>`)
                .join(" ")}</span>
            </label>`,
            )
            .join("")}
          </div>
          <p class="note">the words are the host's; every scope is one a connector here really declares</p>
        </fieldset>`;

/** "a, b and c" — the way a sentence lists things, not the way an array does. */
const listed = (names) =>
  names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

const liveSection = `
  <section class="movement" aria-labelledby="live-heading">
    <div class="movement-head">
      <h2 id="live-heading">Connect a service</h2>
      <p>
        Press Connect on a card and the ceremony runs inside that card, against
        ${listed(liveConnectors.map((entry) => escape(entry.manifest.name)))},
        through the connector you approved in claude.ai. Your credentials, never
        handled by this page, and read-only. What comes back is whatever the
        provider just said — including the refusals — and a connection you can
        keep: a reference that grants nothing and a key that opens it.
      </p>
    </div>
    <div class="live" id="${liveMountId}">
      <p class="live-pending">Starting the connections…</p>
    </div>
    <p class="live-note">
      One thing differs from a deployment you run yourself, and it is the
      transport: there, <code>createHttpTransport</code> talks to the connection
      server, which holds the credential. Here the transport calls your
      assistant's connectors, which hold it instead — so the provider's token is
      never handed to a page, and what a finished ceremony can give you is a
      connection of this page's own. The component, the client and the state
      machine are the ones the library ships; that is what having a
      <code>CeremonyTransport</code> interface is for.
    </p>
  </section>`;

/**
 * The section this page exists for, and therefore the first one.
 *
 * Every other flow here presumes an account. These make one. A card apiece,
 * pressing the card is what starts the ceremony, and the ceremony runs in the
 * card — including the three that end at a provider's own registration page,
 * because that is where those accounts are genuinely made and pretending
 * otherwise would be the fiction this page keeps being told off for.
 */
const accountSection = `
  <section class="movement opening" aria-labelledby="account-heading">
    <div class="movement-head">
      <h2 id="account-heading">Make an account</h2>
      <p>
        Every one of these starts by asking who you are, and none of them starts
        by asking for a password — that is the order providers actually work in,
        and it is read from what each one declared rather than written into a
        screen. The account kept here needs a password, so it generates one
        rather than making you invent it. GitHub, Stripe and Atlassian issue
        their own credentials, so they never ask you for one: the card carries
        your address into their registration page and takes back what they
        issued, masked, with one press to copy it.
      </p>
    </div>
    <div class="account-mount" id="${accountMountId}">
      <p class="live-pending">Loading the registration ceremonies…</p>
    </div>
    <p class="live-note">
      Real, and specific about how. For the account kept here: the password is
      stretched with PBKDF2-SHA256 in your browser and only the derived value is
      stored, the record is keyed by a digest of the address so the store holds
      no addresses and no secrets, and the confirmation code is kept only in
      derived form behind a ten-minute expiry. A published page cannot send
      mail, so that code goes to a mailbox here and the mailbox says so. For the
      three that register at a provider: the links are the providers' real ones
      and carry your address, the credential you bring back is checked against
      the shape that provider documents, and it stays in this tab — this page
      cannot ask GitHub whether a token works, and does not claim to have.
    </p>
  </section>`;

const page = `<title>Ceremony Auth Catalogue</title>
<link
  rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
/>
<style>
${readFileSync(fileURLToPath(new URL("src/react/styles.css", root)), "utf8")}
${readFileSync(fileURLToPath(new URL("scripts/gallery.css", root)), "utf8")}
</style>

<div class="page">
  <header class="masthead">
    <p class="eyebrow">Ceremony · authentication catalogue</p>
    <h1>It starts with somebody who has no account</h1>
    <p class="lede">
      So that is what this page starts with, and it runs. Four accounts, four
      cards: one kept here, and one each at GitHub, Stripe and Atlassian. Each
      asks who you are first and asks for a password only if that provider needs
      one — and generates it when it may, so nothing worth keeping is ever
      typed. Then connect a service, and the same component does the same thing
      against ${listed(
        liveConnectors.map((entry) => escape(entry.manifest.name)),
      )}. Behind both sits the catalogue: ${entries.length} scenarios across
      ${flowKinds.length} flow kinds and ${families.size} families, every screen
      rendered by the component the product ships.
    </p>
  </header>

${accountSection}
${liveSection}
  <section class="movement" aria-labelledby="walls-heading">
    <div class="movement-head">
      <h2 id="walls-heading">Where an attempt stops</h2>
      <p>
        Three endings every flow shares. They are screens in their own right,
        because an attempt that failed still has to tell somebody what happened.
      </p>
    </div>
    <ol class="screens walls">
      ${walls
        .map(
          (step) => `
        <li>
          <div class="screen-label">
            <code>${escape(step)}</code>
            <span>${escape(stepNotes[step])}</span>
          </div>
          ${frame(screen("form", step))}
        </li>`,
        )
        .join("")}
    </ol>
  </section>

  <section class="movement" aria-labelledby="registration-heading">
    <div class="movement-head">
      <h2 id="registration-heading">Making an account</h2>
      <p>
        ${registration.length} variants, and they differ in ways that change the
        screens: where the confirmation arrives, whether terms must be accepted,
        what happens when the address is already taken, and whether registration
        is a ceremony of its own or a prerequisite inside another one.
      </p>
    </div>
    ${table(registration)}
  </section>

  <section class="movement" aria-labelledby="catalogue-heading">
    <div class="movement-head">
      <h2 id="catalogue-heading">The whole catalogue</h2>
      <p>
        Grouped by what the caller is trying to achieve. Filter by flow kind to
        see what one mechanism has to cover.
      </p>
      <div class="filters" role="group" aria-label="Filter by flow kind">
        <button type="button" data-filter="all" aria-pressed="true">All</button>
        ${flowKinds
          .map(
            (kind) =>
              `<button type="button" data-filter="${escape(kind)}" aria-pressed="false"><code>${escape(kind)}</code></button>`,
          )
          .join("")}
      </div>
    </div>
    ${goals
      .map(
        (goal) => `
      <div class="goal" data-goal="${escape(goal)}">
        <h3>${escape(goal.replace(/-/g, " "))}</h3>
        ${table(entries.filter((entry) => entry.goal === goal))}
      </div>`,
      )
      .join("")}
  </section>

  <footer class="colophon">
    <p>
      The catalogue is read from the scenario list the auth doubles drive, so
      this page cannot claim coverage the test suite does not have. The screens
      are rendered by the real templates from snapshots the production schema
      accepted, so a screen shown here is one the product can reach.
      <code>client-credentials</code>, certificate and workload-federation
      profiles are deliberately absent: they have no browser step at all, and a
      page invented for them would be a fixture pretending to be evidence.
    </p>
  </footer>
</div>

<script>
  const buttons = [...document.querySelectorAll("[data-filter]")];
  // Scoped to the catalogue: the registration table above is a different
  // section with its own prose, and filtering it would leave a heading over a
  // table with nothing but its column names.
  const rows = [...document.querySelectorAll(".goal tbody tr")];
  const goals = [...document.querySelectorAll(".goal")];
  for (const button of buttons)
    button.addEventListener("click", () => {
      const wanted = button.dataset.filter;
      for (const other of buttons)
        other.setAttribute("aria-pressed", String(other === button));
      for (const row of rows)
        row.hidden = wanted !== "all" && row.dataset.kind !== wanted;
      // A goal with nothing left says so rather than leaving a bare heading.
      for (const goal of goals)
        goal.hidden = ![...goal.querySelectorAll("tbody tr")].some(
          (row) => !row.hidden,
        );
    });
</script>

<script type="application/json" id="${resolverPayloadId}">
${JSON.stringify(galleryPayload()).replace(/</g, "\\u003c")}
</script>
<script src="catalogue.js"></script>
`;

mkdirSync(fileURLToPath(out), { recursive: true });
writeFileSync(fileURLToPath(new URL("index.html", out)), page);
writeFileSync(fileURLToPath(new URL("catalogue.js", out)), clientSource);
console.log(
  `Auth catalogue: ${entries.length} scenarios, ${flowKinds.length} flows, ${
    flowKinds.reduce((total, kind) => total + journeys[kind].length, 0) +
    walls.length
  } screens -> artifacts/gallery/index.html`,
);
console.log(
  `Client: ${(clientSource.length / 1024).toFixed(0)} kB -> artifacts/gallery/catalogue.js`,
);
