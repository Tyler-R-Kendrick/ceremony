import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CeremonyView } from "../src/react/index.js";
import {
  carrierFor,
  catalogue,
  flowKinds,
  journeys,
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
    client: { manifest, context: {}, selection: "automatic" },
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
          <div class="screen">${screen(kind, step)}</div>
        </li>`,
        )
        .join("")}
    </ol>
  </article>`;

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
      <strong>What this is:</strong> the project's own scenario catalogue, and
      specimens of the real screens. <strong>What it is not:</strong> a live
      session. A published page makes no network requests, so no provider is
      contacted here and no credential is handled. Live connections run in the
      reference application against the connection server.
    </p>
  </header>

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
          <div class="screen">${screen("form", step)}</div>
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
  const rows = [...document.querySelectorAll("tbody tr")];
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
`;

mkdirSync(fileURLToPath(out), { recursive: true });
writeFileSync(fileURLToPath(new URL("index.html", out)), page);
console.log(
  `Auth catalogue: ${entries.length} scenarios, ${flowKinds.length} flows, ${
    flowKinds.reduce((total, kind) => total + journeys[kind].length, 0) +
    walls.length
  } screens -> artifacts/gallery/index.html`,
);
