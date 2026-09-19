import { createRoot } from "react-dom/client";
import {
  Ceremony,
  TeachingConnection,
  createHttpTransport,
} from "../../src/react/index.js";
import {
  manifestSchema,
  type ActionEvent,
  type ActionFailureEvent,
} from "../../src/core/index.js";

/** Real component/transport, with observable host callbacks; no WebMCP polyfill. */
export async function mountHarness(connectorId = "github") {
  const config = await fetch("/api/config").then((response) => response.json());
  const manifest = config.manifests
    .map((value: unknown) => manifestSchema.parse(value))
    .find((value: { id: string }) => value.id === connectorId);
  if (!manifest) throw new Error("Missing test connector");
  const host = document.createElement("section");
  host.id = "hook-harness";
  // The harness is injected into the host page in order to be driven, and the
  // connect surface's Add Connection drawer lays a fixed, full-viewport scrim
  // over everything at z-index 40. Appended to the body in normal flow, the
  // harness ends up underneath it and every click meant for the harness lands
  // on the scrim instead. A stacking context of its own puts it back where a
  // consuming app's own UI would be. Nothing about the application changes,
  // and no assertion moves: what is under test here is WebMCP registration and
  // execution, not which layer the drawer paints on.
  host.style.position = "relative";
  host.style.zIndex = "50";
  const output = document.createElement("output");
  output.id = "hook-events";
  output.textContent = "[]";
  const content = document.createElement("div");
  const unmount = document.createElement("button");
  unmount.textContent = "Unmount harness";
  host.append(output, content, unmount);
  document.body.append(host);
  const events: ((ActionEvent | ActionFailureEvent) & { status: string })[] =
    [];
  const record = (status: string, event: ActionEvent | ActionFailureEvent) => {
    events.push({ ...event, status });
    output.textContent = JSON.stringify(events);
  };
  const root = createRoot(content);
  unmount.onclick = () => root.unmount();
  root.render(
    <Ceremony
      manifest={manifest}
      selection="manual"
      transport={createHttpTransport()}
      webmcp={{ prefix: "test_ceremony" }}
      onActionSuccess={async (event) => {
        record("success", event);
        throw new Error("host observer rejected");
      }}
      onActionFailure={(event) => {
        record("failure", event);
        throw new Error("host observer threw");
      }}
    />,
  );
}

export function mountTeachingHarness(prefix: string) {
  const host = document.createElement("section");
  host.id = `${prefix}-host`;
  const content = document.createElement("div");
  const unmount = document.createElement("button");
  unmount.textContent = `Unmount ${prefix}`;
  host.append(content, unmount);
  document.body.append(host);
  const root = createRoot(content);
  unmount.onclick = () => root.unmount();
  root.render(
    <TeachingConnection
      webmcp={{ prefix }}
      onRunChange={() => {}}
      autoFocus={false}
    />,
  );
}
