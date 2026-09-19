import { createRoot } from "react-dom/client";
import {
  createConnectorClient,
  readConnectorReturn,
  relayHandoffReturn,
} from "../../src/core/connectors/client.js";
import { ConnectorWorkspace } from "../../examples/web/connectors.js";

/**
 * The browser harness page.
 *
 * It mounts the shipped composition — the same `ConnectorWorkspace` the
 * reference application mounts — against the fixture double served from this
 * origin. Nothing about the components is replaced; the switches below only
 * decide what the browser does to them: how often to poll, and whether a
 * popup is allowed to open at all.
 *
 * The same bundle also serves the provider's return page, so the callback
 * relay under test is the one that ships.
 */

const params = new URLSearchParams(location.search);

function mountWorkspace() {
  const host = document.getElementById("root");
  if (!host) throw new Error("No harness root");
  const blocked = params.get("popup") === "blocked";
  const poll = Number(params.get("poll") ?? "200");
  createRoot(host).render(
    <ConnectorWorkspace
      client={createConnectorClient({})}
      pollIntervalMs={Number.isFinite(poll) && poll > 0 ? poll : 200}
      openWindow={(url, name) => (blocked ? null : window.open(url, name))}
      search={location.search}
    />,
  );
}

if (location.pathname === "/callback") {
  // A window this app opened tells its opener and closes. A tab that got here
  // directly — a blocked popup, a reload, a provider that navigated the whole
  // page — goes back to the connection instead.
  if (!relayHandoffReturn(window)) {
    const back = readConnectorReturn(location.search);
    const query = new URLSearchParams(params);
    query.delete("outcome");
    if (back.connector) query.set("connector", back.connector);
    if (back.connection) query.set("connection", back.connection);
    location.replace(`/?${query.toString()}`);
  }
} else mountWorkspace();
