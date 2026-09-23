import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGateway, type LanguageModel } from "ai";

export interface ModelConfiguration {
  model?: string;
  endpoint?: string;
  apiKey?: string;
  gateway?: boolean;
  /**
   * Native provider protocol. Omitted means the OpenAI-compatible endpoint (or
   * the Gateway when `gateway` is set), exactly as before this option existed.
   */
  provider?: "anthropic";
}
const anthropicMessages = "https://api.anthropic.com/v1/messages";
/**
 * Reads only the documented CEREMONY_MODEL_* names. Provider SDK variables
 * (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL) are deliberately not consulted: an
 * operator's shell credential must not silently become the broker's paid route.
 */
export function modelConfigurationFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): ModelConfiguration {
  const provider = env.CEREMONY_MODEL_PROVIDER;
  if (provider && provider !== "anthropic" && provider !== "openai-compatible")
    throw new Error("Invalid model configuration");
  return {
    ...(env.CEREMONY_MODEL ? { model: env.CEREMONY_MODEL } : {}),
    ...(env.CEREMONY_MODEL_URL ? { endpoint: env.CEREMONY_MODEL_URL } : {}),
    ...(env.CEREMONY_MODEL_KEY ? { apiKey: env.CEREMONY_MODEL_KEY } : {}),
    ...(env.CEREMONY_MODEL_GATEWAY === "true" ? { gateway: true } : {}),
    ...(provider === "anthropic" ? { provider } : {}),
  };
}
/** Credentials, query strings and fragments never ride in a model URL; plain HTTP only to loopback. */
function checkedEndpoint(value: string, suffix: string): URL {
  const endpoint = new URL(value);
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
    !endpoint.pathname.endsWith(suffix)
  )
    throw new Error("Invalid model endpoint");
  return endpoint;
}
/** The provider SDK may reach only the one configured URL, and never follows a redirect. */
function pinnedFetch(endpoint: URL): typeof fetch {
  return (url, init) => {
    if (String(url) !== endpoint.href)
      throw new Error("Model endpoint mismatch");
    return fetch(url, { ...init, redirect: "error" });
  };
}
/** No implicit gateway, model name, or ambient paid routing. */
export function configuredModel(
  config: ModelConfiguration,
): LanguageModel | undefined {
  if (!config.model && !config.endpoint && !config.gateway && !config.provider)
    return undefined;
  if (
    !config.model ||
    config.model.length > 200 ||
    (config.gateway && (config.endpoint || config.provider))
  )
    throw new Error("Invalid model configuration");
  if (config.provider === "anthropic") {
    // Required here so the SDK can never fall back to ANTHROPIC_API_KEY.
    if (!config.apiKey) throw new Error("Model key is required");
    const endpoint = checkedEndpoint(
      config.endpoint ?? anthropicMessages,
      "/messages",
    );
    return createAnthropic({
      // Always explicit, so ANTHROPIC_BASE_URL is never consulted either.
      baseURL: endpoint.href.slice(0, -"/messages".length),
      apiKey: config.apiKey,
      fetch: pinnedFetch(endpoint),
    }).messages(config.model);
  }
  if (config.gateway)
    return createGateway(config.apiKey ? { apiKey: config.apiKey } : {})(
      config.model,
    );
  if (!config.endpoint) throw new Error("Model endpoint is required");
  const endpoint = checkedEndpoint(config.endpoint, "/chat/completions");
  const baseURL = endpoint.href.slice(0, -"/chat/completions".length);
  return createOpenAICompatible({
    name: "ceremony-configured",
    baseURL,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    fetch: pinnedFetch(endpoint),
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
