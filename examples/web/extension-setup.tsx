import { useEffect, useState } from "react";

const discovery = [
  ["GitHub", "https://github.com/login"],
  ["Google", "https://accounts.google.com/ServiceLogin"],
  ["Microsoft", "https://login.microsoftonline.com/"],
] as const;

type Metadata = {
  version: string;
  protocol: number;
  extensionId: string;
  downloadUrl: string;
  sha256: string;
};
type HandoffPort = {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};
type Runtime = {
  lastError?: { message?: string };
  sendMessage(
    id: string,
    message: unknown,
    callback: (reply: unknown) => void,
  ): void;
  connect?(id: string, info: { name: string }): HandoffPort;
};
export default function ExtensionSetup() {
  const [metadata, setMetadata] = useState<Metadata>();
  const [status, setStatus] = useState("Checking extension build…");
  const [connected, setConnected] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => {
    let live = true;
    void fetch("/extension/metadata.json", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("missing");
        const value = (await response.json()) as Metadata;
        if (
          value.protocol !== 1 ||
          !/^[a-p]{32}$/.test(value.extensionId) ||
          value.downloadUrl !== "/extension/ceremony-browser-login.zip" ||
          !/^\d+\.\d+\.\d+$/.test(value.version)
        )
          throw new Error("invalid");
        if (live) {
          setMetadata(value);
          setStatus("Not connected");
        }
      })
      .catch(() => {
        if (live)
          setStatus(
            "Extension build unavailable. Run npm run build:extension in your Ceremony checkout.",
          );
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!metadata) return;
    let live = true;
    const check = () => {
      void send(metadata, "ceremony.ping")
        .then((reply) => {
          if (!live) return;
          const ready =
            reply.protocol === 1 && reply.version === metadata.version;
          setConnected(ready);
          setStatus(
            ready
              ? `Connected · v${reply.version}`
              : "Update required. Download the latest build and reload the extension.",
          );
        })
        .catch(() => {
          if (live) {
            setConnected(false);
            setStatus(
              "Not connected. Install or enable the extension, then check again.",
            );
          }
        });
    };
    check();
    addEventListener("focus", check);
    const handler = () => check();
    document.addEventListener("ceremony-check-extension", handler);
    return () => {
      live = false;
      removeEventListener("focus", check);
      document.removeEventListener("ceremony-check-extension", handler);
    };
  }, [metadata]);
  useEffect(() => {
    if (!connected || !metadata) return;
    const runtime = (
      globalThis as typeof globalThis & { chrome?: { runtime?: Runtime } }
    ).chrome?.runtime;
    if (!runtime?.connect) return;
    const port = runtime.connect(metadata.extensionId, {
      name: "ceremony.handoffs",
    });
    port.onMessage.addListener((raw: unknown) => {
      const message = raw as { type?: string; event?: { runId?: string } };
      if (message.type !== "ceremony.handoff" || !message.event?.runId) return;
      port.postMessage({
        type: "ceremony.resolve-handoff",
        runId: message.event.runId,
        resolution: "unavailable",
      });
    });
    return () => port.disconnect();
  }, [connected, metadata]);
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus(`Copy manually: ${text}`);
    }
  }
  return (
    <details className="extension-setup">
      <summary>
        Browser login extension · {connected ? "Connected" : "Set up"}
      </summary>
      <p role="status">{status}</p>
      <p>
        Local browser automation requires this Chromium extension. Other
        Ceremony connection methods do not. This is a developer preview, not a
        published store extension.
      </p>
      {metadata && (
        <>
          <p>
            <a href={metadata.downloadUrl} download>
              Download extension ZIP · v{metadata.version}
            </a>
          </p>
          <ol>
            <li>Extract the ZIP into a folder you will keep.</li>
            <li>
              Copy <code>chrome://extensions</code> into Chrome’s address bar.{" "}
              <button onClick={() => void copy("chrome://extensions")}>
                Copy extensions-page address
              </button>
            </li>
            <li>
              Enable <strong>Developer mode</strong>, then choose{" "}
              <strong>Load unpacked</strong>.
            </li>
            <li>
              Select the extracted folder containing <code>manifest.json</code>
              —not the ZIP or its parent folder.
            </li>
            <li>
              Return here and choose <strong>Check connection</strong>. Keep the
              extracted folder in place.
            </li>
          </ol>
          <p>
            For Edge use <code>edge://extensions</code>. Chromium is the tested
            browser; Firefox and Safari are not supported by this build.
          </p>
          <button
            onClick={() =>
              document.dispatchEvent(new Event("ceremony-check-extension"))
            }
          >
            Check connection
          </button>
          <button
            disabled={!connected}
            onClick={() =>
              void send(metadata, "ceremony.open").catch(() => {
                setConnected(false);
                setStatus(
                  "Could not open extension. Enable it and check again.",
                );
              })
            }
          >
            Open browser login
          </button>
          <p>
            Updates: replace the extracted build, click <strong>Reload</strong>{" "}
            on its extension card, then check connection again. Browser
            installation and site permissions require your approval.
          </p>
        </>
      )}
      <h3>Provider catalog</h3>
      <p>
        Open your provider, then use the extension to approve a bounded login
        sequence. Catalog links never grant credential access.
      </p>
      <ul>
        {discovery.map(([provider, entry]) => (
          <li key={entry}>
            <a href={entry} target="_blank" rel="noopener noreferrer">
              {provider} sign-in
            </a>
            {
              " — profile pending validation; account completion requires your review."
            }
          </li>
        ))}
      </ul>
      <p>
        In the extension, enable multi-step mode for identifier → password
        login. An approved run allows at most two submissions to the exact
        selected origin. CAPTCHA, MFA, passkeys and consent emit handoff events
        the owning app can subscribe to; they stay human unless that app
        resolves them. Advanced frame and popup targeting requires explicit
        destination approval.
      </p>
      <details>
        <summary>Building locally</summary>
        <p>
          Run <code>npm run build:extension</code> from your checkout. Load the
          printed absolute unpacked path ending in{" "}
          <code>/extension-dist/chromium</code>. The build also creates the
          download served here. Do not load the source directory.
        </p>
      </details>
      <p aria-live="polite">{copyStatus}</p>
    </details>
  );
}
function send(
  metadata: Metadata,
  type: string,
): Promise<{ protocol?: number; version?: string }> {
  const runtime = (
    globalThis as typeof globalThis & { chrome?: { runtime?: Runtime } }
  ).chrome?.runtime;
  return new Promise((resolve, reject) => {
    if (!runtime?.sendMessage) {
      reject(new Error("unavailable"));
      return;
    }
    const timer = setTimeout(() => reject(new Error("timeout")), 2000);
    try {
      runtime.sendMessage(
        metadata.extensionId,
        { type, protocol: 1 },
        (reply) => {
          clearTimeout(timer);
          if (runtime.lastError || !reply || typeof reply !== "object")
            reject(new Error("not-connected"));
          else resolve(reply);
        },
      );
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}
