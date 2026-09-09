import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGateway, type LanguageModel } from "ai";

export interface ModelConfiguration {
  model?: string;
  endpoint?: string;
  apiKey?: string;
  gateway?: boolean;
}
/** No implicit gateway, model name, or ambient paid routing. */
export function configuredModel(
  config: ModelConfiguration,
): LanguageModel | undefined {
  if (!config.model && !config.endpoint && !config.gateway) return undefined;
  if (
    !config.model ||
    config.model.length > 200 ||
    (config.gateway && config.endpoint)
  )
    throw new Error("Invalid model configuration");
  if (config.gateway)
    return createGateway(config.apiKey ? { apiKey: config.apiKey } : {})(
      config.model,
    );
  if (!config.endpoint) throw new Error("Model endpoint is required");
  const endpoint = new URL(config.endpoint);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search ||
    (endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
      )) ||
    !endpoint.pathname.endsWith("/chat/completions")
  )
    throw new Error("Invalid model endpoint");
  const baseURL = endpoint.href.slice(0, -"/chat/completions".length);
  return createOpenAICompatible({
    name: "ceremony-configured",
    baseURL,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    fetch: (url, init) => {
      if (String(url) !== endpoint.href)
        throw new Error("Model endpoint mismatch");
      return fetch(url, { ...init, redirect: "error" });
    },
  }).chatModel(config.model);
}
/** Rejected text is neither returned nor logged. This heuristic cannot identify arbitrary passwords. */
export function validateAgentText(
  text: string,
  protectedValues: readonly string[] = [],
): string {
  if (
    text.length > 2000 ||
    /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+|\bgh[pousr]_[A-Za-z0-9]+|\bgithub_pat_[A-Za-z0-9_]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\bBearer\s+\S+)/i.test(
      text,
    ) ||
    protectedValues.some((value) => value.length > 0 && text.includes(value))
  )
    throw new Error("Use private collection for credentials");
  return text;
}
