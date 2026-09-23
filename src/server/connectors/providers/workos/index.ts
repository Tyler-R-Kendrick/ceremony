export {
  createWorkOsPipesAdapter,
  type WorkOsPipesAdapterOptions,
} from "./adapter.js";
export type { WorkOsPrincipal, WorkOsPrincipalPort } from "./ports.js";
export {
  WORKOS_ADAPTER_ID,
  WORKOS_ADAPTER_VERSION,
  WORKOS_API_ORIGIN,
  WORKOS_CREDENTIALS_ACTION,
  WORKOS_DEFAULT_RETURN_PATH,
  WORKOS_DESTINATION_ID,
  WORKOS_RETURN_CORRELATION_PARAMETER,
  workOsPipesProfiles,
  workOsSettingsSchema,
  type WorkOsSettings,
} from "./wire.js";
