import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ConnectorCard, CeremonyView } from "../src/react/index.js";
import { manifests } from "../examples/manifests.js";
import { resolverMountId, resolverPayloadId } from "./gallery-ids.js";
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

const frame = (html) => `<div class="screen">
          <p class="specimen-tag">specimen · nothing here can be used</p>
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

/**
 * The kickoff card, before any flow starts.
 *
 * `status` is presentation the host supplies — a page cannot know whether
 * anything is connected — so the three are shown side by side as the states a
 * host can put a card into, not as a claim about any account.
 */
const cardStates = [
  {
    status: "available",
    note: "not connected yet",
    intent: {
      permissions: [
        { label: "Read your repositories" },
        { label: "Open pull requests for you" },
      ],
    },
  },
  { status: "connected", note: "already connected, so it offers management" },
  { status: "attention", note: "connected, but something needs a person" },
];

const cards = () =>
  cardStates
    .map(({ status, note, intent }, index) => {
      const manifest = manifests[index % manifests.length];
      return `
      <li>
        <div class="screen-label"><span>${escape(note)}</span></div>
        ${frame(
          renderToString(
            createElement(ConnectorCard, {
              manifest,
              status,
              // Never pressed: the specimen is inoperable by construction, and
              // a page with no network has nothing honest to do on a press.
              onConnect: () => {},
              ...(intent ? { intent } : {}),
            }),
          ),
        )}
      </li>`;
    })
    .join("");

/** What each flow is, in the terms the rest of the project uses. */
const flowNotes = {
  "oauth-code": "The person approves at the provider and is brought back.",
  "github-app":
    "An application is registered and installed before access exists.",
  device: "A code is read here and entered somewhere else.",
  "authmd-anonymous":
    "Access begins with nobody attached, and can be claimed later.",
  "api-key": "A credential the person already holds is collected privately.",
  basic: "A username and password the provider accepts directly.",
  form: "Whatever the provider's own form asks for.",
};

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
 * The resolver, compiled for the browser.
 *
 * A separate file rather than an inline script: the page would otherwise have
 * to escape whatever the minifier happened to emit, and a bundle that contains
 * the wrong six characters would end the script tag early and take the section
 * with it. It also keeps the document itself readable at its own size.
 */
const resolverBundle = await build({
  entryPoints: [fileURLToPath(new URL("scripts/gallery-client.ts", root))],
  bundle: true,
  format: "iife",
  minify: true,
  target: "es2022",
  write: false,
  logLevel: "silent",
});
const resolverSource = resolverBundle.outputFiles[0].text;

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

const flowPanel = (kind) => `
  <article class="flow" id="flow-${escape(kind)}">
    <header class="flow-head">
      <h3><code class="kind">${escape(kind)}</code></h3>
      <p>${escape(flowNotes[kind])}</p>
      <p class="flow-count">${count(
        entries.filter((entry) => entry.flowKind === kind).length,
        "scenario",
      )} · ${count(journeys[kind].length, "screen")}</p>
    </header>
    <ol class="screens">
      ${journeys[kind]
        .map(
          (step, index) => `
        <li>
          <div class="screen-label">
            <span class="screen-index">${index + 1}</span>
            <code>${escape(step)}</code>
            <span>${escape(stepNotes[step])}</span>
          </div>
          ${frame(screen(kind, step))}
        </li>`,
        )
        .join("")}
    </ol>
  </article>`;

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

const resolver = `
  <section class="movement" aria-labelledby="resolve-heading">
    <div class="movement-head">
      <h2 id="resolve-heading">Resolve it yourself</h2>
      <p>
        The part of this page that runs. Nobody is asked to choose between PKCE
        and a device code, because a person cannot answer that and should not
        have to — everything needed to decide it is something the host already
        knew. State it here and every connector re-decides: which route, what it
        costs somebody, and what was ruled out and why.
      </p>
    </div>
    <div class="resolver" id="${resolverMountId}">
      <form class="declaration">
        ${declarations.map(choiceGroup).join("")}
        ${permissionGroup()}
        <div class="source-wrap">
          <p class="source-label">What that declares</p>
          <pre class="source" data-declaration></pre>
        </div>
      </form>
      <div class="results">
        <p class="tally" data-tally aria-live="polite">
          The resolver runs in your browser. With scripting off this section
          stays empty; nothing else on the page depends on it.
        </p>
        <div class="resolutions" data-resolutions></div>
      </div>
    </div>
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
    <h1>Every way a connection actually starts</h1>
    <p class="lede">
      ${entries.length} scenarios across ${flowKinds.length} flow kinds and
      ${families.size} families, including ${registration.length} distinct ways an
      account gets created. Every screen below is rendered by the same component
      the product ships, from a snapshot the production schema accepted.
    </p>
    <p class="honesty">
      <strong>What this is:</strong> the project's own scenario catalogue,
      specimens of the real screens, and a resolver that really runs.
      <strong>What it is not:</strong> a live session. A published page makes no
      network request at all, so no provider is contacted here and no credential
      is handled — which is why nothing inside a specimen can be pressed. A
      button wired to do nothing would be the dishonest option. Resolution needs
      no provider, so <a href="#${resolverMountId}">the resolver below</a> is the real one,
      compiled into this page and deciding against the real manifests as you
      change the declaration. Live connections run in the reference application,
      against the connection server.
    </p>
  </header>

  <section class="movement" aria-labelledby="cards-heading">
    <div class="movement-head">
      <h2 id="cards-heading">Where it starts</h2>
      <p>
        Before any flow runs, a card says what the service is, what the
        integration will be able to do in the host's own words, and how many
        times the route will stop to ask a person. That last number is the one
        the resolver minimises, so a card cannot advertise a cost the chosen
        route was not chosen for. These three are specimens, so their buttons
        do not respond — pressing Connect needs a provider, and this page
        reaches none. The part that needs no provider is
        <a href="#${resolverMountId}">directly below</a>, and it runs.
      </p>
    </div>
    <ol class="screens">${cards()}</ol>
  </section>
${resolver}

  <section class="movement" aria-labelledby="flows-heading">
    <div class="movement-head">
      <h2 id="flows-heading">The flows</h2>
      <p>
        Seven kinds, each shown in the order it actually reaches its screens.
        A redirect never asks for input; a device flow waits; only anonymous
        access can be claimed afterwards.
      </p>
    </div>
    <div class="flows">${flowKinds.map(flowPanel).join("")}</div>
  </section>

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
<script src="resolver.js"></script>
`;

mkdirSync(fileURLToPath(out), { recursive: true });
writeFileSync(fileURLToPath(new URL("index.html", out)), page);
writeFileSync(fileURLToPath(new URL("resolver.js", out)), resolverSource);
console.log(
  `Auth catalogue: ${entries.length} scenarios, ${flowKinds.length} flows, ${
    flowKinds.reduce((total, kind) => total + journeys[kind].length, 0) +
    walls.length
  } screens -> artifacts/gallery/index.html`,
);
console.log(
  `Resolver: ${(resolverSource.length / 1024).toFixed(0)} kB -> artifacts/gallery/resolver.js`,
);
