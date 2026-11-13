import type { INodeProperties } from 'n8n-workflow';

const show = (resource: string, operation: string[]) => ({
	show: { resource: [resource], operation },
});

const workspaceIdField = (
	resource: string,
	operation: string[],
	description: string,
): INodeProperties => ({
	displayName: 'Workspace ID',
	name: 'workspaceId',
	type: 'string',
	required: true,
	default: '',
	placeholder: 'wsp_…',
	description,
	displayOptions: show(resource, operation),
});

const idField = (
	displayName: string,
	name: string,
	placeholder: string,
	resource: string,
	operation: string[],
): INodeProperties => ({
	displayName,
	name,
	type: 'string',
	required: true,
	default: '',
	placeholder,
	displayOptions: show(resource, operation),
});

const pagingFields = (resource: string, operation: string[]): INodeProperties[] => [
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: show(resource, operation),
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		description: 'Max number of results to return',
		displayOptions: { show: { resource: [resource], operation, returnAll: [false] } },
	},
];

const dateRangeFields = (resource: string, operation: string[]): INodeProperties[] => [
	{
		displayName: 'Start Date',
		name: 'startDate',
		type: 'dateTime',
		required: true,
		default: '',
		description: 'The first day to include, read as a calendar date',
		displayOptions: show(resource, operation),
	},
	{
		displayName: 'End Date',
		name: 'endDate',
		type: 'dateTime',
		required: true,
		default: '',
		description: 'The last day to include, read as a calendar date',
		displayOptions: show(resource, operation),
	},
];

// The cost query options both cost operations share, sorted by display name as n8n lists them.
const costOptions: INodeProperties[] = [
	{
		displayName: 'Amortize',
		name: 'amortize',
		type: 'boolean',
		default: true,
		description: 'Whether to spread upfront commitments over the period they cover',
	},
	{
		displayName: 'Cloud Account IDs',
		name: 'cloudAccountIds',
		type: 'string',
		default: '',
		description: 'Comma-separated cloud account IDs to restrict the costs to',
	},
	{
		displayName: 'Filter',
		name: 'filter',
		type: 'string',
		default: '',
		description: 'A Costfluent cost filter expression, as the cost reports use',
	},
	{
		displayName: 'Include Credits',
		name: 'includeCredits',
		type: 'boolean',
		default: false,
		description: 'Whether to include credits',
	},
	{
		displayName: 'Include Refunds',
		name: 'includeRefunds',
		type: 'boolean',
		default: false,
		description: 'Whether to include refunds',
	},
	{
		displayName: 'Include Tax',
		name: 'includeTax',
		type: 'boolean',
		default: true,
		description: 'Whether to include tax',
	},
	{
		displayName: 'Workspace ID',
		name: 'workspaceId',
		type: 'string',
		default: '',
		placeholder: 'wsp_…',
		description:
			'Restrict the costs to one workspace. A workspace token reads its own workspace only.',
	},
];

export const resourceField: INodeProperties = {
	displayName: 'Resource',
	name: 'resource',
	type: 'options',
	noDataExpression: true,
	options: [
		{ name: 'Anomaly', value: 'anomaly' },
		{ name: 'Budget', value: 'budget' },
		{ name: 'Cost', value: 'cost' },
		{ name: 'Cost Alert', value: 'costAlert' },
		{ name: 'Cost Report', value: 'costReport' },
		{ name: 'Provider', value: 'provider' },
		{ name: 'Workspace', value: 'workspace' },
	],
	default: 'cost',
};

const operationField = (
	resource: string,
	options: Array<{ name: string; value: string; action: string; description: string }>,
	defaultValue: string,
): INodeProperties => ({
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: [resource] } },
	options,
	default: defaultValue,
});

const anomalyProperties: INodeProperties[] = [
	operationField(
		'anomaly',
		[
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many anomalies',
				description: 'List the cost anomalies Costfluent detected',
			},
		],
		'getAll',
	),
	...pagingFields('anomaly', ['getAll']),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: show('anomaly', ['getAll']),
		options: [
			{
				displayName: 'Cloud Account ID',
				name: 'cloudAccountId',
				type: 'string',
				default: '',
			},
			{
				displayName: 'End Date',
				name: 'endDate',
				type: 'dateTime',
				default: '',
				description: 'The last day to include, read as a calendar date',
			},
			{
				displayName: 'Severity',
				name: 'severity',
				type: 'string',
				default: '',
			},
			{
				displayName: 'Start Date',
				name: 'startDate',
				type: 'dateTime',
				default: '',
				description: 'The first day to include, read as a calendar date',
			},
			{
				displayName: 'Unacknowledged Only',
				name: 'unacknowledgedOnly',
				type: 'boolean',
				default: false,
				description: 'Whether to list only the anomalies nobody has acknowledged yet',
			},
		],
	},
];

const budgetProperties: INodeProperties[] = [
	operationField(
		'budget',
		[
			{ name: 'Get', value: 'get', action: 'Get a budget', description: 'Get one budget' },
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many budgets',
				description: 'List budgets',
			},
		],
		'getAll',
	),
	idField('Budget ID', 'budgetId', 'bud_…', 'budget', ['get']),
	...pagingFields('budget', ['getAll']),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: show('budget', ['getAll']),
		options: [
			{
				displayName: 'Workspace ID',
				name: 'workspaceId',
				type: 'string',
				default: '',
				placeholder: 'wsp_…',
			},
		],
	},
];

const costProperties: INodeProperties[] = [
	operationField(
		'cost',
		[
			{
				name: 'Get Data',
				value: 'getData',
				action: 'Get cost data',
				description: 'Read cost rows grouped by up to three dimensions',
			},
			{
				name: 'Get Summary',
				value: 'getSummary',
				action: 'Get a cost summary',
				description: 'Read the total, the change and the top services over a date range',
			},
		],
		'getData',
	),
	...dateRangeFields('cost', ['getData', 'getSummary']),
	...pagingFields('cost', ['getData']),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('cost', ['getData']),
		options: [
			costOptions[0],
			costOptions[1],
			costOptions[2],
			{
				displayName: 'Granularity',
				name: 'granularity',
				type: 'options',
				options: [
					{ name: 'Cumulative', value: 'cumulative' },
					{ name: 'Day', value: 'day' },
					{ name: 'Month', value: 'month' },
					{ name: 'Quarter', value: 'quarter' },
					{ name: 'Week', value: 'week' },
				],
				default: 'day',
			},
			{
				displayName: 'Group By',
				name: 'groupBy',
				type: 'string',
				default: '',
				placeholder: 'ServiceName,Tag:team',
				description: 'Up to three comma-separated dimensions, in order',
			},
			costOptions[3],
			costOptions[4],
			costOptions[5],
			{
				displayName: 'Measure',
				name: 'measure',
				type: 'options',
				options: [
					{ name: 'Cost', value: 'cost' },
					{ name: 'Count', value: 'count' },
					{ name: 'Usage', value: 'usage' },
				],
				default: 'cost',
			},
			costOptions[6],
		],
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('cost', ['getSummary']),
		options: costOptions,
	},
];

const costAlertProperties: INodeProperties[] = [
	operationField(
		'costAlert',
		[
			{
				name: 'Get',
				value: 'get',
				action: 'Get a cost alert',
				description: 'Get one cost alert',
			},
			{
				name: 'Get Events',
				value: 'getEvents',
				action: 'Get cost alert events',
				description: 'List the times a cost alert fired',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many cost alerts',
				description: 'List the cost alerts of a workspace',
			},
		],
		'getAll',
	),
	workspaceIdField(
		'costAlert',
		['get', 'getAll', 'getEvents'],
		'The workspace the cost alerts belong to',
	),
	idField('Cost Alert ID', 'costAlertId', 'alrt_…', 'costAlert', ['get', 'getEvents']),
	...pagingFields('costAlert', ['getAll', 'getEvents']),
];

const costReportProperties: INodeProperties[] = [
	operationField(
		'costReport',
		[
			{
				name: 'Get',
				value: 'get',
				action: 'Get a cost report',
				description: 'Get one cost report',
			},
			{
				name: 'Get Data',
				value: 'getData',
				action: 'Get cost report data',
				description: 'Read the summary, series and breakdown a cost report shows',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many cost reports',
				description: 'List the cost reports of a workspace',
			},
		],
		'getAll',
	),
	workspaceIdField(
		'costReport',
		['get', 'getAll', 'getData'],
		'The workspace the cost reports belong to',
	),
	idField('Cost Report ID', 'costReportId', 'crp_…', 'costReport', ['get', 'getData']),
	...pagingFields('costReport', ['getAll']),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: show('costReport', ['getAll']),
		options: [
			{
				displayName: 'Folder ID',
				name: 'folderId',
				type: 'string',
				default: '',
			},
		],
	},
];

const providerProperties: INodeProperties[] = [
	operationField(
		'provider',
		[
			{
				name: 'Get',
				value: 'get',
				action: 'Get a provider',
				description: 'Get one provider connection',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many providers',
				description: 'List provider connections',
			},
		],
		'getAll',
	),
	idField('Provider ID', 'providerId', 'prv_…', 'provider', ['get']),
	...pagingFields('provider', ['getAll']),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: show('provider', ['getAll']),
		options: [
			{
				displayName: 'Type',
				name: 'type',
				type: 'options',
				options: [
					{ name: 'Cloud', value: 'cloud' },
					{ name: 'Custom', value: 'custom' },
					{ name: 'Platform', value: 'platform' },
					{ name: 'SaaS', value: 'saas' },
				],
				default: 'cloud',
			},
		],
	},
];

const workspaceProperties: INodeProperties[] = [
	operationField(
		'workspace',
		[
			{
				name: 'Get',
				value: 'get',
				action: 'Get a workspace',
				description: 'Get one workspace',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many workspaces',
				description: 'List the workspaces the token can read',
			},
		],
		'getAll',
	),
	idField('Workspace ID', 'workspaceId', 'wsp_…', 'workspace', ['get']),
	...pagingFields('workspace', ['getAll']),
];

export const costfluentProperties: INodeProperties[] = [
	resourceField,
	...anomalyProperties,
	...budgetProperties,
	...costProperties,
	...costAlertProperties,
	...costReportProperties,
	...providerProperties,
	...workspaceProperties,
];
