import type { IDataObject, IHttpRequestOptions, INodeProperties } from 'n8n-workflow';
import { expect, it } from 'vitest';

import { Costfluent } from '../nodes/Costfluent/Costfluent.node';
import { CostfluentTrigger } from '../nodes/CostfluentTrigger/CostfluentTrigger.node';
import { executeContext, fullResponse, hookContext } from './fakes';
import contractDocument from './testdata/public.v1.json';

// Holds both nodes to the Public API: every request they send must be an operation of the API's
// OpenAPI document, with only query parameters and enumerated values it takes, every query
// parameter it requires, and the answer fields the nodes read. The other tests check the requests
// against what the nodes were written to send, so they cannot see the API move.
// testdata/public.v1.json is a byte copy of the Go SDK's contract document, regenerated with it and
// never edited by hand.

const contract: unknown = contractDocument;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
	return isObject(value) ? value[key] : undefined;
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: [];
}

function resolve(schema: unknown): unknown {
	let current = schema;
	const seen = new Set<string>();
	for (;;) {
		const ref = field(current, '$ref');
		if (typeof ref !== 'string') {
			return current;
		}
		if (!ref.startsWith('#/') || seen.has(ref)) {
			throw new Error(`The contract has a $ref this test cannot resolve: ${ref}`);
		}
		seen.add(ref);
		current = ref
			.slice(2)
			.split('/')
			.reduce<unknown>((node, key) => field(node, key), contract);
	}
}

// The schema and every schema it combines through allOf, oneOf or anyOf, each resolved.
function variants(schema: unknown): JsonObject[] {
	const resolved = resolve(schema);
	if (!isObject(resolved)) {
		return [];
	}
	const found = [resolved];
	for (const key of ['allOf', 'oneOf', 'anyOf']) {
		const members = resolved[key];
		if (Array.isArray(members)) {
			for (const member of members) {
				found.push(...variants(member));
			}
		}
	}
	return found;
}

function enumValues(schema: unknown): string[] {
	return variants(schema).flatMap((variant) => [
		...strings(variant.enum),
		...strings(variant['x-extensible-enum']),
	]);
}

function propertiesOf(schema: unknown): JsonObject {
	return Object.assign(
		{},
		...variants(schema).map((variant) => (isObject(variant.properties) ? variant.properties : {})),
	);
}

function requiredOf(schema: unknown): string[] {
	return variants(schema).flatMap((variant) => strings(variant.required));
}

function jsonSchema(holder: unknown): unknown {
	return field(field(field(holder, 'content'), 'application/json'), 'schema');
}

interface ApiOperation {
	method: string;
	template: string;
	pathItem: JsonObject;
	operation: JsonObject;
}

// A {param} segment matches only a value the test sent, and a literal segment only itself, so a
// request that drops an id matches no shorter template.
function matches(template: string, url: string, sentinels: Set<string>): boolean {
	const expected = template.split('/');
	const actual = url.split('/');
	return (
		expected.length === actual.length &&
		expected.every((segment, index) =>
			/^\{[^}]+\}$/.test(segment)
				? sentinels.has(decodeURIComponent(actual[index]))
				: segment === actual[index],
		)
	);
}

function apiOperation(method: string, url: string, sentinels: Set<string>): ApiOperation {
	const paths = field(contract, 'paths');
	const verb = method.toLowerCase();
	for (const [template, pathItem] of Object.entries(isObject(paths) ? paths : {})) {
		const operation = field(pathItem, verb);
		if (isObject(pathItem) && isObject(operation) && matches(template, url, sentinels)) {
			return { method: verb, template, pathItem, operation };
		}
	}
	throw new Error(`${method} ${url} is not an operation of the Public API`);
}

function parametersIn(found: ApiOperation, location: string): JsonObject[] {
	const declared = [found.pathItem.parameters, found.operation.parameters].flatMap((list) =>
		Array.isArray(list) ? list : [],
	);
	return declared
		.map((parameter) => resolve(parameter))
		.filter((parameter): parameter is JsonObject => field(parameter, 'in') === location);
}

function okSchema(found: ApiOperation, status: string): unknown {
	return jsonSchema(field(field(found.operation, 'responses'), status));
}

// --- The action node --------------------------------------------------------------------------

const actionProperties = new Costfluent().description.properties;

function isShown(property: INodeProperties, parameters: Record<string, unknown>): boolean {
	if (property.displayOptions?.hide !== undefined) {
		throw new Error(`The test cannot evaluate the hide condition of ${property.name}`);
	}
	const show = property.displayOptions?.show ?? {};
	return Object.entries(show).every(
		([key, allowed]) =>
			Array.isArray(allowed) && allowed.some((value: unknown) => value === parameters[key]),
	);
}

function choiceValues(property: INodeProperties): string[] {
	return (property.options ?? []).flatMap((option) =>
		'value' in option && typeof option.value === 'string' ? [option.value] : [],
	);
}

function collectionFields(property: INodeProperties): INodeProperties[] {
	return (property.options ?? []).filter(
		(option): option is INodeProperties => 'type' in option && 'default' in option,
	);
}

const operations: Array<[string, string]> = actionProperties
	.filter((property) => property.name === 'operation')
	.flatMap((property) =>
		strings(property.displayOptions?.show?.resource).flatMap((resource) =>
			choiceValues(property).map((operation): [string, string] => [resource, operation]),
		),
	);

// Every value is one the test can recognise again in the request: a string field sends a
// sentinel naming it, which is URL-safe and distinct per field.
function sample(property: INodeProperties, sentinels: Set<string>): unknown {
	switch (property.type) {
		case 'string': {
			const sentinel = `${property.name}-sentinel`;
			sentinels.add(sentinel);
			return sentinel;
		}
		case 'dateTime':
			return '2026-10-01T00:00:00.000Z';
		case 'boolean':
			return true;
		case 'number':
			return 10;
		case 'options': {
			const [first] = choiceValues(property);
			if (first === undefined) {
				throw new Error(`${property.name} offers no choice`);
			}
			return first;
		}
		case 'collection':
			return Object.fromEntries(
				collectionFields(property).map((option) => [option.name, sample(option, sentinels)]),
			);
		default:
			throw new Error(
				`The test cannot build a value for ${property.name} of type ${property.type}`,
			);
	}
}

function parametersFor(
	resource: string,
	operation: string,
	choose: (property: INodeProperties) => unknown,
): Record<string, unknown> {
	const parameters: Record<string, unknown> = { resource, operation };
	for (const property of actionProperties) {
		if (property.name === 'resource' || property.name === 'operation') {
			continue;
		}
		if (property.type !== 'notice' && isShown(property, parameters)) {
			parameters[property.name] = choose(property);
		}
	}
	return parameters;
}

// One empty page with no next link, so a listing stops after its first request.
function emptyPage(): IDataObject {
	return { data: [], links: { self: '', next: null } };
}

async function send(parameters: Record<string, unknown>): Promise<IHttpRequestOptions> {
	const { context, requests } = executeContext(parameters, [emptyPage()]);
	await new Costfluent().execute.call(context);
	expect(requests).toHaveLength(1);
	return requests[0].options;
}

function checkQuery(label: string, request: IHttpRequestOptions, sentinels: Set<string>) {
	expect(request.method).toBe('GET');
	const found = apiOperation('GET', String(request.url), sentinels);
	const query = parametersIn(found, 'query');
	const declared = new Set(query.map((parameter) => field(parameter, 'name')));
	const sent = Object.keys(request.qs ?? {});
	expect(
		sent.filter((key) => !declared.has(key)),
		`${label} sends query parameters GET ${found.template} does not take`,
	).toEqual([]);
	return { found, query, sent };
}

it('action node: the operations are read from its description', () => {
	expect(operations.length).toBeGreaterThan(0);
});

it.each(operations)(
	'action node: %s %s sends a Public API operation',
	async (resource, operation) => {
		const label = `${resource} ${operation}`;

		const sentinels = new Set<string>();
		const everything = parametersFor(resource, operation, (property) =>
			sample(property, sentinels),
		);
		checkQuery(label, await send(everything), sentinels);

		// Unset fields take their default, as n8n gives a node a field the user left alone.
		const requiredSentinels = new Set<string>();
		const requiredOnly = parametersFor(resource, operation, (property) =>
			property.required === true ? sample(property, requiredSentinels) : property.default,
		);
		const { query, sent } = checkQuery(label, await send(requiredOnly), requiredSentinels);
		const missing = query
			.filter((parameter) => field(parameter, 'required') === true)
			.map((parameter) => String(field(parameter, 'name')))
			.filter((name) => !sent.includes(name));
		expect(missing, `${label} can leave out query parameters the API requires`).toEqual([]);
	},
);

it('action node: every choice of an enumerated option is a value the API takes', async () => {
	let checked = 0;
	for (const [resource, operation] of operations) {
		const sentinels = new Set<string>();
		const base = parametersFor(resource, operation, (property) => sample(property, sentinels));
		for (const collection of actionProperties.filter(
			(property) => property.type === 'collection' && property.name in base,
		)) {
			if (!isShown(collection, base)) {
				continue;
			}
			for (const option of collectionFields(collection).filter((o) => o.type === 'options')) {
				for (const value of choiceValues(option)) {
					const label = `${resource} ${operation} ${option.name}=${value}`;
					const collectionValue = base[collection.name];
					const parameters = {
						...base,
						[collection.name]: {
							...(isObject(collectionValue) ? collectionValue : {}),
							[option.name]: value,
						},
					};
					const request = await send(parameters);
					expect(request.qs?.[option.name], `${label} is not sent`).toBe(value);
					const { query } = checkQuery(label, request, sentinels);
					const parameter = query.find((candidate) => field(candidate, 'name') === option.name);
					expect(parameter, `${label}: the API takes no ${option.name}`).toBeDefined();
					expect(
						enumValues(field(parameter, 'schema')),
						`${label}: the API does not take the value ${value} for ${option.name}`,
					).toContain(value);
					checked++;
				}
			}
		}
	}
	expect(checked).toBeGreaterThan(0);
});

// A switch the user adds to the node starts at its default, so a default other than the API's
// sends the opposite of what leaving the switch out would answer, and the two totals disagree.
it('action node: every boolean option defaults to what the API does without it', async () => {
	const problems: string[] = [];
	const checked = new Set<string>();
	for (const [resource, operation] of operations) {
		const sentinels = new Set<string>();
		const base = parametersFor(resource, operation, (property) => sample(property, sentinels));
		for (const collection of actionProperties.filter(
			(property) => property.type === 'collection' && property.name in base,
		)) {
			if (!isShown(collection, base)) {
				continue;
			}
			const switches = collectionFields(collection).filter((option) => option.type === 'boolean');
			if (switches.length === 0) {
				continue;
			}
			const label = `${resource} ${operation}`;
			const request = await send(base);
			const { found, query } = checkQuery(label, request, sentinels);
			for (const option of switches) {
				expect(request.qs?.[option.name], `${label} ${option.name} is not sent`).toBe(true);
				const parameter = query.find((candidate) => field(candidate, 'name') === option.name);
				const apiDefault = field(resolve(field(parameter, 'schema')), 'default');
				if (option.default !== apiDefault) {
					problems.push(
						`${label} ${option.name} defaults to ${String(option.default)}, GET ${found.template} to ${String(apiDefault)}`,
					);
				}
				checked.add(`${resource} ${operation} ${option.name}`);
			}
		}
	}
	expect([...checked]).toEqual(
		expect.arrayContaining(['cost getData includeRefunds', 'cost getSummary includeRefunds']),
	);
	expect(problems).toEqual([]);
});

it('action node: each paginated listing answers data and links.next', async () => {
	const paged = operations.filter(([resource, operation]) =>
		actionProperties.some(
			(property) => property.name === 'returnAll' && isShown(property, { resource, operation }),
		),
	);
	expect(paged.length).toBeGreaterThan(0);
	// Every listing is checked before the assertion, so a change to the shared page shape names
	// each listing it breaks.
	const problems: string[] = [];
	for (const [resource, operation] of paged) {
		const label = `${resource} ${operation}`;
		const sentinels = new Set<string>();
		const parameters = parametersFor(resource, operation, (property) =>
			sample(property, sentinels),
		);
		const { found } = checkQuery(label, await send(parameters), sentinels);
		const answer = propertiesOf(okSchema(found, '200'));
		if (!variants(answer.data).some((variant) => variant.type === 'array')) {
			problems.push(`${label}: GET ${found.template} answers no data array`);
		}
		if (!('next' in propertiesOf(answer.links))) {
			problems.push(`${label}: GET ${found.template} answers no links.next`);
		}
	}
	expect(problems).toEqual([]);
});

// --- The trigger ------------------------------------------------------------------------------

const APP_ID = 'appId-sentinel';
const methods = new CostfluentTrigger().webhookMethods.default;

it('trigger: create, checkExists and delete send Public API operations', async () => {
	const sentinels = new Set([APP_ID]);

	// create
	const created = hookContext({
		parameters: { events: ['spend_band'] },
		responses: [{ id: APP_ID, signingSecret: 'whsec_sentinel', config: {} }],
	});
	await methods.create.call(created.context);
	expect(created.requests).toHaveLength(1);
	const createRequest = created.requests[0].options;
	const create = apiOperation(String(createRequest.method), String(createRequest.url), sentinels);
	const requestSchema = jsonSchema(create.operation.requestBody);
	const accepted = propertiesOf(requestSchema);
	const body = isObject(createRequest.body) ? createRequest.body : {};
	expect(
		Object.keys(body).filter((key) => !(key in accepted)),
		`the create body sends fields ${create.method.toUpperCase()} ${create.template} does not take`,
	).toEqual([]);
	expect(
		requiredOf(requestSchema).filter((key) => !(key in body)),
		`the create body leaves out fields ${create.template} requires`,
	).toEqual([]);
	expect(
		enumValues(accepted.key),
		`the API does not take the app key ${String(body.key)}`,
	).toContain(body.key);
	const createdAnswer = Object.keys(propertiesOf(okSchema(create, '201')));
	for (const read of ['id', 'signingSecret', 'config']) {
		expect(createdAnswer, `the create answer has no ${read}`).toContain(read);
	}

	// create, from a workflow whose name is longer than an app name may be
	const longName = hookContext({
		parameters: { events: ['spend_band'] },
		responses: [{ id: APP_ID, signingSecret: 'whsec_sentinel', config: {} }],
	});
	Object.assign(longName.context, {
		getWorkflow: () => ({ id: 'wf1', name: 'n'.repeat(250), active: false }),
	});
	await methods.create.call(longName.context);
	const sentName = field(longName.requests[0].options.body, 'name');
	const maxLength = field(resolve(accepted.name), 'maxLength');
	expect(typeof sentName).toBe('string');
	expect(typeof maxLength, 'the API states no maximum length for name').toBe('number');
	expect(
		String(sentName).length,
		`the create body sends a name of ${String(sentName).length} characters, more than the ${String(maxLength)} the API takes`,
	).toBeLessThanOrEqual(Number(maxLength));

	// checkExists
	const existing = hookContext({
		parameters: { events: ['spend_band'] },
		responses: [fullResponse(200, { id: APP_ID, config: { events: ['spend_band'] } })],
		staticData: { appId: APP_ID, signingSecret: 'whsec_sentinel' },
	});
	await expect(methods.checkExists.call(existing.context)).resolves.toBe(true);
	expect(existing.requests).toHaveLength(1);
	const read = apiOperation(
		String(existing.requests[0].options.method),
		String(existing.requests[0].options.url),
		sentinels,
	);
	expect(read.method).toBe('get');
	expect(
		Object.keys(propertiesOf(okSchema(read, '200'))),
		`GET ${read.template} answers no config`,
	).toContain('config');

	// delete
	const deleted = hookContext({
		parameters: { events: ['spend_band'] },
		responses: [fullResponse(204)],
		staticData: { appId: APP_ID, signingSecret: 'whsec_sentinel' },
	});
	await methods.delete.call(deleted.context);
	expect(deleted.requests).toHaveLength(1);
	const removal = apiOperation(
		String(deleted.requests[0].options.method),
		String(deleted.requests[0].options.url),
		sentinels,
	);
	expect(removal.method).toBe('delete');
});
