# Effect-bound human participation

`Agent2Human` accepts a host-supplied `A2HCeremony` descriptor for account
registration, app registration, private credential collection and provider
authorization. These are purposes of an **AUTHORIZE** handoff, not new message
types. Credentials never belong in gateway replies.

Supply the current descriptor to both
`authorize(subjectId, runId, authenticatedHumanUrl, descriptor)` and
`receive(runId, signedResponse, descriptor)`. Derive it from authenticated run
state and current policy, never browser/model arguments or the response itself.
The exported strict `a2hCeremonySchema` validates the connector ID, public name,
purpose and effect envelope.

The effect binds tenant, subject, run, operation/version, target, configuration
version, scopes and argument digest. Changed semantics, human destination,
recipient or agent identity cannot reuse a pending request. The receiver
rechecks current recipient mapping and effect before consuming a response.
Identical retries preserve signed message identity after uncertain delivery.
Scope ordering and duplicates use the existing canonical effect semantics;
changing the scope set requires a fresh authorized attempt.

Only public connector labels, purpose and effect digest enter `params`. Do not
put private values in labels, URLs or argument digests: hashing a low-entropy
secret does not make it public. Contact addresses remain on the configured
gateway delivery path, not in model or demonstration data. The gateway and
trusted application server process that delivery data.

`receive` returns `verify` or `deny`, never authenticated access. Recheck host
authorization, cancellation and prerequisites, then run the registered provider
verifier before completing an Arazzo step. Approval does not transfer another
principal's authority, publish shared setup, implement cross-owner assignment,
or replace provider login/consent. Jira owner assignment remains unfinished.

## Compatibility and rollback

Three-argument `authorize` and two-argument `receive` retain the GitHub wire
format. Generic requests use encrypted `a2h-ceremony:` records; legacy requests
retain `a2h:`. Old binaries and receivers omitting the descriptor cannot consume
generic approval. No existing data is deleted or rewritten. Rollback leaves
generic requests unavailable until a compatible host returns; never downgrade
them into unbound legacy requests.

Both paths now reject changed recipients and waiting-request destinations.
Start a fresh explicitly authorized attempt after a material change. This
adapter still uses the existing synchronous local database; this addition is
not a mounted PostgreSQL-backed generic handoff service.

## Verification scope

`tests/a2h-ceremonies.test.ts` covers strict descriptors, signed safe intent
content, four purposes, effect permutations, recipient remapping, uncertain
delivery, decline, replay and legacy/generic isolation. Existing orchestration
and chaos tests retain GitHub compatibility. Pact uses the real HTTP consumer
for discovery rejection, exact generic signed intent delivery, gateway failure
and mismatched acknowledgement rejection. Successful signing/retry is tested
locally, not certified against a live gateway.

Protocol reference: [Twilio Labs Agent2Human 1.0 framework](https://github.com/twilio-labs/Agent2Human/blob/main/a2h_framework.md).
