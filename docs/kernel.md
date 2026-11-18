# The ceremony kernel

`src/kernel` is a restart of Ceremony's core from first principles. It does not
replace the existing server yet; it is the foundation the existing flows move
onto. This page says what it is, why it has this shape, what is checked and
what is not.

## The problem with a script

The existing GitHub path was built as a script: prepare the app, hand off,
convert, install, verify. Every way a step could go wrong was then added where
it was first met. The survey behind this work found the result: every GitHub
API error funnels through one `catch` into `uncertain`; rate limits, a pending
organization approval, a name conflict and an existing installation have no
handling of their own; a finished installation is never looked for, so an
expired artifact sends the person back to GitHub.

A script has a position, and a failure is a detour from it. Each detour needs
its own way back. That is the whack-a-mole.

## The shape

A ceremony is declared, not scripted:

- **Facts** are what has to be true: an account is chosen, Ceremony holds an
  app, the app is installed, a token is held. A fact says what it rests on,
  whether the world can take it away, whether a probe can see it, whether a
  probe can find it from nothing, and whether its value is secret.
- **Operators** establish facts. An operator names what it requires, what it
  establishes, what single-use input it spends, who runs it, and **every way it
  can end**. An ending is one of six kinds: established, retry, unsure (the
  effect may have happened), blocked (plan around it), invalidates (a belief
  was stale), terminal (a named stop). There is no seventh. An adapter cannot
  return an ending its operator does not declare: that is a type error, and at
  run time it is treated as a lost reply.
- The **controller** is two pure functions. `decide` maps what the controller
  knows to the next thing to do; `absorb` folds what happened back in. There is
  no step counter. Its state is its knowledge, so resuming after a crash, being
  run a second time, and taking the next step are the same act.

Everything else follows from that shape.

**Skipping and minimal paths.** `decide` plans the cheapest operator sequence
from what it knows to the goal, assuming unknown facts hold. If the plan leans
on an unknown fact, that fact is probed first; if it leans on none, the plan is
already the cheapest for the real world and its first step runs. So nothing is
established that already holds and nothing is probed that could not change the
plan. With a valid token the GitHub flow does one probe and stops. With the app
held and not installed it asks for one thing.

**Fallbacks.** Several operators can establish the same fact. When one reports
`blocked` or spends its attempts, the next plan simply does not contain it. A
fallback is not written; it is what replanning does. Device sign-in appears in
the GitHub user flow only when the consent page cannot be opened.

**Minimal components.** A human operator carries the interface it needs. The
interfaces on some fault-free path are necessary; the ones only a fallback
reaches are contingent; the rest are dead declarations. `derive` computes this
from the flow. Nobody lists components.

**Durability.** Work is journaled before it starts and when it ends. Values
are staged before the journal entry that commits them and promoted after. The
vault is the controller's durable memory: a run starts believing the facts it
has custody of that no probe can check, and the operators that use them are
the ones that report them stale.

## What was compared

| Approach                                 | What it gives                                         | Why it is not the kernel                                                                                 |
| ---------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Free monad or generator effects (Effect) | Typed errors, composition, a good runtime             | Continuations are opaque functions: the flow cannot be enumerated, so it can only be tested, not checked |
| Explicit state machines (statecharts)    | Enumerable, drawable                                  | Transitions are hand-written, so the ones nobody thought of are missing: the same whack-a-mole, tidier   |
| Durable execution (Workflow, Temporal)   | Replay, timers, retries                               | Durability of a script. It resumes the position; it does not ask whether the position still makes sense  |
| Session types, choreographies            | Protocol fidelity between parties, no deadlock        | Describes the conversation, not what to do when the world changed between two messages                   |
| Workflow nets and soundness              | A precise meaning of "always able to finish"          | The right property, taken; the net itself would be a second artefact to keep in step                     |
| TLA+ for the whole design                | Mature checker, good counterexamples                  | A model beside the code drifts. Used here for the existing code, where the model is the only option      |
| Planning with nondeterministic outcomes  | Fallback as policy, "reach the goal whatever happens" | Taken: this is the controller. The declarations are the planning domain                                  |
| Build systems (Make, Shake)              | Do only what is out of date                           | Taken: a probe is an up-to-date check, a fact is a target                                                |

The kernel is the combination the table points to: a planning domain with
typed, total outcomes; a controller that is a pure policy over knowledge; an
explicit-state checker that runs that same controller; a journal for
durability. The one move that matters is that **the checker and the
interpreter call the same `decide` and `absorb`**. Only the world is modelled,
and its contract is the declarations.

## What is checked, and how far

`check` plays every environment the declarations allow against the controller,
from every starting world, and checks on every state:

| Property              | In one sentence                                                                |
| --------------------- | ------------------------------------------------------------------------------ |
| `terminates`          | Every controller step lowers a ranking measure, so every run ends              |
| `belief-sound`        | What the controller believes is true, or was until the world changed it unseen |
| `precondition`        | An operator runs only when everything it requires is held                      |
| `success-sound`       | Success is declared only with every goal fact held                             |
| `no-duplicate-effect` | A non-idempotent effect never lands on top of itself                           |
| `residue-accounted`   | Anything a lost reply may have left behind is reported by the run              |
| `recoverable`         | While probes alone could still find a way, a cooperating world reaches success |

Scope, stated plainly:

- **The world is a model.** Outcome reports are assumed truthful: an operator
  says a fact is gone only when it is. A probe is assumed to tell the truth. An
  adapter that lies can end a run as `unstable`; it cannot make it loop.
- **Bounds.** By default the environment removes at most one fact per run
  (`invalidations`), and each operator's attempts are capped at two while
  checking. The properties depend on a budget running out, not on its size.
- **Large ceremonies.** GitHub user access is too large to explore under
  unbounded faults. It is checked against every combination of up to three
  faults, and the result reports that bound (`faultDepth`). The other twelve
  flows are explored without one.
- **What `recoverable` does not promise.** No controller can undo having spent
  a one-time input on a belief the environment silently invalidated. The
  property is stated against what probes can find, net of single-use facts.
- **Lint is part of the proof.** `validate` refuses declarations the
  properties do not hold for. `stale-precondition`, `observable-support`,
  `single-use`, `consumed-detectable`, `ambiguous-invalidation` and the bound
  on the stale budget each came out of a counterexample; the rules are listed
  below.

Property tests carry the claims past the flows that happen to be declared:

- random well-formed ceremonies pass every property (`metatheory.test.ts`);
- the fault-free run costs exactly what an independent search over fact sets
  says is cheapest;
- a finished ceremony run again does nothing but look;
- each property is shown failing for a controller with one deliberate fault;
- the interpreter is driven through scripted crashes, lost replies, removals
  and replayed answers on random ceremonies, with a world double written
  against the declarations (`run.test.ts`).

## What the checks found while this was built

These are kept because they are the argument for working this way. Each was
found by a property, not by inspection.

1. **Stale reports charged the wrong party.** An operator that truthfully
   reported a removed installation lost an attempt for it; with one attempt it
   was gone for good though success was still possible. Stale reports now have
   their own budget, and on one the controller re-probes what the step rests
   on before sending a person anywhere.
2. **A lint rule was unsound.** Requiring an operator to be able to report the
   loss of each volatile fact it needs is not enough: the app can be lost and
   made again while the installation of the old app stays gone. The rule now
   covers every requirement that rests on something volatile.
3. **Knowing is not holding.** A step that creates two things and loses its
   reply was modelled as both existing. A key nobody received is gone.
   "Lives only in the reply" became a property of the fact, and the interpreter
   checks custody before anything reads a value.
4. **A crash window.** Storing a result's values and journaling the result are
   two writes. Values are now staged under the journal position and promoted
   after the commit.
5. **An answer could be replayed.** A request was identified by the attempt
   number, which does not advance when a step is re-asked after a stale
   report. An old answer could be taken for a new one. Requests are now
   identified by where they were opened in the journal.
6. **The layout proof assumed the wrong browser.** See below.

## What an independent review found

After the above, a reviewer with no part in the design was asked to break the
claims with running code. It confirmed twelve findings; none was in a declared
flow, several broke general claims. All are fixed or stated as limits here,
and each fix has a regression test in `tests/kernel/review.test.ts`.

| Finding                                                                                          | Now                                                                                               |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| An invalidation naming two facts made the controller forget a third that still held              | Refused by lint unless a probe can check everything resting on the named facts                    |
| One removal could exhaust the stale-report budget on a long chain                                | The budget must exceed the number of facts; the default scales with them                          |
| Staged values were keyed without the run and promoted whatever was committed                     | Keyed by run and journal position; promoted only for the outcome the journal committed            |
| The interpreter could loop on a probe that says held with no value, or a vault that drops values | Both spend a budget and end the run; the loop has a hard ceiling                                  |
| A human answer could name any declared outcome                                                   | A person's choice must be an action the interface offers; other outcomes are the host's to report |
| The checker excused any false belief about a fact the environment had ever removed               | Seeing a fact gone ends the excuse for what rests on it; a controller that ignores it is caught   |
| `no-duplicate-effect` had no failing-controller test                                             | It has one                                                                                        |
| The interval reading of a maximum did not bound what the renderer computed                       | The renderer takes the operand itself; tests use arbitrary doubles                                |
| The prover took a bound that is not a number as non-negative                                     | Non-finite ranges are refused and such a bound is open                                            |
| Field labels were not wrapped, so a proved layout overflowed at 320 px and doubled text          | Labels are laid out like other text                                                               |
| Text breaks after a hyphen or slash before mid-word; the model did not                           | It does                                                                                           |
| The idempotency key did not change after a settled attempt                                       | It changes when the operator succeeds or a probe finds its fact absent                            |

It tried and failed to break the planner's optimality (4,300 declarations
against the independent search), the checked properties with single-fact
invalidations (6,500 declarations), the interpreter under scripted crashes
(63,000 runs) and interval arithmetic without hints (40,000 programs).

What it found that stays a limit:

- **One caller at a time.** A second `advance` while a machine step is in
  flight reads it as a crash and may run the step again. The journal refuses
  the loser's write; it does not stop the loser's effect. A host must serialize
  calls for one run. The verified lease in `src/server/persistence` is the
  obvious way.
- **A write that lands late.** In the model a lost reply's effect happens at
  once or never. A provider that applies a timed-out request after the retry
  can still leave two.
- **A value is only as strict as its schema.** Each fact declares a validator
  (`value: of<T>(schema)`, any Standard Schema). An adapter result, a probe
  result or a person's answer whose value fails it is a defect, and nothing
  reaches the vault. What the schema leaves open, the kernel cannot see.
- **Most layout rules are true by construction.** Gutters, clearance and
  "starts below" hold because the layout is built that way; the proof's real
  content is the breakpoint arithmetic. The rules are still worth proving: they
  are what a change to the layout would break.
- **What an interface shows is not laid out.** `shows` values, the only content
  whose length is not known in advance, are neither measured nor rendered yet.

## Lint rules

`support-cycle`, `observable-support` (a fact a probe can see cannot rest on
one it cannot), `discoverable-observable`, `goal-observable`,
`given-observable`, `stale-precondition`, `consumed-detectable`, `single-use`
(a single-use fact is an input to exactly one step), `ambiguous-invalidation`,
`invalidates-required`, `operator-success`, `interface-required`,
`interface-outcome`, `secret-exposure`, `interface-shows`, `goal`, `bounds`,
`value-unchecked` (a fact a person establishes declares a validator).
Warning: `given-fact`.

## Interfaces: the calculus

`src/kernel/interface` follows Shu Ding's calculus of interfaces. A layout is
one function from its inputs to the position and size of every box, written as
a straight-line program over four operations: a weighted sum, a product, a
ReLU and a step. A breakpoint is a step that blends both outcomes; a maximum
is a ReLU; a line count is a sum of steps.

The same program is read four ways (`algebras.ts`): exactly, which is what is
drawn; softened, so a layout can move through its own breakpoints; with
gradients; and as intervals, which bound it over a whole range of inputs.

`prove` shows a quantity never goes negative over a range. It bounds, splits,
reasons by cases where a range straddles a step, and uses a mean-value bound
where no step is left undecided. It returns a counterexample when one exists.

Two things go past the original:

- **Floating point.** Interval results are widened by one representable number
  on each side, so a bound contains the rounded answer the renderer computes,
  not only the real-number one.
- **Cancellation.** Weighted sums are flattened and like terms merged, so
  `width - (pad + (width - 2 * pad))` is stored as `pad`.

`sheet.ts` lays out a ceremony interface and states its rules: gutters, target
sizes of 44 px, clearance between neighbours, labels that fit their buttons.
They are proved for every width from 320 to 1280 and every text scale from 1
to 2, for all 17 interfaces the flows derive, in under two seconds each.
Without label wrapping the prover returns the phone and text size that cut a
label off.

Scope: the rules hold to within 1/64 px. Text is measured by a fixed character
advance, which is the layout's one assumption about the font.

## In the browser

`examples/kernel` runs the GitHub App ceremony behind a UI SDK primitive
(`@ui-sdk/core`, rendered as custom elements by `@ui-sdk/web`). The primitive
holds the behaviour of one step: it takes one answer and then its controls are
off. The page places every box where the layout program puts it. The page
holds no secret and names no value; it says which action was chosen.

`examples/kernel/properties.ts` is a Bombadil specification. Bombadil answers
the interfaces, plays the environment, enlarges the text and resizes the
window, and checks in every state that boxes are where the proved layout put
them, text is never cut off, every target can be hit, nothing spills sideways,
no secret reaches the page, only derived interfaces and declared endings
appear, an answer is final, and work settles.

Its first run failed, usefully. The layout wrapped text by character count;
the browser wraps at spaces. The body of one interface needed a line more than
it was given at 390 px. The proof was sound for its model and the model was
wrong about the browser. Line counts are now the exact thresholds of greedy
word wrapping for the interface's own copy, still a sum of steps.

That is the division of labour. The model checker proves the flow. The prover
proves the geometry. Bombadil checks that the page obeys both, and tests the
assumptions the proofs rest on.

```sh
npm run test:kernel      # declarations, controller, checker, interpreter, layouts
npm run kernel:harness   # http://127.0.0.1:4180
npm run test:bombadil    # needs Chromium; not part of npm test
```

## Flows declared

GitHub App access and GitHub user access (`flows/github-app.ts`, three parts
that compose by shared fact names), and eleven families in `flows/catalog.ts`:
API key, HTTP Basic, OAuth authorization code with PKCE and refresh, device
authorization, client credentials, token exchange, password with a second
factor, magic link, passkey, federated sign-in, mutual TLS. These are models
of the protocols. A connector binds one to a provider by supplying adapters
for its machine steps; none is bound to a live provider yet.

## The existing code

The state machines already in the server are verified separately, as TLA+
models that point at the code, each with a project skill that reruns it. See
[verification](../verification/README.md).

## Not done

- The existing server does not run on the kernel. The GitHub path is the first
  to move: its adapters are the calls `src/server/recipes/github.ts` already
  makes, split by the outcomes the declaration names.
- Journal and vault have in-memory implementations only. `AsyncCeremonyStore`
  already has the revision check the journal needs.
- Timers. An expiry is modelled as the environment removing a fact; nothing
  schedules a wake-up.
- The UI SDK primitive lives in the example. It moves into the package with
  the first host that renders kernel interfaces.
- `npm run test:bombadil` is not in CI.
