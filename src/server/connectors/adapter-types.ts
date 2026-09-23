import type { z } from "zod";
import type {
  capabilityStatusSchema,
  compatibilityIssueSchema,
  configurationRequirementSchema,
  connectorSourceIdentitySchema,
  credentialCustodySchema,
  ecosystemSchema,
  evidenceTargetSchema,
  normalizedDefinitionSchema,
  ownerKindSchema,
  runtimeClassSchema,
  sourceRecordSchema,
  supportLevelSchema,
  verificationClaimSchema,
} from "../../core/connectors/index.js";

/** Type aliases re-exported for adapter authors, so provider modules import one path. */
export type CapabilityStatus = z.infer<typeof capabilityStatusSchema>;
export type CompatibilityIssue = z.infer<typeof compatibilityIssueSchema>;
export type ConfigurationRequirement = z.infer<
  typeof configurationRequirementSchema
>;
export type ConnectorSourceIdentity = z.infer<
  typeof connectorSourceIdentitySchema
>;
export type CredentialCustody = z.infer<typeof credentialCustodySchema>;
export type Ecosystem = z.infer<typeof ecosystemSchema>;
export type EvidenceTargetInput = z.infer<typeof evidenceTargetSchema>;
export type NormalizedDefinition = z.infer<typeof normalizedDefinitionSchema>;
export type OwnerKind = z.infer<typeof ownerKindSchema>;
export type RuntimeClass = z.infer<typeof runtimeClassSchema>;
export type SourceRecord = z.infer<typeof sourceRecordSchema>;
export type SupportLevel = z.infer<typeof supportLevelSchema>;
export type VerificationClaim = z.infer<typeof verificationClaimSchema>;
