import type { INodeTypes } from 'n8n-workflow';
import { Workflow } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { CostfluentApi } from '../credentials/CostfluentApi.credentials';

// n8n resolves the credential's expressions itself, for the credential test as for every request,
// so they are evaluated here with n8n's own expression engine.
const nodeTypes = {
	getByName: () => ({}),
	getByNameAndVersion: () => ({ description: { properties: [] } }),
	getKnownTypes: () => ({}),
} as unknown as INodeTypes;
const workflow = new Workflow({
	nodes: [{ id: 'n', name: 'n', type: 'n', typeVersion: 1, position: [0, 0], parameters: {} }],
	connections: {},
	active: false,
	nodeTypes,
});

function resolve(expression: unknown, baseUrl: string): unknown {
	return workflow.expression.getParameterValue(
		expression as string,
		null,
		0,
		0,
		'n',
		[],
		'internal',
		{ $credentials: { apiToken: 'cf_org_test', baseUrl } },
	);
}

const credential = new CostfluentApi();
const authorization = credential.authenticate.properties.headers?.Authorization;

describe('credential', () => {
	it.each([
		['https://api.costfluent.com', 'https://api.costfluent.com'],
		['', 'https://api.costfluent.com'],
		[' https://api.costfluent.com ', 'https://api.costfluent.com'],
		['http://localhost:5080', 'http://localhost:5080'],
	])('tests the base URL "%s" as %s', (baseUrl, expected) => {
		expect(resolve(credential.test.request.baseURL, baseUrl)).toBe(expected);
	});

	it.each([
		'https://api.costfluent.com',
		'HTTPS://api.costfluent.com',
		'',
		'http://localhost',
		'http://localhost:5080/',
		'http://127.0.0.1:5080',
		'http://[::1]:5080',
	])('sends the token to %s', (baseUrl) => {
		expect(resolve(authorization, baseUrl)).toBe('Bearer cf_org_test');
	});

	it.each([
		'http://api.costfluent.com',
		'http://localhost.example.com',
		'http://127.0.0.1.example.com',
		'ftp://api.costfluent.com',
		'api.costfluent.com',
	])('sends no token to %s, so its credential test fails', (baseUrl) => {
		expect(resolve(authorization, baseUrl)).toBe('');
	});
});
