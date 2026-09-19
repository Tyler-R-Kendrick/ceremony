/*
 * Microsoft Power Platform custom connectors.
 *
 * `readCustomConnector` imports `apiDefinition.swagger.json` together with the
 * companion `apiProperties.json` and `settings.json`; `exportCustomConnector`
 * writes the supported profile back with explicit loss reporting; and
 * `createMicrosoftCustomConnectorAdapter` executes the two things a host may
 * approve — a dynamic field lookup and the connection test — and nothing else.
 *
 * The Swagger walk lives in `swagger-walk.ts` on purpose: it is the only file
 * that touches the document, so the shared OpenAPI reader can replace it
 * without any other file here changing.
 */
export * from "./issues.js";
export * from "./swagger-walk.js";
export * from "./api-properties.js";
export * from "./dynamic.js";
export * from "./read.js";
export * from "./export.js";
export * from "./adapter.js";
