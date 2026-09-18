/**
 * One seam over the two WebExtension dialects this extension ships to.
 *
 * Chromium exposes the API as `chrome` and binds a message to a document id;
 * Gecko exposes the same calls as `browser`, answers with promises instead of
 * trailing callbacks, and has no document-id option anywhere. Without a seam the
 * worker would grow a second copy of every check, and two copies of a security
 * check are two things to keep in step. Nothing here decides anything: it moves
 * arguments and normalizes failure, and every origin, opener, permission,
 * document and replay check stays with the caller that already owns it.
 */

export type ExtensionSender = {
  id?: string;
  url?: string;
  tab?: { id?: number };
  documentId?: string;
  frameId?: number;
};

export type ExtensionMessageListener = (
  message: unknown,
  sender: ExtensionSender,
  reply: (value: unknown) => void,
) => boolean | void;

export type ExtensionPort = {
  name: string;
  sender?: ExtensionSender;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};

export type TabSummary = {
  id?: number;
  url?: string;
  title?: string;
  openerTabId?: number;
};

export type InjectionResult = { documentId?: string };

/**
 * `documentIdMessaging` is the only behavioural difference callers may branch
 * on, because it is the only one a caller cannot paper over: where the engine
 * will not bind delivery to a document, the document's own reference has to
 * travel in the message and be checked in the isolated world instead.
 */
export type PlatformCapabilities = {
  readonly documentIdMessaging: boolean;
  readonly externalWebMessaging: boolean;
};

/** Which dialect the resolved API speaks. */
export type CallStyle = "promise" | "callback";

export interface ExtensionPlatform {
  readonly style: CallStyle;
  readonly capabilities: PlatformCapabilities;
  readonly runtime: {
    readonly id: string | undefined;
    getURL(path: string): string;
    getManifestVersion(): string;
    connect(info: { name: string }): ExtensionPort;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage(listener: ExtensionMessageListener): void;
    onMessageExternal(listener: ExtensionMessageListener): void;
    onConnect(listener: (port: ExtensionPort) => void): void;
    onConnectExternal(listener: (port: ExtensionPort) => void): void;
  };
  readonly action: { onClicked(listener: () => void): void };
  readonly tabs: {
    query(query: object): Promise<TabSummary[]>;
    get(id: number): Promise<TabSummary>;
    create(options: { url: string }): Promise<unknown>;
    sendMessage(
      tabId: number,
      message: unknown,
      options?: { documentId?: string; frameId?: number },
    ): Promise<unknown>;
  };
  readonly scripting: {
    executeScript(options: {
      target: { tabId: number; frameIds?: number[] };
      files: string[];
    }): Promise<InjectionResult[]>;
  };
  readonly permissions: {
    request(options: { origins: string[] }): Promise<boolean>;
    contains(options: { origins: string[] }): Promise<boolean>;
  };
  /** `storage.session`. Never `local` or `sync`: run state must not outlive the browser. */
  readonly sessionStorage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(value: Record<string, unknown>): Promise<void>;
    remove(key: string): Promise<void>;
  };
}

type Unknowns = Record<string, unknown>;
type Method = (...args: unknown[]) => unknown;

export type PlatformScope = {
  browser?: unknown;
  chrome?: unknown;
};

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

function namespace(api: Unknowns, path: string): Unknowns | undefined {
  let current: unknown = api;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Unknowns)[segment];
  }
  return current && typeof current === "object"
    ? (current as Unknowns)
    : undefined;
}

/** The failure a callback dialect reports out of band, as a rejection. */
function lastErrorMessage(api: Unknowns): string | undefined {
  const runtime = namespace(api, "runtime");
  const error = runtime?.["lastError"];
  if (!error) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message ? message : "extension error";
}

function invoke<T>(
  api: Unknowns,
  owner: Unknowns | undefined,
  name: string,
  style: CallStyle,
  args: unknown[],
): Promise<T> {
  const method = owner?.[name];
  if (typeof method !== "function")
    return Promise.reject(new Error(`Unsupported extension API: ${name}`));
  if (style === "promise") {
    try {
      return Promise.resolve((method as Method).apply(owner, args) as T);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("call"));
    }
  }
  return new Promise<T>((resolve, reject) => {
    const settle = (value: unknown) => {
      const failure = lastErrorMessage(api);
      if (failure) reject(new Error(failure));
      else resolve(value as T);
    };
    let returned: unknown;
    try {
      returned = (method as Method).apply(owner, [...args, settle]);
    } catch (error) {
      reject(error instanceof Error ? error : new Error("call"));
      return;
    }
    // A host that answers a promise anyway wins the race: one settlement, and
    // it is the one that can carry a rejection rather than a silent undefined.
    if (isThenable(returned))
      Promise.resolve(returned).then((value) => resolve(value as T), reject);
  });
}

function addListener(
  api: Unknowns,
  path: string,
  listener: (...args: never[]) => unknown,
): void {
  const event = namespace(api, path);
  const add = event?.["addListener"];
  // An event this engine does not have is not an error: `onMessageExternal`
  // simply never fires on Gecko, and the relay covers that path instead.
  if (typeof add === "function") (add as Method).apply(event, [listener]);
}

/** The extension's own URL scheme, which is the engine naming itself. */
function extensionScheme(api: Unknowns): string {
  try {
    const runtime = namespace(api, "runtime");
    const getURL = runtime?.["getURL"];
    if (typeof getURL !== "function") return "";
    const url = (getURL as Method).apply(runtime, [""]);
    return typeof url === "string" ? url : "";
  } catch {
    return "";
  }
}

/**
 * Resolve the API object as `browser ?? chrome`, then ask the engine which one
 * it is. Which global answered cannot settle that on its own: Chromium defines
 * `browser` too, as a separate object rather than an alias, so a `browser`
 * global is not evidence of Gecko. The extension's own URL is evidence — only
 * Gecko serves it from `moz-extension:` — and each engine is then driven
 * through the namespace whose dialect is specified: Gecko's promise-only
 * `browser`, Chromium's `chrome`, which takes a trailing callback everywhere
 * this extension calls it.
 */
export function createPlatform(
  scope: PlatformScope = globalThis as PlatformScope,
): ExtensionPlatform {
  const preferred = (scope.browser ?? scope.chrome) as Unknowns | undefined;
  if (!preferred || typeof preferred !== "object")
    throw new Error("No WebExtension API in this scope");
  const gecko = extensionScheme(preferred).startsWith("moz-extension://");
  const fallback = (
    typeof scope.chrome === "object" && scope.chrome ? scope.chrome : preferred
  ) as Unknowns;
  const api = gecko ? preferred : fallback;
  const style: CallStyle = gecko ? "promise" : "callback";
  const call = <T>(path: string, name: string, ...args: unknown[]) =>
    invoke<T>(api, namespace(api, path), name, style, args);
  return {
    style,
    capabilities: {
      // Chromium returns and accepts document ids; Gecko has neither the
      // `executeScript` field nor the `tabs.sendMessage` option.
      documentIdMessaging: !gecko,
      // Gecko ignores `externally_connectable`, so a web page cannot reach the
      // background directly there however the manifest is written.
      externalWebMessaging: !gecko,
    },
    runtime: {
      get id() {
        const value = namespace(api, "runtime")?.["id"];
        return typeof value === "string" ? value : undefined;
      },
      getURL(path) {
        const runtime = namespace(api, "runtime");
        return (runtime?.["getURL"] as Method).apply(runtime, [path]) as string;
      },
      getManifestVersion() {
        const runtime = namespace(api, "runtime");
        const manifest = (runtime?.["getManifest"] as Method).apply(
          runtime,
          [],
        ) as { version?: unknown };
        return typeof manifest?.version === "string" ? manifest.version : "";
      },
      connect(info) {
        const runtime = namespace(api, "runtime");
        return (runtime?.["connect"] as Method).apply(runtime, [
          info,
        ]) as ExtensionPort;
      },
      sendMessage: (message) => call("runtime", "sendMessage", message),
      onMessage: (listener) =>
        addListener(api, "runtime.onMessage", listener as never),
      onMessageExternal: (listener) =>
        addListener(api, "runtime.onMessageExternal", listener as never),
      onConnect: (listener) =>
        addListener(api, "runtime.onConnect", listener as never),
      onConnectExternal: (listener) =>
        addListener(api, "runtime.onConnectExternal", listener as never),
    },
    action: {
      onClicked: (listener) =>
        addListener(api, "action.onClicked", listener as never),
    },
    tabs: {
      query: (query) => call("tabs", "query", query),
      get: (id) => call("tabs", "get", id),
      create: (options) => call("tabs", "create", options),
      sendMessage: (tabId, message, options) =>
        options === undefined
          ? call("tabs", "sendMessage", tabId, message)
          : call("tabs", "sendMessage", tabId, message, options),
    },
    scripting: {
      executeScript: (options) => call("scripting", "executeScript", options),
    },
    permissions: {
      request: (options) => call("permissions", "request", options),
      contains: (options) => call("permissions", "contains", options),
    },
    sessionStorage: {
      get: (key) => call("storage.session", "get", key),
      set: (value) => call("storage.session", "set", value),
      remove: (key) => call("storage.session", "remove", key),
    },
  };
}
