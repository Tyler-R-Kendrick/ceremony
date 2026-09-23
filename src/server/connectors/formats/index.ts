/*
 * Every description format this package reads, one namespace each, so a host
 * can import a reader, compiler or exporter without reaching into module
 * paths. Namespaced rather than flattened: several formats name their reader
 * the same way, and a flattened surface would make one of them win silently.
 * Reading a description approves nothing; binding does.
 */

export * as arazzo from "./arazzo/index.js";
export * as automation from "./automation/index.js";
export * as camelKamelet from "./camel-kamelet/index.js";
export * as microsoft from "./microsoft/index.js";
export * as n8n from "./n8n/index.js";
export * as openapi from "./openapi/index.js";
export * as overlay from "./overlay/index.js";
export * as retrieval from "./retrieval/index.js";
export * as workato from "./workato/index.js";
export * as zapier from "./zapier/index.js";
