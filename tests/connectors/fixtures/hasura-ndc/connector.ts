/*
 * NDC capability and schema documents, written from the specification
 * (https://hasura.github.io/ndc-spec/, 0.2.x, retrieved 2026-09-18). The
 * schema is the spec's own running example (authors and articles) extended
 * with a procedure, so every shape here matches a documented one.
 */

export const NDC_VERSION = "0.2.5";
export const NDC_VERSION_LEGACY = "0.1.6";

/** A connector declaring relationships, aggregates and variables. */
export const fullCapabilities = {
  query: {
    aggregates: { filter_by: {}, group_by: { filter: {}, order: {}, paginate: {} } },
    variables: {},
    explain: {},
    nested_fields: { filter_by: {}, order_by: {}, aggregates: {} },
    exists: { unrelated: {}, nested_collections: {} },
  },
  mutation: { transactional: {}, explain: {} },
  relationships: { relation_comparisons: {}, order_by_aggregate: {} },
};

/**
 * A minimal connector: no relationships at all, no aggregates, no variables.
 * Under the spec a request relying on any of these is a 501, so the adapter
 * must refuse it before submission.
 */
export const minimalCapabilities = {
  query: { nested_fields: {} },
  mutation: {},
};

export const schema = {
  scalar_types: {
    Int: {
      representation: { type: "int32" },
      aggregate_functions: {
        sum: { result_type: { type: "named", name: "Int" } },
        max: { result_type: { type: "named", name: "Int" } },
      },
      comparison_operators: {
        eq: { type: "equal" },
        lt: { type: "custom", argument_type: { type: "named", name: "Int" } },
      },
    },
    String: {
      representation: { type: "string" },
      aggregate_functions: {},
      comparison_operators: {
        eq: { type: "equal" },
        like: { type: "custom", argument_type: { type: "named", name: "String" } },
      },
    },
  },
  object_types: {
    article: {
      description: "An article",
      fields: {
        id: { description: "The article's primary key", type: { type: "named", name: "Int" } },
        title: { description: "The article's title", type: { type: "named", name: "String" } },
        author_id: { description: "The article's author id", type: { type: "named", name: "Int" } },
        /** A field the binding never approves; used to prove field policy. */
        internal_notes: { type: { type: "named", name: "String" } },
      },
      foreign_keys: {
        article_author: {
          column_mapping: { author_id: ["id"] },
          foreign_collection: "authors",
        },
      },
    },
    author: {
      description: "An author",
      fields: {
        id: { type: { type: "named", name: "Int" } },
        name: { type: { type: "named", name: "String" } },
        /** Never approved anywhere; a relationship must not expose it. */
        salary: { type: { type: "named", name: "Int" } },
      },
      foreign_keys: {},
    },
  },
  collections: [
    {
      name: "articles",
      description: "A collection of articles",
      arguments: {},
      type: "article",
      uniqueness_constraints: { ArticleByID: { unique_columns: ["id"] } },
    },
    {
      name: "authors",
      description: "A collection of authors",
      arguments: {},
      type: "author",
      uniqueness_constraints: { AuthorByID: { unique_columns: ["id"] } },
    },
    {
      name: "articles_by_author",
      description: "Articles parameterized by author",
      arguments: { author_id: { type: { type: "named", name: "Int" } } },
      type: "article",
      uniqueness_constraints: {},
    },
  ],
  functions: [
    {
      name: "latest_article_id",
      description: "Get the ID of the most recent article",
      arguments: {},
      result_type: { type: "nullable", underlying_type: { type: "named", name: "Int" } },
    },
  ],
  procedures: [
    {
      name: "upsert_article",
      description: "Insert or update an article",
      arguments: {
        article: {
          description: "The article to insert or update",
          type: { type: "named", name: "article" },
        },
      },
      result_type: { type: "nullable", underlying_type: { type: "named", name: "article" } },
    },
    {
      name: "delete_articles",
      description: "Delete articles matching a predicate",
      arguments: {
        where: { type: { type: "predicate", object_type_name: "article" } },
      },
      result_type: { type: "array", element_type: { type: "named", name: "article" } },
    },
  ],
};

/** A schema whose procedures list is empty; mutations are unavailable, not guessed. */
export const readOnlySchema = {
  ...schema,
  procedures: [],
};

export const articleRows = [
  { id: 1, title: "The Next 700 Programming Languages", author_id: 1, internal_notes: "SECRET-NOTE" },
  { id: 2, title: "Fundamental Concepts in Programming Languages", author_id: 1, internal_notes: "SECRET-NOTE" },
  { id: 3, title: "A Theory of Type Polymorphism", author_id: 2, internal_notes: "SECRET-NOTE" },
];

export const authorRows = [
  { id: 1, name: "Peter Landin", salary: 100 },
  { id: 2, name: "Robin Milner", salary: 200 },
];
