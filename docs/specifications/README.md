# Ceremony specifications

Status: **Ceremony implementation profile, version 1**. These are normative contracts for this package, not a new industry authentication protocol or a claim of provider certification. MUST, MUST NOT and SHOULD express requirements of this profile. Runtime schemas and the conformance suite are executable counterparts; prose does not authorize an effect.

## Contract stack

| Contract                                    | Configures                                                                     | Authority remains with                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [Connector manifest](connector-manifest.md) | Methods, profiles, setup requirements, participation, verified outcomes        | Trusted host registration and current session                            |
| [Decision and execution](flow-execution.md) | Selection, prerequisites, recipe composition, commands, waits and continuation | Protected command service and registered verifiers                       |
| [Arazzo and A2H](protocol-profiles.md)      | SDK operation sequences and required human participation                       | Host-bound operations, authenticated recipient and provider verification |
| [Conformance](conformance.md)               | Validation levels, tests, compatibility and evidence                           | Actual test results and release policy                                   |

Use the [Draft 2020-12 JSON Schemas](schemas/) for editor completion and model structured output. They are generated from Zod, not a competing handwritten language. JSON Schema checks structure; the runtime additionally checks cross-field semantics, graph limits, pinned registry bindings, policy and evidence. Passing either schema alone MUST NOT publish a recipe, register an adapter, accept a grant or certify a provider.

The complete schema set is connector manifest, method contract, human handoff, recipe, operation, command, demonstration event, method selection and the bounded Arazzo profile. Their URN identifiers identify documents; they are not network fetch instructions.

Developer commands:

```sh
npm run specs:check
npm run test:specs
npm run specs:generate # only after an intentional contract change; review the diff
```

`npm test` and `npm run verify` discover the conformance tests, including schema drift. Consumers import the core schemas/types from `@ceremony/auth`; Arazzo remains in `@ceremony/auth/server`. No schema requires a model, React, Workflow, a database or a browser to parse.

## Sources and scope

- [Arazzo 1.0.1](https://spec.openapis.org/arazzo/v1.0.1.html): the pinned supported sequence format. This implementation does not claim the complete language or automatically adopt newer Arazzo versions.
- [Twilio Labs Agent2Human](https://github.com/twilio-labs/Agent2Human): the existing 1.0 AUTHORIZE transport, distinct from similarly named A2H proposals.
- [Zod JSON Schema conversion](https://zod.dev/json-schema): generation from the installed Zod runtime contracts.

These profiles formalize the current [architecture](../architecture.md), [teaching](../ceremony-teaching.md) and [deployment](../production-deployment.md) boundaries. They do not replace upstream protocol specifications or broaden live support.
