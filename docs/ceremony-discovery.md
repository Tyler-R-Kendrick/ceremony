# Discovering a ceremony

A ceremony was, until now, something this project performed and then forgot. Discovery is the other half: point it at a provider, and it works out what getting in actually requires and writes that down as a [`CeremonyPlan`](../src/core/ceremony-plan.ts) — a template that can be shared and run again.

## Discovery reads; it does not act

This is the rule everything else follows from. Discovery navigates and follows links. It never fills a field and never presses a submit button.

That is what makes it safe to point at a provider you do not own. It cannot consume an address, create an account, trip a rate limiter, spend a one-time code, or send anyone an email. Everything it reports was visible on a page an ordinary visitor could have loaded. A contract test asserts this directly against the provider double — after discovering both the registration and sign-in surfaces, no account exists, no mail was sent, and no credential was issued. Two more tests hand discovery a page that throws if a field is filled or a box is checked; reaching the end at all is the assertion.

The cost of the rule is that some things cannot be observed, only inferred. Those are named in `uncertain` rather than presented as fact.

## What it works out

| Question                        | Where the answer comes from                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What must happen first?**     | Redirects. Asking for `/authorize` while signed out lands you on `/signin` — the provider stating a prerequisite for free, with nothing submitted. |
| **What else would work?**       | Links that lead to another way in — _Create an account_, _Use a passkey instead_, _Forgot your password_. Each becomes its own path.               |
| **What must the caller bring?** | The fields on each page, named by role.                                                                                                            |
| **What will it cost a person?** | Pages that demand one: a challenge, or an authenticator prompt with nothing to type. Each path carries the count.                                  |

Links that _do_ something — resend, revoke, sign out, delete — are never followed, because following them would cause the effect the rule exists to prevent.

## Reading a field without a model

Role inference is deterministic and lives in production code, not behind inference. A plan that only exists when a model answers is not a plan anyone can rely on, so the classifier is optional: it may refine what kind of step a page is, never rename its data. A classifier that throws, times out or refuses leaves discovery working, and a test asserts exactly that.

The provider double regenerates field names, label wording, control order and the signup path per instance, so a reader that passes on one shape and fails on the next has memorised a page rather than understood it. A sweep across 25 unseen shapes guards this — and it is how the confirmation-password rule was found to be wrong. The original rule read "the second password box on a page with two is the confirmation", which is correct until a page puts the confirmation box _first_: then both boxes matched and neither was the password. Position now decides only when no box says which one it is.

## What cannot be observed, and is said so

A page asking for a confirmation code proves a code exists; it does not show where it came from, because discovery never triggered a send. The plan still names that delivery as an `out-of-band` step — the plan is unrunnable without it — and records in `uncertain` that this part was inferred. The step is placed before the page that asks for the code on every path, so `requiredOf` correctly never tells a caller to bring a code nobody has sent yet.

Other entries appear when a link vanishes before a branch can be replayed, when following one leaves the origins discovery was permitted to read, and when a redirect reveals an ordering.

## A consent screen is not an interruption

Approve-or-refuse is a decision the agent is authorised to take, so it is a `decision` step with zero handoffs. Reading it as a human step would interrupt somebody for nothing, which is the defect this project exists to avoid. Only a challenge, or an authenticator prompt with no password to type, is a `human` step — and a WebAuthn _hint_ beside a password box is neither, because that page still accepts a password.

## Bounds

Discovery is bounded, never exhaustive: `maxPages` (12 by default) and `maxDepth` (2) cap how much is loaded, and `allowedOrigins` caps where. A plan is what was seen within those bounds, not a claim about everything the provider can do.

## Using it

```ts
const { plan, uncertain } = await discoverCeremony({
  page: createPlaywrightCeremonyPage(browserPage),
  entryUrl: "https://provider.example/signin",
  goal: "sign-in",
  allowedOrigins: ["https://provider.example"],
});

const route = preferredPath(plan); // fewest interruptions, then shortest
const bring = requiredOf(plan, route); // what the caller must hold up front
```

`canonicalCeremonyPlan` and `digestCeremonyPlan` make a plan shareable and comparable. A plan carries shape and order only — the schema is strict and has no field a value could live in — so sharing one discloses nothing about the person or the run it came from.

## What a discovered plan does not mean

It is a reading of pages, at one moment, within stated bounds. It is not a certification that the provider behaves this way, not a guarantee the ceremony will succeed, and not an endorsement by the provider. Everything discovery could not settle by reading is in `uncertain`, and that list is part of the result rather than a footnote to it.
