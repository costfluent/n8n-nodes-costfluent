import { NodeOperationError, type IDataObject, type IExecuteFunctions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { Costfluent } from '../nodes/Costfluent/Costfluent.node';
import { executeContext } from './fakes';

const WORKSPACE = 'wsp_AAAAAAAAAAAAAAAAAAAAAA';
const REPORT = 'crp_AAAAAAAAAAAAAAAAAAAAAA';
const BUDGET = 'bud_AAAAAAAAAAAAAAAAAAAAAA';
const ALERT = 'alrt_AAAAAAAAAAAAAAAAAAAAAA';
const PROVIDER = 'prv_AAAAAAAAAAAAAAAAAAAAAA';

const node = new Costfluent();

// What NodeApiError in the installed n8n-workflow makes of an error carrying httpCode 403. A literal,
// so an n8n upgrade that rewords it fails here and is reviewed rather than followed silently.
const FORBIDDEN = 'Forbidden - perhaps check your credentials?';

const forbidden = () =>
	Object.assign(new Error('Request failed with status code 403'), { httpCode: '403' });

/** Runs the node and answers what it threw, or what it returned when it did not throw. */
const failure = (context: IExecuteFunctions) =>
	node.execute.call(context).catch((error: unknown) => error);

interface Operation {
	parameters: Record<string, unknown>;
	path: string;
	qs: IDataObject;
	/** The page size of a paginated listing; undefined for a single object. */
	pageSize?: number;
}

const operations: Record<string, Operation> = {
	'anomaly getAll': {
		parameters: {
			resource: 'anomaly',
			operation: 'getAll',
			filters: {
				severity: 'high',
				unacknowledgedOnly: true,
				startDate: '2026-10-01T00:00:00.000+02:00',
				cloudAccountId: '',
			},
		},
		path: '/v1/anomalies',
		qs: { severity: 'high', unacknowledgedOnly: true, startDate: '2026-10-01' },
		pageSize: 100,
	},
	'budget get': {
		parameters: { resource: 'budget', operation: 'get', budgetId: BUDGET },
		path: `/v1/budgets/${BUDGET}`,
		qs: {},
	},
	'budget getAll': {
		parameters: { resource: 'budget', operation: 'getAll', filters: { workspaceId: WORKSPACE } },
		path: '/v1/budgets',
		qs: { workspaceId: WORKSPACE },
		pageSize: 100,
	},
	'cost getData': {
		parameters: {
			resource: 'cost',
			operation: 'getData',
			startDate: '2026-09-01T00:00:00',
			endDate: '2026-09-30',
			options: {
				workspaceId: WORKSPACE,
				granularity: 'month',
				groupBy: 'ServiceName, Tag:team',
				cloudAccountIds: '123456789012,210987654321',
				includeCredits: true,
				filter: '',
			},
		},
		path: '/v1/costs',
		qs: {
			startDate: '2026-09-01',
			endDate: '2026-09-30',
			workspaceId: WORKSPACE,
			granularity: 'month',
			groupBy: ['ServiceName', 'Tag:team'],
			cloudAccountIds: ['123456789012', '210987654321'],
			includeCredits: true,
		},
		pageSize: 5000,
	},
	'cost getSummary': {
		parameters: {
			resource: 'cost',
			operation: 'getSummary',
			startDate: '2026-09-01',
			endDate: '2026-09-30',
			options: { amortize: false },
		},
		path: '/v1/costs/summary',
		qs: { startDate: '2026-09-01', endDate: '2026-09-30', amortize: false },
	},
	'costAlert get': {
		parameters: {
			resource: 'costAlert',
			operation: 'get',
			workspaceId: WORKSPACE,
			costAlertId: ALERT,
		},
		path: `/v1/cost-alerts/${ALERT}`,
		qs: { workspaceId: WORKSPACE },
	},
	'costAlert getAll': {
		parameters: { resource: 'costAlert', operation: 'getAll', workspaceId: WORKSPACE },
		path: '/v1/cost-alerts',
		qs: { workspaceId: WORKSPACE },
		pageSize: 100,
	},
	'costAlert getEvents': {
		parameters: {
			resource: 'costAlert',
			operation: 'getEvents',
			workspaceId: WORKSPACE,
			costAlertId: ALERT,
		},
		path: `/v1/cost-alerts/${ALERT}/events`,
		qs: { workspaceId: WORKSPACE },
		pageSize: 100,
	},
	'costReport get': {
		parameters: {
			resource: 'costReport',
			operation: 'get',
			workspaceId: WORKSPACE,
			costReportId: REPORT,
		},
		path: `/v1/cost-reports/${REPORT}`,
		qs: { workspaceId: WORKSPACE },
	},
	'costReport getAll': {
		parameters: {
			resource: 'costReport',
			operation: 'getAll',
			workspaceId: WORKSPACE,
			filters: { folderId: 'fld_AAAAAAAAAAAAAAAAAAAAAA' },
		},
		path: '/v1/cost-reports',
		qs: { workspaceId: WORKSPACE, folderId: 'fld_AAAAAAAAAAAAAAAAAAAAAA' },
		pageSize: 100,
	},
	'costReport getData': {
		parameters: {
			resource: 'costReport',
			operation: 'getData',
			workspaceId: WORKSPACE,
			costReportId: REPORT,
		},
		path: `/v1/cost-reports/${REPORT}/data`,
		qs: { workspaceId: WORKSPACE },
	},
	'provider get': {
		parameters: { resource: 'provider', operation: 'get', providerId: PROVIDER },
		path: `/v1/providers/${PROVIDER}`,
		qs: {},
	},
	'provider getAll': {
		parameters: { resource: 'provider', operation: 'getAll', filters: { type: 'cloud' } },
		path: '/v1/providers',
		qs: { type: 'cloud' },
		pageSize: 100,
	},
	'workspace get': {
		parameters: { resource: 'workspace', operation: 'get', workspaceId: WORKSPACE },
		path: `/v1/workspaces/${WORKSPACE}`,
		qs: {},
	},
	'workspace getAll': {
		parameters: { resource: 'workspace', operation: 'getAll' },
		path: '/v1/workspaces',
		qs: {},
		pageSize: 100,
	},
};

// The next link as the API writes it: absolute, on its own host, carrying the request's filters.
function nextLink(path: string, qs: IDataObject, page: number, limit: number): string {
	const url = new URL(path, 'https://api.costfluent.com');
	for (const [key, value] of Object.entries({ ...qs, page, limit })) {
		for (const item of Array.isArray(value) ? value : [value]) {
			url.searchParams.append(key, String(item));
		}
	}
	return url.toString();
}

// What a query looks like once read back from a link: every value a string, repeated keys a list.
function asLinkQuery(qs: IDataObject): IDataObject {
	return Object.fromEntries(
		Object.entries(qs).map(([key, value]) => [
			key,
			Array.isArray(value) ? value.map(String) : String(value),
		]),
	);
}

describe('each read operation', () => {
	it('covers every operation the node offers', () => {
		const offered = node.description.properties
			.filter((p) => p.name === 'operation')
			.flatMap((p) =>
				(p.options as Array<{ value: string }>).map(
					(o) => `${(p.displayOptions?.show?.resource as string[])[0]} ${o.value}`,
				),
			);
		expect(offered.sort()).toEqual(Object.keys(operations).sort());
	});

	for (const [name, op] of Object.entries(operations)) {
		if (op.pageSize === undefined) {
			it(`${name} sends GET ${op.path} with its query`, async () => {
				const body = { id: 'x', name: 'one object' };
				const { context, requests } = executeContext(op.parameters, [body]);

				const [items] = await node.execute.call(context);

				expect(requests).toHaveLength(1);
				expect(requests[0].credential).toBe('costfluentApi');
				expect(requests[0].options).toMatchObject({
					method: 'GET',
					baseURL: 'https://api.costfluent.test',
					url: op.path,
					json: true,
				});
				expect(requests[0].options.qs).toEqual(op.qs);
				expect(items).toEqual([{ json: body, pairedItem: { item: 0 } }]);
			});
		} else {
			const pageSize = op.pageSize;
			it(`${name} sends GET ${op.path} with its query and pages through links.next`, async () => {
				const next = nextLink(op.path, op.qs, 2, pageSize);
				const { context, requests } = executeContext({ ...op.parameters, returnAll: true }, [
					{ links: { self: 'first', next }, data: [{ id: 1 }, { id: 2 }] },
					{ links: { self: next, next: null }, data: [{ id: 3 }] },
				]);

				const [items] = await node.execute.call(context);

				expect(requests).toHaveLength(2);
				for (const request of requests) {
					expect(request.credential).toBe('costfluentApi');
					// The next page goes to the credential's base URL, not to the link's host.
					expect(request.options).toMatchObject({
						method: 'GET',
						baseURL: 'https://api.costfluent.test',
						url: op.path,
						arrayFormat: 'repeat',
					});
				}
				expect(requests[0].options.qs).toEqual({ ...op.qs, limit: pageSize });
				expect(requests[1].options.qs).toEqual(asLinkQuery({ ...op.qs, page: 2, limit: pageSize }));
				expect(items).toEqual([1, 2, 3].map((id) => ({ json: { id }, pairedItem: { item: 0 } })));
			});
		}
	}
});

describe('paging', () => {
	const page = (ids: number[], next: string | null) => ({
		links: { self: 'self', next },
		data: ids.map((id) => ({ id })),
	});
	const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

	it('asks for no more than the limit and stops once it has that many', async () => {
		const { context, requests } = executeContext(
			{ resource: 'workspace', operation: 'getAll', returnAll: false, limit: 3 },
			[page([1, 2, 3], nextLink('/v1/workspaces', {}, 2, 3))],
		);

		const [items] = await node.execute.call(context);

		expect(requests).toHaveLength(1);
		expect(requests[0].options.qs).toEqual({ limit: 3 });
		expect(items.map((i) => i.json.id)).toEqual([1, 2, 3]);
	});

	it('reads further pages until the limit and trims the last one', async () => {
		const { context, requests } = executeContext(
			{ resource: 'workspace', operation: 'getAll', returnAll: false, limit: 150 },
			[
				page(range(1, 100), nextLink('/v1/workspaces', {}, 2, 100)),
				page(range(101, 100), nextLink('/v1/workspaces', {}, 3, 100)),
			],
		);

		const [items] = await node.execute.call(context);

		expect(requests).toHaveLength(2);
		expect(requests[0].options.qs).toEqual({ limit: 100 });
		expect(items).toHaveLength(150);
		expect(items[149].json.id).toBe(150);
	});

	it('stops at an empty page even if it links a next one', async () => {
		const { context, requests } = executeContext(
			{ resource: 'workspace', operation: 'getAll', returnAll: true },
			[page([], nextLink('/v1/workspaces', {}, 2, 100))],
		);

		const [items] = await node.execute.call(context);

		expect(requests).toHaveLength(1);
		expect(items).toEqual([]);
	});

	it('fails instead of looping when the API links the same page twice', async () => {
		const loop = nextLink('/v1/workspaces', {}, 2, 100);
		const { context } = executeContext(
			{ resource: 'workspace', operation: 'getAll', returnAll: true },
			[page([1], loop), page([2], loop), page([3], loop)],
		);

		await expect(node.execute.call(context)).rejects.toThrow(/twice/);
	});

	it('names the item whose listing links the same page twice', async () => {
		const loop = nextLink('/v1/workspaces', {}, 2, 100);
		const { context, requests } = executeContext(
			[
				{ resource: 'workspace', operation: 'get', workspaceId: WORKSPACE },
				{ resource: 'workspace', operation: 'getAll', returnAll: true },
			],
			[{ id: WORKSPACE }, page([1], loop), page([2], loop)],
		);

		const error = await failure(context);

		expect(requests).toHaveLength(3);
		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error).toMatchObject({
			message: `The Costfluent API returned the page ${loop} twice while listing /v1/workspaces`,
			context: { itemIndex: 1 },
		});
	});
});

describe('cost data version', () => {
	const VERSION = '3f2a9c0d1e4b5a68';
	const NEW_VERSION = '9b8c7d6e5f4a3b2c';
	const costs = operations['cost getData'];
	const link = (pageNumber: number, version?: string) =>
		nextLink(
			costs.path,
			version === undefined ? costs.qs : { ...costs.qs, dataVersion: version },
			pageNumber,
			5000,
		);
	const costPage = (ids: number[], version: string | undefined, next: string | null) => ({
		links: { self: 'self', next },
		data: ids.map((id) => ({ id })),
		...(version === undefined ? {} : { meta: { dataVersion: version, totalRecords: 10_001 } }),
	});
	// The error n8n raises for an HTTP error answer: the status, and the parsed problem body.
	const problem = (status: number, code: string) =>
		Object.assign(new Error(`Request failed with status code ${status}`), {
			httpCode: String(status),
			response: {
				status,
				data: { title: 'Conflict', status, code, detail: 'The data changed since page 1.' },
			},
		});
	const conflict = () => problem(409, 'conflict');

	it("cost getData returnAll sends the first page's dataVersion with every later page", async () => {
		const { context, requests } = executeContext({ ...costs.parameters, returnAll: true }, [
			// The API's link carries dataVersion only when the request sent it.
			costPage([1, 2], VERSION, link(2)),
			costPage([3, 4], VERSION, link(3, VERSION)),
			costPage([5], VERSION, null),
		]);

		const [items] = await node.execute.call(context);

		expect(requests).toHaveLength(3);
		expect(requests[0].options.qs).toEqual({ ...costs.qs, limit: 5000 });
		expect(requests[1].options.qs).toEqual(
			asLinkQuery({ ...costs.qs, page: 2, limit: 5000, dataVersion: VERSION }),
		);
		expect(requests[2].options.qs).toEqual(
			asLinkQuery({ ...costs.qs, page: 3, limit: 5000, dataVersion: VERSION }),
		);
		expect(items.map((i) => i.json.id)).toEqual([1, 2, 3, 4, 5]);
	});

	it('cost getData returnAll reads again from page 1 when a page answers 409 conflict', async () => {
		const { context, requests } = executeContext({ ...costs.parameters, returnAll: true }, [
			costPage([1, 2], VERSION, link(2)),
			conflict(),
			costPage([10, 11], NEW_VERSION, link(2)),
			costPage([12], NEW_VERSION, null),
		]);

		const [items] = await node.execute.call(context);

		expect(requests).toHaveLength(4);
		expect(requests[1].options.qs).toMatchObject({ dataVersion: VERSION });
		// The second walk starts from page 1 without a version and pins the new one.
		expect(requests[2].options.qs).toEqual({ ...costs.qs, limit: 5000 });
		expect(requests[3].options.qs).toEqual(
			asLinkQuery({ ...costs.qs, page: 2, limit: 5000, dataVersion: NEW_VERSION }),
		);
		expect(items.map((i) => i.json.id)).toEqual([10, 11, 12]);
	});

	it('cost getData returnAll fails after repeated conflicts', async () => {
		const walks = () => [costPage([1, 2], VERSION, link(2)), conflict()];
		const { context, requests } = executeContext({ ...costs.parameters, returnAll: true }, [
			...walks(),
			...walks(),
			...walks(),
		]);

		await expect(node.execute.call(context)).rejects.toThrow(/kept changing/);
		expect(requests).toHaveLength(6);
	});

	it('names the item whose cost data kept changing', async () => {
		const walks = () => [costPage([1, 2], VERSION, link(2)), conflict()];
		const { context, requests } = executeContext(
			[
				{ resource: 'workspace', operation: 'get', workspaceId: WORKSPACE },
				{ ...costs.parameters, returnAll: true },
			],
			[{ id: WORKSPACE }, ...walks(), ...walks(), ...walks()],
		);

		const error = await failure(context);

		expect(requests).toHaveLength(7);
		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error).toMatchObject({
			message:
				'The Costfluent cost data kept changing while /v1/costs was read: a provider sync landed during each of 3 reads',
			context: { itemIndex: 1 },
		});
	});

	it('cost getData returns no partial rows after repeated conflicts when the node continues on fail', async () => {
		const walks = () => [costPage([1, 2], VERSION, link(2)), conflict()];
		const { context } = executeContext({ ...costs.parameters, returnAll: true }, [
			...walks(),
			...walks(),
			...walks(),
		]);
		(context as unknown as { continueOnFail: () => boolean }).continueOnFail = () => true;

		const [items] = await node.execute.call(context);

		expect(items).toHaveLength(1);
		expect(items[0].json.error).toMatch(/kept changing/);
	});

	it('cost getData with a limit spanning two pages pins the second page too', async () => {
		const { context, requests } = executeContext(
			{ ...costs.parameters, returnAll: false, limit: 7000 },
			[costPage([1, 2], VERSION, link(2)), costPage([3], VERSION, null)],
		);

		const [items] = await node.execute.call(context);

		expect(requests).toHaveLength(2);
		expect(requests[1].options.qs).toMatchObject({ dataVersion: VERSION });
		expect(items).toHaveLength(3);
	});

	it('cost getData sends no dataVersion when one page holds every row', async () => {
		const { context, requests } = executeContext({ ...costs.parameters, returnAll: true }, [
			costPage([1], VERSION, null),
		]);

		await node.execute.call(context);

		expect(requests).toHaveLength(1);
		expect(requests[0].options.qs).not.toHaveProperty('dataVersion');
	});

	// What NodeApiError in the installed n8n-workflow makes of each status; literals, as FORBIDDEN is.
	const INVALID = 'Your request is invalid or could not be processed by the service';

	it.each([
		['a 409 with another code', () => problem(409, 'idempotency_key_reused'), INVALID],
		[
			'a 400',
			() => problem(400, 'validation_failed'),
			'Bad request - please check your parameters',
		],
		[
			'a 503',
			() => problem(503, 'service_unavailable'),
			'Service unavailable - try again later or consider setting this node to retry automatically (in the node settings)',
		],
	])('cost getData fails at once on %s instead of reading again', async (_, error, message) => {
		const { context, requests } = executeContext({ ...costs.parameters, returnAll: true }, [
			costPage([1, 2], VERSION, link(2)),
			error(),
			costPage([1, 2], VERSION, null),
		]);

		const thrown = await failure(context);

		expect(requests).toHaveLength(2);
		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect(thrown).toMatchObject({ message, context: { itemIndex: 0 } });
	});

	it.each([
		['anomaly getAll', '/v1/anomalies'],
		['budget getAll', '/v1/budgets'],
	])('%s neither sends a dataVersion nor reads again on a conflict', async (name, path) => {
		const op = operations[name];
		// Even a listing page that carried a version would not be pinned to it.
		const listPage = (ids: number[], next: string | null) => costPage(ids, VERSION, next);
		const pinned = executeContext({ ...op.parameters, returnAll: true }, [
			listPage([1], nextLink(path, op.qs, 2, 100)),
			listPage([2], null),
		]);

		await node.execute.call(pinned.context);

		expect(pinned.requests).toHaveLength(2);
		expect(pinned.requests[1].options.qs).not.toHaveProperty('dataVersion');

		const conflicted = executeContext({ ...op.parameters, returnAll: true }, [
			listPage([1], nextLink(path, op.qs, 2, 100)),
			conflict(),
			listPage([1], null),
		]);

		const thrown = await failure(conflicted.context);

		expect(conflicted.requests).toHaveLength(2);
		expect(thrown).toBeInstanceOf(NodeOperationError);
		expect(thrown).toMatchObject({ message: INVALID, context: { itemIndex: 0 } });
	});
});

describe('errors', () => {
	it('refuses a date it cannot read before calling the API', async () => {
		const { context, requests } = executeContext(
			{
				resource: 'cost',
				operation: 'getSummary',
				startDate: 'last month',
				endDate: '2026-09-30',
				options: {},
			},
			[],
		);

		await expect(node.execute.call(context)).rejects.toThrow(/Start Date must be a date/);
		expect(requests).toHaveLength(0);
	});

	it.each([
		['budgetId', { resource: 'budget', operation: 'get', budgetId: '  ' }],
		['workspaceId', { resource: 'costAlert', operation: 'getAll', workspaceId: '' }],
	])('refuses a blank %s before calling the API', async (name, parameters) => {
		const { context, requests } = executeContext(parameters, []);

		await expect(node.execute.call(context)).rejects.toThrow(`${name} is required`);
		expect(requests).toHaveLength(0);
	});

	it('escapes an ID before putting it in the path', async () => {
		const { context, requests } = executeContext(
			{ resource: 'budget', operation: 'get', budgetId: 'bud_1/../x?expand=all' },
			[{ id: 'bud_1' }],
		);

		await node.execute.call(context);

		expect(requests).toHaveLength(1);
		expect(requests[0].options.url).toBe('/v1/budgets/bud_1%2F..%2Fx%3Fexpand%3Dall');
	});

	it('fails the node on an API error', async () => {
		const { context } = executeContext(
			{ resource: 'workspace', operation: 'get', workspaceId: WORKSPACE },
			[forbidden()],
		);

		const error = await failure(context);

		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error).toMatchObject({ message: FORBIDDEN, context: { itemIndex: 0 } });
	});

	it('names the item that failed when a later item fails the node', async () => {
		const get = { resource: 'workspace', operation: 'get', workspaceId: WORKSPACE };
		const { context, requests } = executeContext([get, get], [{ id: WORKSPACE }, forbidden()]);

		const error = await failure(context);

		expect(requests).toHaveLength(2);
		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error).toMatchObject({ message: FORBIDDEN, context: { itemIndex: 1 } });
	});

	it('returns the error as an item when the node continues on fail', async () => {
		const { context } = executeContext(
			{ resource: 'workspace', operation: 'get', workspaceId: WORKSPACE },
			[new Error('Request failed with status code 403')],
		);
		(context as unknown as { continueOnFail: () => boolean }).continueOnFail = () => true;

		const [items] = await node.execute.call(context);

		expect(items).toEqual([
			{ json: { error: 'Request failed with status code 403' }, pairedItem: { item: 0 } },
		]);
	});
});

describe('several input items', () => {
	const getWorkspace = (workspaceId: string) => ({
		resource: 'workspace',
		operation: 'get',
		workspaceId,
	});

	it('reads each item with its own parameters and pairs each output with its item', async () => {
		const { context, requests } = executeContext(
			[getWorkspace('ws_1'), getWorkspace('ws_2')],
			[{ id: 'ws_1' }, { id: 'ws_2' }],
		);

		const [items] = await node.execute.call(context);

		expect(requests.map((r) => r.options.url)).toEqual([
			'/v1/workspaces/ws_1',
			'/v1/workspaces/ws_2',
		]);
		expect(items).toEqual([
			{ json: { id: 'ws_1' }, pairedItem: { item: 0 } },
			{ json: { id: 'ws_2' }, pairedItem: { item: 1 } },
		]);
	});

	it('goes on to the next item after a failed one when the node continues on fail', async () => {
		const { context, requests } = executeContext(
			[getWorkspace('ws_1'), getWorkspace('ws_2'), getWorkspace('ws_3'), getWorkspace('ws_4')],
			[
				{ id: 'ws_1' },
				new Error('Request failed with status code 403'),
				new Error('Request failed with status code 404'),
				{ id: 'ws_4' },
			],
		);
		(context as unknown as { continueOnFail: () => boolean }).continueOnFail = () => true;

		const [items] = await node.execute.call(context);

		expect(requests.map((r) => r.options.url)).toEqual([
			'/v1/workspaces/ws_1',
			'/v1/workspaces/ws_2',
			'/v1/workspaces/ws_3',
			'/v1/workspaces/ws_4',
		]);
		// Each failed item carries its own error, so a workflow can tell why that item failed.
		expect(items).toEqual([
			{ json: { id: 'ws_1' }, pairedItem: { item: 0 } },
			{ json: { error: 'Request failed with status code 403' }, pairedItem: { item: 1 } },
			{ json: { error: 'Request failed with status code 404' }, pairedItem: { item: 2 } },
			{ json: { id: 'ws_4' }, pairedItem: { item: 3 } },
		]);
	});
});

describe('base URL', () => {
	const get = { resource: 'workspace', operation: 'get', workspaceId: WORKSPACE };

	it.each([
		'http://api.costfluent.com',
		'http://localhost.example.com',
		'http://127.0.0.1.example.com',
		'http://evillocalhost:5080',
		'http://127.0.0.1@evil.example',
		'ftp://api.costfluent.com',
		'not a url',
	])('refuses to send the token to %s', async (baseUrl) => {
		const { context, requests } = executeContext(get, [], { apiToken: 'cf_org_test', baseUrl });

		await expect(node.execute.call(context)).rejects.toThrow(/base URL/);
		expect(requests).toHaveLength(0);
	});

	it('names the first item when it refuses the base URL', async () => {
		const { context, requests } = executeContext([get, get], [], {
			apiToken: 'cf_org_test',
			baseUrl: 'http://api.costfluent.com',
		});

		const error = await failure(context);

		expect(requests).toHaveLength(0);
		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error).toMatchObject({
			message: 'The Costfluent base URL must use https, got "http://api.costfluent.com"',
			context: { itemIndex: 0 },
		});
	});

	it.each([
		['', 'https://api.costfluent.com'],
		['http://localhost:5080/', 'http://localhost:5080'],
		['http://localhost', 'http://localhost'],
		['http://LOCALHOST:5080', 'http://LOCALHOST:5080'],
		['http://127.0.0.1:5080', 'http://127.0.0.1:5080'],
		['http://[::1]:5080', 'http://[::1]:5080'],
		['https://api.costfluent.com/', 'https://api.costfluent.com'],
	])('reads "%s" as %s', async (baseUrl, expected) => {
		const { context, requests } = executeContext(get, [{ id: WORKSPACE }], {
			apiToken: 'cf_org_test',
			baseUrl,
		});

		await node.execute.call(context);

		expect(requests[0].options.baseURL).toBe(expected);
	});
});
