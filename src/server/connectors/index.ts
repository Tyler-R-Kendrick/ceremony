export * from "./errors.js";
export * from "./binding.js";
export * from "./ports.js";
export * from "./adapter.js";
export * from "./inventory.js";
// The inventory, so a host can build a registry and then compose a runtime
// over it. Absent here, `createConnectorRuntime` was reachable but the
// registry it needs was not, which the packed-consumer test caught.
export * from "./adapters.js";
export * from "./runtime.js";

// The seams a host builds on rather than only configures, each under its own
// namespace so their many names cannot collide with the ones above:
// - `oauth`: discovery, client registration and the grants (authorization
//   code, device, client credentials, token exchange, refresh), plus the
//   binding-driven resolver adapters use; an adapter author calls these.
// - `events`: the webhook receiver, verification and inbox for provider
//   deliveries a host mounts itself.
// - `formats`: the description readers, compilers and exporters.
export * as oauth from "./auth/index.js";
export * as events from "./events/index.js";
export * as formats from "./formats/index.js";
export {
  createWebhookReceiver,
  type WebhookReceiverOptions,
} from "./events/receiver.js";
