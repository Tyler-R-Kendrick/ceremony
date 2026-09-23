# Attended certification

Everything else in this repository is local evidence: suites that drive the code against in-process fixtures or loopback doubles. A `certified` support label means something different. A named person attended a run of one flow against one real provider, confirmed every step that needed a human, and signed a dated record of it. This page covers how that record is made, what it holds, how the ledger validator checks it, and how the harness is rehearsed without touching any provider.

No provider has been certified yet. `certifiers.json` is empty, `certifications/` does not exist, and no label anywhere reads `certified`.

## What a certification record holds

A record is written by `scripts/certify-attended.ts` (`npm run certify:attended`) into `docs/implementation-evidence/connector-interoperability/certifications/<id>.json`, with the value-free transcript beside it as `<id>.transcript.json`. The schema is `attendedCertificationSchema` in `src/server/connectors/certification.ts`:

| Field                                      | What it is                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                       | `<day>-<provider>-<flow>-<nonce>`. The support entry it earns has the check `attended:<id>`.                                                           |
| `adapterId`, `definition`                  | The adapter whose label the record speaks for. A generic adapter (`evidenceScope: definition`) must name the definition it ran.                        |
| `provider.name`, `provider.origins`        | A display name and the exact origins the flow ran against. Origins only: no path, no query.                                                            |
| `flow`                                     | `registration`, `stitched-chain` or `catalog-connect`.                                                                                                 |
| `attendedBy`                               | The person who attended. The certifier list must give their key this exact name.                                                                       |
| `recordedAt`, `commit`                     | The UTC day of the run and the full commit that ran, from a clean checkout.                                                                            |
| `transcript.digest`, `steps`, `humanSteps` | SHA-256 over the value-free transcript, and its counts.                                                                                                |
| `rehearsal`                                | `true` for a run against local doubles. Such a record is never a certification.                                                                        |
| `signature`                                | Ed25519 by the attendant's key over everything above, in canonical JSON. `keyId` is the first 32 hex digits of SHA-256 over the public key's SPKI DER. |

The transcript lists each step's name, its kind (`attestation`, `driver`, `service` or `human`) and its outcome. A driver step also carries the driver's status, step and handoff counts, and a digest of the driver's own value-free transcript. Nothing typed, no answer, no code, no token and no URL query is kept, in the record or in the transcript.

## How the validator checks it

`scripts/connector-support-matrix.ts` loads every record under `certifications/` and the reviewed certifier list, `certifiers.json`. It derives an `attended-live` entry only when all of these hold:

- The record matches the schema exactly.
- `signature.keyId` belongs to a listed certifier, that certifier's public key hashes to the `keyId`, and the signature verifies.
- `attendedBy` is the name the list gives that key.
- `recordedAt` is not after the evaluation day.
- Every provider origin is public HTTPS. An IP literal, `localhost`, a single-label host, a host written with a trailing dot, and a name under `.test`, `.example`, `.invalid`, `.localhost`, `.local` or `.internal` is a stand-in, not a provider.
- The adapter exists, and a generic adapter's record names its definition.
- The transcript file exists and hashes to the signed digest.
- `rehearsal` is `false`.

A record that fails any check is refused by name, and generation fails, so `npm run docs:connectors:check` cannot pass with a forged, stale or rehearsed record in the tree. An `attended-live` or `recorded-live` entry typed straight into a ledger's `supportEvidence` is refused too, and so is any ledger entry whose check is a named `scheme:identifier` rather than a repository file: an attendee's name or a live run in a ledger is a claim anybody can type, so the only way live evidence enters the generated labels is a signed record. A deployment adds its own live runs through `support.evidence`.

A verified record earns `certified` for 180 days, and only where the configuration it was measured with is present (see [support labels](specifications/connector-support-matrix.md#support-labels)). For a generic adapter it certifies the named definition, never the adapter's code path.

## Becoming a certifier

1. Generate a key. Keep the private half on your own machine; it never enters the repository.

   ```sh
   npm run certify:attended -- --keygen ~/.ceremony/certifier.pem --attended-by "Your Name"
   ```

   This writes the private key with mode 0600 and prints a `{ keyId, name, publicKey }` entry.

2. Add that entry to `certifiers.json` in a reviewed change. Adding a certifier is a decision about who may vouch for a provider, so it goes through review like any other trust change.

## Running a certification

A certification needs a target module for the provider. It exports one function:

```ts
export async function certificationPlan(
  flow: "registration" | "stitched-chain" | "catalog-connect",
): Promise<{ plan: CertificationFlowPlan; close(): Promise<void> }>;
```

`CertificationFlowPlan` (`src/server/connectors/attended-harness.ts`) names the adapter and definition, the provider's name and origins, `rehearsal: false`, and the steps:

- A `driver` step runs `runCeremony` from `src/server/browser-driver.ts` in a browser the target opens. It must be headed so the attendant can act in it. The target builds the plan (entry URL, allowed origins, roles, `verify`) exactly as a production login plan is built. The harness supplies the human participation: when the driver hands a step to a person, the attendant does it in the browser and then confirms it on the terminal.
- A `service` step does server-side work between browser steps, such as configuring the second provider in a stitched chain or redeeming a callback through the connector service.
- A `human` step is a checkpoint with no page: something only the attendant can see, such as the account appearing in the provider's dashboard.

Then run it from a clean checkout of the commit you are certifying:

```sh
CEREMONY_LIVE_AUTHORIZED=true CEREMONY_LIVE_ATTENDED=true \
  npm run certify:attended -- --flow catalog-connect --target path/to/northwind-target.ts \
  --attended-by "Your Name" --key ~/.ceremony/certifier.pem
```

The script refuses to start unless the checkout is clean, both variables are set, stdin is a terminal and a key is given. It also refuses before the first step if the plan names a stand-in origin while claiming not to be a rehearsal. The run then:

1. asks you to attest that you are attending this flow against this provider;
2. runs each step, asking you to confirm every driver handoff, every completed driver step and every human checkpoint;
3. asks you to attest that the outcome matches what you saw;
4. signs and writes the record and its transcript.

Only `y` or `yes` confirms. Any other answer, any failed step and any driver outcome other than `completed` ends the run with nothing written. Provider sign-in, MFA, CAPTCHA and consent stay yours. The harness never automates them, and nothing you type into the provider's pages passes through the terminal.

Commit the two files. `npm run docs:connectors` verifies the record and regenerates the matrix and the runtime's recorded evidence with the new entry.

## Rehearsal

`--target rehearsal` runs the same three flows against the local auth double (`tests/doubles/auth-provider`) in headless Chromium. It uses the production heuristic interpreter and synthetic credentials, and every origin is loopback. `tests/certification/rehearsal.ts` builds the plans:

- **registration**: the `registration-region-chosen-by-a-person` scenario. The driver hands the region choice to a person, the double's scripted participant makes it, and the attendant confirms it.
- **stitched-chain**: the two-provider chain. An OAuth app is registered at A, B is configured with it, and the person signs in to B through A.
- **catalog-connect**: a provider-catalog entry for the auth double is imported and bound through review in the real connector command service. The driver signs in and approves consent, the service redeems the callback, and an authenticated proxy call returns `200`.

Without `--key`, a rehearsal signs with a throwaway key that no certifier holds. The output goes to `artifacts/certification-rehearsal/` by default, and the script refuses to write a rehearsal into `certifications/`.

`tests/attended-certification.e2e.test.ts` runs all three flows through the harness, then runs the script itself for one. Each rehearsal is signed with a key that a temporary certifier list holds, so the signature verifies. The test then asserts that the validator refuses every record as a rehearsal against stand-ins. `tests/connectors/contracts/certification.test.ts` covers each refusal without a browser, including the case of a rehearsal record with a public origin and a valid signature. The rehearsal is evidence that the harness works. It is not evidence about any provider.
