import { z } from "zod";
import { randomBytes } from "node:crypto";

/**
 * Agent-controlled email inbox. Registration ceremonies need an address that
 * is fresh (never used at the provider) and receivable by the agent, so the
 * isolated browser can complete email verification without a person. The
 * inbox API token stays server-side; addresses and message contents never
 * enter chat or model context.
 */
export type InboxMessage = {
  to: string;
  subject?: string | undefined;
  text: string;
  at: number;
};

export type ProgrammableInbox = {
  /** A fresh address that has never been used at any provider. */
  provision(): Promise<string>;
  /** Newest message to the address at or after `since`, if any arrived. */
  latest(to: string, since: number): Promise<InboxMessage | undefined>;
};

/**
 * Minimal HTTP contract for a catch-all inbox service:
 *   POST {baseUrl}/addresses            -> { "address": "anything@domain" }
 *   GET  {baseUrl}/messages?to&since    -> { "messages": InboxMessage[] }
 */
export function createHttpInbox(options: {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
}): ProgrammableInbox {
  const fetcher = options.fetch ?? fetch;
  const headers = {
    accept: "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  };
  return {
    async provision() {
      const response = await fetcher(`${options.baseUrl}/addresses`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: { ...headers, "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("inbox unavailable");
      return z
        .object({ address: z.string().email() })
        .parse(await response.json()).address;
    },
    async latest(to, since) {
      const url = new URL(`${options.baseUrl}/messages`);
      url.searchParams.set("to", to);
      url.searchParams.set("since", String(since));
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(10_000),
        headers,
      });
      if (!response.ok) return undefined;
      const messages = z
        .object({
          messages: z
            .array(
              z.object({
                to: z.string().max(320),
                subject: z.string().max(998).optional(),
                text: z.string().max(65_536),
                at: z.number(),
              }),
            )
            .max(64),
        })
        .parse(await response.json()).messages;
      return messages
        .filter((message) => message.at >= since && message.to === to)
        .sort((left, right) => right.at - left.at)[0];
    },
  };
}

/** Generic verification extraction: numeric codes and confirm/verify links. */
export function verificationFromMessage(
  message: InboxMessage,
  allowedHost?: string,
): { code?: string; link?: string } | undefined {
  const code =
    /(?:code|pin)\D{0,24}\b(\d{4,8})\b/i.exec(message.text)?.[1] ??
    (/(?:code|pin)/i.test(message.text)
      ? /\b(\d{4,8})\b/.exec(message.text)?.[1]
      : undefined);
  const link = message.text
    .match(/https:\/\/[^\s<>"']{8,2048}/g)
    ?.map((href) => href.replace(/[.,;)\]]+$/, ""))
    .find((href) => {
      try {
        const url = new URL(href);
        if (allowedHost && url.hostname !== allowedHost) return false;
        return /verif|confirm|activat|token|code/i.test(
          `${url.pathname}${url.search}`,
        );
      } catch {
        return false;
      }
    });
  if (!code && !link) return undefined;
  return { ...(code ? { code } : {}), ...(link ? { link } : {}) };
}

/**
 * Disposable public inbox over the mail.tm API (compatible with mail.gw).
 * No API key: each provision creates a fresh account on an active public
 * domain, so the address has never been used at any provider. The account
 * password and JWT stay inside this closure.
 */
export function createMailTmInbox(
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): ProgrammableInbox {
  const base = (options.baseUrl ?? "https://api.mail.tm").replace(/\/$/, "");
  const fetcher = options.fetch ?? fetch;
  const tokens = new Map<string, string>();
  let domain: string | undefined;
  const call = async (path: string, init: RequestInit = {}) => {
    try {
      return await fetcher(`${base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch {
      return undefined;
    }
  };
  return {
    async provision() {
      if (!domain) {
        const response = await call("/domains?page=1");
        const raw: unknown = response?.ok ? await response.json() : undefined;
        // mail.tm content-negotiates: accept: application/json returns a bare
        // array, other accepts return the JSON-LD hydra collection.
        const active = z
          .array(z.object({ domain: z.string(), isActive: z.boolean() }))
          .max(64)
          .safeParse(
            Array.isArray(raw)
              ? raw
              : (raw as { "hydra:member"?: unknown } | undefined)?.[
                  "hydra:member"
                ],
          );
        domain = active.success
          ? active.data.find((item) => item.isActive)?.domain
          : undefined;
        if (!domain) throw new Error("inbox unavailable");
      }
      const address = `cmy${randomBytes(6).toString("hex")}@${domain}`;
      const password = randomBytes(16).toString("base64url");
      const created = await call("/accounts", {
        method: "POST",
        body: JSON.stringify({ address, password }),
      });
      if (!created?.ok) throw new Error("inbox unavailable");
      const token = await call("/token", {
        method: "POST",
        body: JSON.stringify({ address, password }),
      });
      const parsed = z
        .object({ token: z.string() })
        .safeParse(token?.ok ? await token.json() : undefined);
      if (!parsed.success) throw new Error("inbox unavailable");
      tokens.set(address, parsed.data.token);
      return address;
    },
    async latest(to, since) {
      const jwt = tokens.get(to);
      if (!jwt) return undefined;
      const list = await call("/messages?page=1", {
        headers: { authorization: `Bearer ${jwt}` },
      });
      const rawList: unknown = list?.ok ? await list.json() : undefined;
      const items = z
        .array(
          z.object({
            id: z.string().max(64),
            subject: z.string().max(998).optional(),
            createdAt: z.string(),
          }),
        )
        .max(64)
        .safeParse(
          Array.isArray(rawList)
            ? rawList
            : (rawList as { "hydra:member"?: unknown } | undefined)?.[
                "hydra:member"
              ],
        );
      if (!items.success) return undefined;
      const candidates = items.data
        .filter((item) => Date.parse(item.createdAt) >= since - 60_000)
        .sort(
          (left, right) =>
            Date.parse(right.createdAt) - Date.parse(left.createdAt),
        );
      for (const item of candidates.slice(0, 3)) {
        const full = await call(`/messages/${item.id}`, {
          headers: { authorization: `Bearer ${jwt}` },
        });
        const message = z
          .object({
            subject: z.string().max(998).optional(),
            text: z.string().max(65_536).nullish(),
            html: z.array(z.string().max(65_536)).max(8).nullish(),
            createdAt: z.string(),
          })
          .safeParse(full?.ok ? await full.json() : undefined);
        if (!message.success) continue;
        const text =
          message.data.text ??
          (message.data.html ?? []).join("\n").replace(/<[^>]+>/g, " ");
        return {
          to,
          ...(message.data.subject ? { subject: message.data.subject } : {}),
          text: text.slice(0, 65_536),
          at: Date.parse(message.data.createdAt),
        };
      }
      return undefined;
    },
  };
}
