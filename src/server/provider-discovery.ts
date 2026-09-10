import { z } from "zod";
import type { FlowKind } from "../core/schema.js";

const wellKnown = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/.well-known/oauth-protected-resource",
  "/auth.md",
  "/openapi.json",
] as const;

export type DiscoveredAuth = {
  origin: string;
  documents: string[];
  methods: FlowKind[];
  openApiUrl?: string;
  searchUsed: boolean;
};

export type ProviderSearch = (
  query: string,
) => Promise<Array<{ title: string; url: string }>>;

function publicOrigin(
  value: string,
  allowLoopback = false,
): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return;
    if (url.protocol === "https:") return url.origin;
    if (
      allowLoopback &&
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      return url.origin;
  } catch {
    /* Invalid URL is not a crawl target. */
  }
}

async function read(
  fetcher: typeof fetch,
  url: string,
): Promise<{ status: number; type: string; body: string } | undefined> {
  try {
    const response = await fetcher(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
      headers: { accept: "application/json, text/plain, text/markdown" },
    });
    const type = response.headers.get("content-type") ?? "";
    const body = (await response.text()).slice(0, 32_768);
    return { status: response.status, type, body };
  } catch {
    return;
  }
}

function methodsFromMetadata(body: string): FlowKind[] {
  const kinds = new Set<FlowKind>();
  try {
    const json = z
      .object({
        grant_types_supported: z.array(z.string()).max(32).optional(),
        authorization_endpoint: z.string().optional(),
        device_authorization_endpoint: z.string().optional(),
        openapi: z.string().optional(),
      })
      .passthrough()
      .parse(JSON.parse(body));
    if (json.authorization_endpoint) kinds.add("oauth-code");
    if (
      json.device_authorization_endpoint ||
      json.grant_types_supported?.includes(
        "urn:ietf:params:oauth:grant-type:device_code",
      )
    )
      kinds.add("device");
    if (json.openapi) kinds.add("oauth-code");
  } catch {
    const lower = body.toLowerCase();
    if (lower.includes("anonymous") && lower.includes("claim"))
      kinds.add("authmd-anonymous");
    else if (lower.includes("api key") || lower.includes("api-key"))
      kinds.add("api-key");
  }
  return [...kinds];
}

async function crawlOrigin(
  origin: string,
  fetcher: typeof fetch,
): Promise<DiscoveredAuth> {
  const documents: string[] = [];
  const methods = new Set<FlowKind>();
  let openApiUrl: string | undefined;
  for (const path of wellKnown) {
    const url = `${origin}${path}`;
    const response = await read(fetcher, url);
    if (!response || response.status !== 200) continue;
    documents.push(path);
    if (
      path === "/openapi.json" &&
      origin.startsWith("https:") &&
      response.body.includes('"openapi"')
    )
      openApiUrl = url;
    for (const kind of methodsFromMetadata(response.body)) methods.add(kind);
  }
  return {
    origin,
    documents,
    methods: [...methods],
    ...(openApiUrl ? { openApiUrl } : {}),
    searchUsed: false,
  };
}

/** Bounded well-known crawl. Never follows credentials, query URLs, or arbitrary HTML. */
export async function discoverProviderAuth(
  origins: string[],
  options: {
    fetch?: typeof fetch;
    search?: ProviderSearch;
    query?: string;
    allowLoopbackHttp?: boolean;
  } = {},
): Promise<DiscoveredAuth> {
  const fetcher = options.fetch ?? fetch;
  const seen = new Set<string>();
  for (const candidate of origins) {
    const origin = publicOrigin(candidate, options.allowLoopbackHttp);
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    const found = await crawlOrigin(origin, fetcher);
    if (found.documents.length) return found;
  }
  if (!options.search || !options.query)
    return {
      origin: [...seen][0] ?? "",
      documents: [],
      methods: [],
      searchUsed: false,
    };
  const hits = (
    await options.search(`${options.query} OAuth OpenID well-known`)
  ).slice(0, 5);
  for (const hit of hits) {
    const origin = publicOrigin(hit.url, options.allowLoopbackHttp);
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    const found = await crawlOrigin(origin, fetcher);
    if (found.documents.length) return { ...found, searchUsed: true };
  }
  return {
    origin: [...seen][0] ?? "",
    documents: [],
    methods: [],
    searchUsed: true,
  };
}
