import type { MergeDoubleAccount } from "../../doubles/merge-api.js";

/*
 * Two HRIS linked accounts belonging to two different end users, with
 * genuinely different capabilities — which is the ordinary case Merge
 * documents ("Fields vary by integration and Linked Account"), not an edge
 * case. Account A's provider exposes employments and a work email; account B's
 * provider has no work email at all and does not support the groups model or
 * passthrough. Nothing may paper over that difference (AC-EXT-15).
 */

export const ACCOUNT_A_TOKEN = "account-token-a";
export const ACCOUNT_B_TOKEN = "account-token-b";
export const ACCOUNT_A_PUBLIC = "public-token-a";
export const ACCOUNT_B_PUBLIC = "public-token-b";

export const employeesMetaWithWorkEmail = {
  request_schema: {
    type: "object",
    properties: {
      model: {
        type: "object",
        properties: {
          first_name: { type: "string" },
          last_name: { type: "string" },
          work_email: { type: "string" },
          employments: { type: "array", items: { type: "string" } },
        },
        required: ["first_name", "last_name"],
      },
    },
  },
  remote_field_classes: {},
  status: { linked_account_status: "COMPLETE", can_make_request: true },
  has_conditional_params: false,
  has_required_linked_account_params: false,
};

/** The same model on another account: no work_email, and a required extra field. */
export const employeesMetaWithoutWorkEmail = {
  request_schema: {
    type: "object",
    properties: {
      model: {
        type: "object",
        properties: {
          first_name: { type: "string" },
          last_name: { type: "string" },
          personal_email: { type: "string" },
        },
        required: ["first_name", "last_name", "personal_email"],
      },
    },
  },
  remote_field_classes: {},
  status: { linked_account_status: "COMPLETE", can_make_request: true },
  has_conditional_params: true,
  has_required_linked_account_params: true,
};

export const accountA: MergeDoubleAccount = {
  accountToken: ACCOUNT_A_TOKEN,
  publicToken: ACCOUNT_A_PUBLIC,
  id: "linked-account-a",
  category: "hris",
  integration: {
    name: "BambooHR",
    slug: "bamboohr",
    categories: ["hris"],
    passthrough_available: true,
  },
  status: "COMPLETE",
  accountType: "PRODUCTION",
  endUserOriginId: "org-1-user-1",
  endUserOrganizationName: "Acme",
  endUserEmailAddress: "ops@acme.test",
  models: {
    employees: [
      {
        id: "emp-a1",
        remote_id: "1",
        first_name: "Ada",
        last_name: "Lovelace",
        work_email: "ada@acme.test",
        employments: ["empl-1"],
        remote_was_deleted: false,
      },
      {
        id: "emp-a2",
        remote_id: "2",
        first_name: "Alan",
        last_name: "Turing",
        work_email: "alan@acme.test",
        employments: ["empl-2"],
        remote_was_deleted: false,
      },
    ],
    groups: [{ id: "grp-a1", name: "Engineering" }],
  },
  meta: {
    employees: employeesMetaWithWorkEmail,
    groups: {
      request_schema: { type: "object", properties: {} },
      status: { linked_account_status: "COMPLETE", can_make_request: true },
    },
  },
  passthrough: {
    "GET /v1/time_off_policies": {
      status: 200,
      response: { policies: [{ id: "p1", name: "PTO" }] },
    },
  },
};

/**
 * A second account whose provider supports fewer fields and operations: no
 * work_email on employees, no groups model at all, and no passthrough.
 */
export const accountB: MergeDoubleAccount = {
  accountToken: ACCOUNT_B_TOKEN,
  publicToken: ACCOUNT_B_PUBLIC,
  id: "linked-account-b",
  category: "hris",
  integration: {
    name: "Personio",
    slug: "personio",
    categories: ["hris"],
    passthrough_available: false,
  },
  status: "COMPLETE",
  accountType: "PRODUCTION",
  endUserOriginId: "org-2-user-1",
  endUserOrganizationName: "Globex",
  endUserEmailAddress: "ops@globex.test",
  models: {
    employees: [
      {
        id: "emp-b1",
        remote_id: "9",
        first_name: "Grace",
        last_name: "Hopper",
        personal_email: "grace@globex.test",
        remote_was_deleted: false,
      },
    ],
  },
  meta: { employees: employeesMetaWithoutWorkEmail },
};

/** An account the end user has started but not finished linking. */
export const incompleteAccount: MergeDoubleAccount = {
  accountToken: "account-token-c",
  publicToken: "public-token-c",
  id: "linked-account-c",
  category: "hris",
  integration: { name: "Workday", slug: "workday", categories: ["hris"] },
  status: "INCOMPLETE",
  endUserOriginId: "org-3-user-1",
  models: {},
  meta: {},
};

/** An account whose credential the provider invalidated; Merge asks for a relink. */
export const relinkAccount: MergeDoubleAccount = {
  accountToken: "account-token-d",
  publicToken: "public-token-d",
  id: "linked-account-d",
  category: "hris",
  integration: { name: "Gusto", slug: "gusto", categories: ["hris"] },
  status: "RELINK_NEEDED",
  statusDetail: "The credentials for this account are no longer valid.",
  endUserOriginId: "org-4-user-1",
  models: {
    employees: [{ id: "emp-d1", first_name: "Stale", last_name: "Row" }],
  },
  meta: {
    employees: {
      request_schema: { type: "object", properties: {} },
      status: { linked_account_status: "RELINK_NEEDED", can_make_request: false },
    },
  },
};
