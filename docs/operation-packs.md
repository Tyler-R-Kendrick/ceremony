# Operation packs

**A third party can add a new recipe step without forking or rebuilding the
server.** An operation pack is a signed manifest plus one handler bundle. The
host loads packs from a directory it configures, at startup, and only when
the signature verifies under a publisher key the host trusts. Each operation
in the pack registers as `pack:<pack>/<name>` and is then an ordinary
operation: recipes name it, `ceremony_recipe_preview` validates it, and the
command service admits, authorizes, runs and records it exactly as it does a
built-in step. The handler itself runs in a sandbox that has no ambient
authority. It can reach only the origins its manifest declares, and it never
holds a credential value.

The format lives in [`src/core/operation-packs.ts`](../src/core/operation-packs.ts)
and is published as the [`operation-pack-v1`](specifications/schemas/operation-pack-v1.schema.json)
JSON Schema. Loading, signature checks and the sandbox live in
[`src/server/operation-packs.ts`](../src/server/operation-packs.ts) and
[`src/server/operation-pack-sandbox.ts`](../src/server/operation-pack-sandbox.ts).
The evidence is local: [`tests/operation-packs.test.ts`](../tests/operation-packs.test.ts)
signs a fixture pack with a key it generates, then loads it and runs it in a
recipe against a loopback provider double.

## Layout

```
<packs directory>/
  fixture/            one directory per pack; the name is only for reports
    pack.json         the signed envelope
    handler.js        the handler bundle the manifest's digest names
```

Symlinks, other file types, oversized files (64 KiB for `pack.json`, 1 MiB
for `handler.js`) and entries starting with `.` are not packs. The host never
fetches a pack or any part of one at run time.

## The manifest

`pack.json` holds `{ "manifest": …, "signature": … }`:

```json
{
  "manifest": {
    "schemaVersion": 1,
    "id": "fixture-pack",
    "version": "1.2.0",
    "title": "Fixture pack",
    "description": "Reads an account's plan.",
    "publisher": "fixture-publisher",
    "bundle": { "sha256": "<hex of handler.js>", "bytes": 4312 },
    "operations": [
      {
        "name": "lookup",
        "version": "1.0.0",
        "title": "Read the plan",
        "description": "Reads the account's current plan.",
        "scope": {
          "kind": "provider",
          "provider": "fixture",
          "profile": "fixture-api"
        },
        "inputs": {
          "account": { "contract": "fixture.account", "required": true }
        },
        "outputs": { "plan": { "contract": "fixture.plan", "required": true } },
        "effect": "read",
        "destinations": ["https://api.fixture.example"],
        "credentials": {
          "apiKey": {
            "source": "host",
            "name": "fixture-api-key",
            "placement": { "kind": "bearer" }
          }
        },
        "verify": true,
        "replay": "read-only",
        "fixtures": ["https://publisher.example/evidence/lookup"],
        "limits": { "timeoutMs": 5000, "memoryMb": 32, "outputBytes": 4096 }
      }
    ]
  },
  "signature": {
    "algorithm": "ed25519",
    "keyId": "fixture-publisher",
    "value": "<base64 Ed25519 signature>"
  }
}
```

Each operation declares:

| Field          | Meaning                                                                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope`        | `neutral`: the step joins any provider's run, like the `common.*` steps, and may use only neutral vocabulary. `provider`: the step is admitted only into a run, or recipe invocation, under that provider and profile.        |
| `inputs`       | Slots over contracts the **host** vocabulary already has; the recipe-contract vocabulary (`{ contract, required }`), never a schema the pack defines. A pack cannot add vocabulary, and cannot mark anything `crossProvider`. |
| `outputs`      | The same, public contracts only.                                                                                                                                                                                              |
| `effect`       | `read` operations may only send `GET` and `HEAD`. `write` operations may send any method, and a failure after a write was sent is `uncertain`, never a clean failure.                                                         |
| `destinations` | Exact origins: HTTPS, or HTTP loopback when the host opts into fixtures. The handler can contact nothing else.                                                                                                                |
| `credentials`  | Values the host injects into a request, by name. See [Credentials](#credentials).                                                                                                                                             |
| `verify`       | Whether the bundle exports a `verify` for this operation. A step without one is refused by recipe validation (`missing-verifier`), as a built-in would be.                                                                    |
| `replay`       | `read-only`, allowed only on a read, is the evidence a recipe needs before it may declare a retry.                                                                                                                            |
| `fixtures`     | Where the publisher's evidence for the operation lives. Required and informational: it is the publisher's claim, not the host's certification.                                                                                |
| `limits`       | Optional tighter or looser limits within the host's caps (timeout at most 30 s, memory at most 128 MB, output at most 64 KiB). The defaults are 10 s, 32 MB and 16 KiB.                                                       |

Vocabulary rules checked at load, beyond the schema:

- Every contract must exist in the host's vocabulary.
- A neutral operation may use only neutral (`common`) vocabulary.
- A provider-scoped operation may use its own provider's vocabulary, neutral vocabulary the host declared `crossProvider`, and vocabulary the host registered without a provider.
- Inputs must be `public`, except the input a declared `oauth-client` credential names, which must be `common.oauth-client`. Outputs must be `public`. A pack cannot read or mint a provider artifact handle, a secret or a personal value.

## Signing

The signature is Ed25519 (`node:crypto`) over these bytes:

```
"ceremony-operation-pack-v1\n" + JSON(manifest, object keys sorted at every depth)
```

`operationPackSigningPayload(manifest)` in the core entry produces them. It
parses the manifest first, so an unknown field cannot ride along unsigned. The
manifest carries `bundle.sha256` and `bundle.bytes`, so one signature binds
both the manifest and `handler.js`. A publisher signs with:

```ts
import { sign } from "node:crypto";
import { operationPackSigningPayload } from "@ceremony/auth";
const value = sign(
  null,
  operationPackSigningPayload(manifest),
  privateKey,
).toString("base64");
```

## Trust configuration

Loading has two steps. `prepareOperationPacks(options)` is asynchronous and
runs before the runtime exists. It reads and verifies every pack and
evaluates each bundle once in the sandbox, to check that it defines every
operation the manifest declares. `registerOperationPacks(registry, packs)` is
synchronous. It runs inside the runtime, checks each operation against the
registry's vocabulary and registers it. Registration accepts only a set that
`prepareOperationPacks` produced, so an unchecked pack never reaches a
registry.

```ts
const packs = await prepareOperationPacks({
  directory: "/etc/ceremony/packs",
  publishers: [
    {
      keyId: "fixture-publisher",
      publicKey: "-----BEGIN PUBLIC KEY-----\n…", // Ed25519 SPKI PEM
      notBefore: "2026-01-01T00:00:00Z",
      notAfter: "2027-01-01T00:00:00Z",
      packs: ["fixture-pack"], // optional: the pack ids this key may sign
    },
    {
      keyId: "community-publisher",
      publicKey: "-----BEGIN PUBLIC KEY-----\n…",
      untrusted: true, // its packs always run in a child process
    },
  ],
  revokedKeys: ["old-publisher"],
  isRevoked: revocationList("/etc/ceremony/revoked-publishers", {
    refreshMs: 30_000,
  }),
  secrets: async ({ pack, operationId, name, actor }) =>
    vault.read(pack, name, actor.tenantId),
  allowDestination: (pack, origin) => reviewed.has(`${pack} ${origin}`),
  concurrency: { maxConcurrent: 4, queueTimeoutMs: 5_000, maxQueued: 256 },
  isolation: "worker", // or "process" for every publisher
});
createGitHubRuntime({
  // …
  operationPacks: {
    packs,
    // onRefused: (refusals) => log(refusals), // otherwise a refusal stops startup
  },
});
```

A host that builds its own `OperationRegistry` can await
`loadOperationPacks(registry, options)`, which does both steps. The report is
`{ loaded, refused }`. Every refusal carries one fixed reason and message and
never quotes the pack's text:

| Reason                                                                | Cause                                                                                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-layout`                                                      | Not a directory, a symlink, or `pack.json` is missing or too large.                                                                                                       |
| `invalid-manifest`                                                    | The envelope does not parse, or the signature names a different key than the manifest.                                                                                    |
| `unknown-publisher`                                                   | The manifest's key id is not configured.                                                                                                                                  |
| `publisher-revoked`, `publisher-expired`, `publisher-not-yet-valid`   | The key is in `revokedKeys` or outside `notBefore`/`notAfter`.                                                                                                            |
| `bad-signature`                                                       | The signature does not verify, for example because the manifest was edited after signing or someone else signed under a trusted key id.                                   |
| `publisher-not-allowed`                                               | The key is limited to other pack ids.                                                                                                                                     |
| `bundle-digest-mismatch`                                              | `handler.js` is missing or differs from the signed size and digest.                                                                                                       |
| `unknown-vocabulary`, `provider-mismatch`, `forbidden-classification` | The vocabulary rules above.                                                                                                                                               |
| `destination-refused`                                                 | Loopback without `loopbackFixtures`, or `allowDestination` said no.                                                                                                       |
| `credential-unavailable`                                              | A credential the host has no resolver for, or an `oauth-client` credential over the wrong contract.                                                                       |
| `duplicate-operation`                                                 | The pack id is already loaded, or an operation id and version already exists.                                                                                             |
| `missing-export`                                                      | `handler.js` throws or runs past the time limit when evaluated, or does not define `run` for every declared operation, or `verify` for every operation that declares one. |

A pack loads all or nothing. A trusted key that is not Ed25519, or an invalid
date, is host misconfiguration and throws.

### Revocation

The key's validity window, `revokedKeys` and the host's live revocation
source are checked at load and again before every invocation. A key that
expires or is revoked while the server runs stops its operations at their
next call (`failed` / `denied`), with no restart:

- `isRevoked(keyId)` may be synchronous or asynchronous. A throw or rejection counts as revoked.
- `revocationList(path, { refreshMs })` builds a live source from a file of key ids, one per line, with blank lines and `#` comments ignored. The file is re-read at most every `refreshMs` (default 30 s), so a revocation takes effect within that interval. The source fails closed: while the file is missing, unreadable, or holds anything other than key ids, every key counts as revoked.
- `revokedKeys` is a static list fixed at startup.

An invocation that is already running when its key is revoked finishes; the
check happens before each call, not during one.

### Concurrency

One cap bounds how many sandboxes run at once across every pack a prepared
set holds: invocations, verifications and the export check at load all take
a slot. The defaults are the machine's available parallelism (at most 8)
running at once, 256 waiting and a 5 s wait. An invocation that finds the
queue full, or waits past `queueTimeoutMs`, is `failed` / `unavailable`
without starting a worker. One cancelled while waiting is `cancelled`.
`concurrency` takes either these settings or an `OperationPackLimiter`
instance, so several runtimes in one process can share a single cap.

## What a handler sees

`handler.js` is a plain script. It defines a top-level `operations` object
whose entries have `run(input, ceremony)` and, when the manifest says so,
`verify(outputs, ceremony)`. Preparation checks this by evaluating the bundle
in the sandbox and listing which of these functions each entry defines. No
entry runs during that check, and the bundle's top level gets no `ceremony`:

```js
const operations = {
  lookup: {
    async run(input, ceremony) {
      const response = await ceremony.fetch({
        url: "https://api.fixture.example/accounts/" + input.account,
        credential: "apiKey",
      });
      return { outputs: { plan: JSON.parse(response.body).plan } };
    },
    async verify(outputs, ceremony) {
      const response = await ceremony.fetch({
        url: "https://api.fixture.example/plan",
        credential: "apiKey",
      });
      return response.status === 200 && outputs.plan === "pro";
    },
  },
};
```

- **`input`** holds the operation's public inputs only. A credential handle input never reaches the handler.
- **`run`** returns `{ outputs }`, checked against the output contracts, or `{ failed: "denied" | "conflict" | "unavailable" | "invalid-input" | "expired" }`. `verify` returns `true` to verify. Anything else is `false`.
- **`ceremony.fetch({ url, method?, headers?, body?, credential? })`** resolves to `{ status, headers: { "content-type"? }, body }`, or rejects with one of the fixed codes `denied`, `invalid-request`, `unavailable`, `too-large` or `limit`.

The fetch capability runs in the host, not the sandbox:

- The URL's origin must be one of the operation's `destinations`, with no userinfo. Any other origin is a violation.
- A read, and every `verify`, may send only `GET` and `HEAD`. Any other method is a violation.
- `Authorization`, `Cookie`, `Host` and framing headers cannot be set by the handler. A `GET` or `HEAD` cannot carry a body. Request bodies are capped at 64 KiB, responses at 256 KiB, and an invocation may make 16 requests.
- Requests go through the host's egress transport, by default the server's public-address-only, no-redirect fetch (`publicAuthFetch`), so the handler gets the same DNS-pinned rules as built-in handlers.
- The host remembers the facts of the last exchange (status, method, origin and path, no query or headers) for the recipe's success criteria, as a trusted built-in handler reports them.

A violation fails the step with `denied`, whatever the handler returns. If a
write was already sent, the step is `uncertain` instead.

### Credentials

A handler names a credential; the host resolves it and sets the header on the
outgoing request. The value never enters the sandbox:

- **`host`** credentials come from the host's `secrets` resolver, which receives the actor, run, pack, operation and name. They are placed as `Authorization: Bearer …` or in a named header. `Authorization`, `Cookie`, `Host` and framing headers cannot be named.
- **`oauth-client`** credentials resolve a `common.oauth-client` handle input, minted earlier in the same run by another step, to its client ID and secret, and send them as HTTP Basic client authentication (RFC 6749 §2.3.1). The handle is bound to the run and subject like every common handle.

**What the handler can still see:** the response. Before the handler reads a
response body or content type, the host replaces every injected value it
sent with `[redacted]`: the raw value, its URL and form encodings, and the
Basic token. A provider that echoes a credential in some other transformed
form (hashed, re-encoded, split) is not caught. The destination that received
the credential is one the signed manifest declared and the host admitted, so
this exposes a value only to a handler talking to a provider that already
holds it. A handler cannot use a credential at any other origin. A `verify`
invocation has no inputs, so it can use `host` credentials but not an
`oauth-client` one.

## The sandbox

Each invocation starts a fresh `node:worker_threads` worker with:

- `resourceLimits` set to the operation's memory limit;
- an empty environment, and no `argv` or inherited `execArgv`;
- its standard output and error discarded.

The bundle runs inside a `node:vm` context created from a null-prototype
object, with string and WebAssembly code generation disabled. The host
terminates the worker at the deadline, whatever it is doing: busy loops, a
promise that never settles, runaway allocation.

`node:vm` is **not** a security boundary by itself. Code in a context that
reaches any object from the realm that created it can climb to that realm's
`Function` and run with its authority. The containment is:

1. **Only primitives cross.** Input goes in as JSON text parsed inside the context. Requests and results come out as JSON text. The one worker function the context holds is captured in a closure the bundle cannot name. It type-checks its arguments before touching them and never returns or throws a worker object. No worker-realm object is reachable from the bundle. The tests try `constructor.constructor`, the `AsyncFunction` constructor, `eval`, `import()`, `WebAssembly.Module` and stack-frame inspection, and all of them are refused.
2. **The worker has no loader.** Before the bundle runs, the bootstrap deletes the worker realm's `require`, `module` and `fetch` globals and replaces `process`, so even an escape into the worker realm finds no module loader there.
3. **The capability surface is one function.** There are no timers, no `fetch`, no `console` and no filesystem. The only authority is `ceremony.fetch`, which the host serves under the rules above.

The limits are real, and in `worker` isolation they are not a process
boundary. A worker thread shares the host's process, so a V8 or Node
vulnerability that breaks out of the context and the worker realm reaches the
host. Timing side channels are not addressed.

### Process isolation

In `process` isolation each invocation, and the export check at load, runs
in a fresh Node child process instead of a worker. It uses the same
bootstrap, context, timeout, kill, output cap and concurrency slot. The child
is spawned from `process.execPath` with no shell, an empty environment, its
standard input, output and error closed, and one JSON IPC channel as its only
link to the host. The host sends the verified bundle over that channel and
kills the child with `SIGKILL` at the deadline. The child's flags
(`processIsolationArguments`) are:

- `--permission`, with no `--allow-*` flag. The child cannot read or write any file, start a child process or worker thread, load a native addon or use WASI. File reads are not granted even for the bundle: the child gets the bytes the host already checked against the signed digest, so it never reopens a file that could have changed since.
- `--disallow-code-generation-from-strings`, so `eval` and `Function` fail in the child's own realm as well as in the context.
- `--max-old-space-size` set to the operation's memory limit. A child over it crashes and the step is `unavailable`.

A publisher marked `untrusted: true` always runs in `process` isolation. A
host can put every publisher there with `isolation: "process"`. The registry
and catalogs report each operation's `isolation`.

What Node 22's permission model does **not** restrict, as checked by
`tests/operation-packs.test.ts` against the running Node:

- **The network.** Node 22 has no network permission (`--allow-net` does not exist in this version), so sockets are not restricted by it. The test shows a permission-restricted child still connects to a loopback server. The handler's only network path is still `ceremony.fetch`: the context has no `require`, `process` or `fetch`, and the child realm has had those globals removed. An escape past both could open sockets directly.
- **Already-open resources and the environment.** The child inherits no open descriptors besides the IPC channel and gets an empty environment. That comes from how the host spawns it, not from the permission model.
- **CPU, time and memory.** These are limited by the host's deadline, `SIGKILL` and `--max-old-space-size`, not by permissions.
- **Signals, or syscalls outside Node's own APIs.** The permission model checks Node's `fs`, `child_process`, `worker_threads`, addon and WASI entry points. It is not a seccomp filter, and Node documents it as not protecting against malicious code that finds another way in.

A child process is an OS process boundary: the handler no longer shares the
host's heap, and it holds no file or process authority. It still runs as the
same OS user with the network reachable at the socket level. A host running
packs from publishers it does not control should add OS-level isolation (a
container, seccomp or a separate user) for full containment.

## Failures

Everything the handler does wrong maps to the existing operation codes. None
carries the handler's message, stack or output:

| What happened                                                                          | Step result                                          |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Throws, times out, runs out of memory, crashes, or returns oversized or invalid output | `failed` / `unavailable`                             |
| Breaks a destination or method rule                                                    | `failed` / `denied`                                  |
| No sandbox slot within the queue bound or wait                                         | `failed` / `unavailable`                             |
| The run's signal aborts                                                                | `failed` / `cancelled`                               |
| Any of the above after a write was sent                                                | `uncertain` (reconciliation, never a silent retry)   |
| Returns `{ failed: code }`                                                             | `failed` / that code                                 |
| The publisher key has expired, or the host revoked it (live)                           | `failed` / `denied`                                  |
| `verify` is absent or does not return `true`                                           | `failed` / `verification-rejected` (command service) |

## What a pack can and cannot do

A pack **can** add read or write steps that call HTTP APIs at origins it
declares. It can use host credentials without seeing them, take and produce
public values in the host's vocabulary, join any run (neutral) or one
provider's runs (scoped), and be composed, previewed, executed and retried
like a built-in step.

A pack **cannot**:

- add vocabulary, or read or mint artifact handles, secrets or personal values;
- replace or shadow a host operation or another pack's (`pack:` ids come only from `registerPack`, under the pack's own id);
- run outside the run and connector context it was admitted into. `admits()`, per-connector reauthorization, cross-provider binding checks and replay rules are unchanged;
- review or publish a recipe. That stays a person's action, and a recipe that uses a pack step is published like any other;
- ask a person for input (no human handoff), or keep state between invocations;
- reach the network except through `ceremony.fetch`, or reach the filesystem, environment, timers or other modules at all. In `process` isolation, the file, process and worker restrictions are also enforced by Node's permission model.

## Where packs show up

- `ceremony_operations` (MCP) and `GET /api/v1/teaching/recipes/operations` (HTTP) list every registered operation with its contract. A pack-provided operation has `source: { kind: "pack", pack, packVersion, publisher, effect, destinations, isolation }`; a built-in has `source: { kind: "host" }`.
- `OperationRegistry.describe()` and `provenance(id, version)` give the same data to host code.
- Arazzo operation-binding catalogs may bind a reference to a pack operation id.
