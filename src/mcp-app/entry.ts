import { mountPrivateCollector } from "./index.js";

/**
 * Browser entry for the private collector, bundled into the MCP App resource.
 *
 * The broker origin is a placeholder rather than a build-time constant: the
 * same bundle is served by a local tunnel and by a deployment, and
 * `registerPrivateCollector` only learns which origin it is registering for at
 * registration time. The server substitutes it then.
 *
 * If the substitution never happens, `mountPrivateCollector` refuses the
 * placeholder because it is not an HTTPS origin — a collector that cannot name
 * its broker must not render at all.
 */

const BROKER_ORIGIN = "__CEREMONY_BROKER_ORIGIN__";

const root = document.getElementById("collector");
if (root) {
  void mountPrivateCollector(root, BROKER_ORIGIN).catch(() => {
    root.textContent =
      "This credential collector could not start. Continue in the ceremony webpage; never enter credentials in chat.";
  });
}
