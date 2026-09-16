import assert from "node:assert/strict";
import { test } from "node:test";
import {
  disambiguateProvider,
  extractProviderName,
  originCandidatesFromProvider,
  originHintFromProvider,
  proposeConnectorForProvider,
} from "../src/core/connector-authoring.js";

test("catalog proposals retain named providers, authentication families and crawl seeds", () => {
  for (const [query, name, methods, origins] of [
    [
      "github",
      "GitHub",
      ["github-app", "oauth-code", "device", "api-key"],
      ["https://github.com", "https://api.github.com"],
    ],
    ["bluesky", "Bluesky", ["oauth-code"], ["https://bsky.social"]],
    ["stripe", "Stripe", ["api-key"], ["https://api.stripe.com"]],
    ["jira", "Jira", ["oauth-code"], ["https://developer.atlassian.com"]],
    [
      "atlassian",
      "Atlassian",
      ["oauth-code"],
      ["https://developer.atlassian.com"],
    ],
    ["supabase", "Supabase", ["form"], ["https://supabase.com"]],
    ["neon", "Neon", ["authmd-anonymous"], ["https://neon.com"]],
    ["slack", "Slack", ["oauth-code"], ["https://slack.com"]],
    ["google", "Google", ["oauth-code"], ["https://accounts.google.com"]],
  ] as const) {
    const proposal = proposeConnectorForProvider(query);
    assert.equal(proposal.slug, query);
    assert.equal(proposal.name, name);
    assert.match(proposal.description, new RegExp(name));
    assert.deepEqual(proposal.methods, methods);
    assert.deepEqual(proposal.origins, origins);
  }
});

test("common abbreviations resolve to their catalog provider", () => {
  for (const [query, resolved] of [
    ["gh", "github"],
    ["ghe", "github"],
    ["goog", "google"],
  ])
    assert.equal(disambiguateProvider(query!).resolved, resolved);
});

test("chat extraction removes leading requests and quoted names with flexible whitespace", () => {
  for (const input of [
    "  can you create a connector for Quasar  ",
    "can  you  create a connector for Quasar",
    "I  want  you to create a connector for Quasar",
    "please  could you draft an integration with Quasar",
    "I want to Quasar",
    "I need you  to  build a provider for Quasar",
    "please  can you build  me  a connector for Quasar",
    "make me a ceremony to Quasar",
    "add the authentication with Quasar",
    "connect Quasar",
    "author auth  for  Quasar",
    "author auth for  with Quasar",
    "set up Quasar",
    "setup Quasar",
    "for Quasar",
    "with Quasar",
    '" Quasar "',
    "`Quasar` thanks!.",
    "'Quasar' now.",
    "Quasar thanks",
    "Quasar now",
    "Quasar please",
  ])
    assert.equal(extractProviderName(input), "Quasar", input);
});

test("chat extraction preserves request words inside a provider name", () => {
  for (const input of [
    "Quasar can you connect",
    "Quasar create Work",
    "Quasar connector for Work",
    "Quasar with Work",
    "Quasar please continue",
    "Quasar now available",
  ])
    assert.equal(extractProviderName(input), input);
});

test("empty extraction falls back to trimmed input and bounds long names", () => {
  assert.equal(extractProviderName("for  please"), "please");
  assert.equal(extractProviderName("  ''  "), "''");
  assert.equal(extractProviderName("   "), "");
  assert.equal(extractProviderName("Q".repeat(101)), "Q".repeat(100));
});

test("provider identifiers normalize hostnames and separator runs within 64 characters", () => {
  for (const [input, slug] of [
    ["http://QUASAR.example:8080/a", "quasar-example"],
    ["https://QUASAR.example/a", "quasar-example"],
    ["ftp://quasar.example", "ftp-quasar-example"],
    ["--Quasar !! Cloud--", "quasar-cloud"],
    ["Q".repeat(70), "q".repeat(64)],
  ])
    assert.equal(disambiguateProvider(input!).resolved, slug);
});

test("explicit URLs preserve the first origin and port while dropping private URL components", () => {
  assert.deepEqual(
    originCandidatesFromProvider(
      "https://user:fixture@www.vendor.example:8443/path?token=fixture#private",
    ),
    [
      "https://www.vendor.example:8443",
      "https://vendor.example",
      "https://auth.vendor.example",
      "https://accounts.vendor.example",
      "https://login.vendor.example",
      "https://api.vendor.example",
    ],
  );
  assert.equal(
    originHintFromProvider("http://vendor.example:8080/path"),
    "http://vendor.example:8080",
  );
});

test("www is stripped only from the leading label and repeated origins are deduplicated", () => {
  const expected = [
    "https://sub.www.vendor.example",
    "https://auth.sub.www.vendor.example",
    "https://accounts.sub.www.vendor.example",
    "https://login.sub.www.vendor.example",
    "https://api.sub.www.vendor.example",
  ];
  assert.deepEqual(
    originCandidatesFromProvider("https://sub.www.vendor.example/path"),
    expected,
  );
  assert.deepEqual(originCandidatesFromProvider("sub.www.vendor.example"), [
    ...expected,
    "https://vendor.example",
    "https://auth.vendor.example",
    "https://accounts.vendor.example",
    "https://login.vendor.example",
    "https://api.vendor.example",
  ]);
  assert.equal(
    originHintFromProvider("WWW.VENDOR.EXAMPLE"),
    "https://vendor.example",
  );
  assert.equal(originCandidatesFromProvider("vendor.example").length, 5);
});

test("bare domains try their full host before the final two labels", () => {
  assert.deepEqual(originCandidatesFromProvider("www.sub.vendor.example"), [
    "https://sub.vendor.example",
    "https://auth.sub.vendor.example",
    "https://accounts.sub.vendor.example",
    "https://login.sub.vendor.example",
    "https://api.sub.vendor.example",
    "https://vendor.example",
    "https://auth.vendor.example",
    "https://accounts.vendor.example",
    "https://login.vendor.example",
    "https://api.vendor.example",
  ]);
});

test("invalid domain text and non-web URLs do not become explicit crawl origins", () => {
  for (const input of [
    "+vendor.example",
    "vendor.example/",
    "ftp://vendor.test",
    "",
    "ai",
    "nova",
  ])
    assert.deepEqual(originCandidatesFromProvider(input), [], input);
});

test("suffix brands keep internal hyphens and shorten only names of at least five characters", () => {
  assert.deepEqual(originCandidatesFromProvider("xai"), [
    "https://x.ai",
    "https://auth.x.ai",
    "https://accounts.x.ai",
    "https://login.x.ai",
    "https://api.x.ai",
  ]);
  assert.deepEqual(originCandidatesFromProvider("some-brand-io"), [
    "https://some-brand.io",
    "https://auth.some-brand.io",
    "https://accounts.some-brand.io",
    "https://login.some-brand.io",
    "https://api.some-brand.io",
    "https://sand.io",
    "https://auth.sand.io",
    "https://accounts.sand.io",
    "https://login.sand.io",
    "https://api.sand.io",
  ]);
  assert.ok(
    originCandidatesFromProvider("alpha-io").includes("https://apha.io"),
  );
});

test("five-character brands prioritize apex candidates before auth hosts and cap crawling at sixteen", () => {
  assert.deepEqual(originCandidatesFromProvider("alpha"), [
    "https://alpha.social",
    "https://alpha.com",
    "https://alpha.io",
    "https://alpha.app",
    "https://alpha.org",
    "https://alpha.ai",
    "https://alpha.dev",
    "https://apha.social",
    "https://apha.com",
    "https://apha.io",
    "https://apha.app",
    "https://apha.org",
    "https://apha.ai",
    "https://apha.dev",
    "https://auth.alpha.social",
    "https://accounts.alpha.social",
  ]);
});
