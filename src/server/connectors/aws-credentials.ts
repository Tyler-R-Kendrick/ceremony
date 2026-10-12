/**
 * AWS credentials as a signer takes them. Defined here, not in either adapter,
 * because both the AgentCore adapter that signs with them and the IAM Identity
 * Center adapter that holds them in custody speak it, and neither should
 * depend on the other for a type.
 */
export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials only; signed as `x-amz-security-token`. */
  sessionToken?: string;
  /** Epoch milliseconds at which temporary credentials stop being valid, when the host knows it. */
  expiresAt?: number;
};
