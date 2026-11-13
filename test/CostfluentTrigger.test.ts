import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CostfluentTrigger } from '../nodes/CostfluentTrigger/CostfluentTrigger.node';
import { clock } from '../nodes/CostfluentTrigger/clock';
import { fullResponse, hookContext, webhookContext } from './fakes';
import golden from './golden/delivery.json';

const SECRET = 'whsec_test_secret';
const APP_ID = 'app_AAAAAAAAAAAAAAAAAAAAAA';

const delivery = {
	event_type: 'savings_item_status',
	schema_version: 1,
	subject: 'Savings opportunity accepted',
	content: 'Rightsize the build agents was accepted.',
	html_content: '<p>Rightsize the build agents was accepted.</p>',
	timestamp: '2026-10-19T08:00:00Z',
	app_id: APP_ID,
	data: {
		opportunity_id: 'sav_AAAAAAAAAAAAAAAAAAAAAA',
		workspace_id: 'wsp_AAAAAAAAAAAAAAAAAAAAAA',
		title: 'Rightsize the build agents',
		status: 'accepted',
		previous_status: 'open',
		estimated_monthly_saving: 120.5,
		currency: 'EUR',
		changed_at: '2026-10-19T07:59:58Z',
	},
};

// What the workflow receives for a delivery that came without an X-Costfluent-Delivery header.
const emitted = { ...delivery, delivery_id: null };

function sign(body: Buffer | string, secret = SECRET): string {
	return `sha256=${createHmac('sha256', Buffer.from(secret, 'utf8')).update(body).digest('hex')}`;
}

const trigger = new CostfluentTrigger();
const methods = trigger.webhookMethods.default;

describe('webhook', () => {
	const rawBody = Buffer.from(JSON.stringify(delivery));
	const sentAt = Date.parse(delivery.timestamp);
	const minutes = (count: number) => count * 60 * 1000;
	const realNow = clock.now;

	// Each delivery is received as if at the moment Costfluent sent it, unless a case says otherwise.
	beforeEach(() => {
		clock.now = () => sentAt;
	});
	afterEach(() => {
		clock.now = realNow;
	});

	async function receive(options: {
		rawBody?: unknown;
		signature?: string;
		deliveryId?: string;
		events?: string[];
		secret?: string | null;
	}) {
		const secret = options.secret === undefined ? SECRET : options.secret;
		const headers: Record<string, string> = {};
		if (options.signature !== undefined) {
			headers['X-Costfluent-Signature'] = options.signature;
		}
		if (options.deliveryId !== undefined) {
			headers['X-Costfluent-Delivery'] = options.deliveryId;
		}
		const { context, response } = webhookContext({
			rawBody: options.rawBody ?? rawBody,
			headers,
			events: options.events ?? ['savings_item_status'],
			staticData: secret === null ? { appId: APP_ID } : { appId: APP_ID, signingSecret: secret },
		});
		const result = await trigger.webhook.call(context);
		return { result, response };
	}

	it('starts the workflow with the body of a correctly signed delivery', async () => {
		const { result, response } = await receive({ signature: sign(rawBody) });

		expect(result.workflowData).toEqual([[{ json: emitted }]]);
		expect(response.status).toBeUndefined();
	});

	it('adds the X-Costfluent-Delivery header as delivery_id beside the body fields', async () => {
		const deliveryId = 'delivery-0192a3b4c5d67e8f9a0b1c2d3e4f5a6b';
		const { result } = await receive({ signature: sign(rawBody), deliveryId });

		expect(result.workflowData).toEqual([[{ json: { ...delivery, delivery_id: deliveryId } }]]);
	});

	it.each([
		['without an X-Costfluent-Delivery header, as a channel test sends', undefined],
		['with an empty X-Costfluent-Delivery header', ''],
	])('sets delivery_id to null for a delivery %s', async (_, deliveryId) => {
		const { result } = await receive({ signature: sign(rawBody), deliveryId });

		expect(result.workflowData).toEqual([[{ json: emitted }]]);
	});

	it('verifies the raw body when n8n keeps it as a string', async () => {
		const text = rawBody.toString('utf8');
		const { result } = await receive({ rawBody: text, signature: sign(text) });

		expect(result.workflowData).toEqual([[{ json: emitted }]]);
	});

	it('accepts a signature written in upper-case hex', async () => {
		const signature = `sha256=${sign(rawBody).slice('sha256='.length).toUpperCase()}`;
		const { result } = await receive({ signature });

		expect(result.workflowData).toBeDefined();
	});

	const refused: Array<[string, Parameters<typeof receive>[0]]> = [
		[
			'a tampered body',
			{
				rawBody: Buffer.from(JSON.stringify({ ...delivery, subject: 'Something else' })),
				signature: sign(rawBody),
			},
		],
		['an unsigned delivery', {}],
		['a signature made with another secret', { signature: sign(rawBody, 'another secret') }],
		[
			'a signature without the sha256= prefix',
			{ signature: sign(rawBody).slice('sha256='.length) },
		],
		['a signature of the wrong length', { signature: sign(rawBody).slice(0, -2) }],
		['a signature that is not hex', { signature: `sha256=${'z'.repeat(64)}` }],
		['an empty signature', { signature: '' }],
		['a delivery while no secret is stored', { signature: sign(rawBody), secret: null }],
		['a delivery while the stored secret is empty', { signature: sign(rawBody, ''), secret: '' }],
		['a request without the raw body', { rawBody: { parsed: true }, signature: sign(rawBody) }],
	];

	it.each(refused)('refuses %s with 401 and does not start the workflow', async (_, options) => {
		const { result, response } = await receive(options);

		expect(result.workflowData).toBeUndefined();
		expect(result.noWebhookResponse).toBe(true);
		expect(response).toEqual({ status: 401, body: 'Unauthorized', ended: true });
	});

	it('answers 200 and does not start the workflow for an event that is not selected', async () => {
		const { result, response } = await receive({
			signature: sign(rawBody),
			events: ['anomaly_status', 'provider_health'],
		});

		expect(result.workflowData).toBeUndefined();
		expect(response).toEqual({ status: 200, body: 'Ignored', ended: true });
	});

	it('answers 200 for a signed delivery that names no event type', async () => {
		const body = Buffer.from(JSON.stringify({ ...delivery, event_type: undefined }));
		const { result, response } = await receive({ rawBody: body, signature: sign(body) });

		expect(result.workflowData).toBeUndefined();
		expect(response.status).toBe(200);
	});

	it('answers 400 for a signed body that is not a JSON object', async () => {
		const body = Buffer.from('[1,2,3]');
		const { result, response } = await receive({ rawBody: body, signature: sign(body) });

		expect(result.workflowData).toBeUndefined();
		expect(response.status).toBe(400);
	});

	describe('timestamp window', () => {
		it.each([
			['sent just now', 0],
			['sent 5 minutes ago', minutes(5)],
			['stamped 5 minutes ahead of this clock', -minutes(5)],
		])('starts the workflow for a delivery %s', async (_, offset) => {
			clock.now = () => sentAt + offset;
			const { result } = await receive({ signature: sign(rawBody) });

			expect(result.workflowData).toEqual([[{ json: emitted }]]);
		});

		it.each([
			['sent 6 minutes ago', minutes(6)],
			['stamped 6 minutes ahead of this clock', -minutes(6)],
		])('refuses a correctly signed delivery %s with 401', async (_, offset) => {
			clock.now = () => sentAt + offset;
			const { result, response } = await receive({ signature: sign(rawBody) });

			expect(result.workflowData).toBeUndefined();
			expect(response).toEqual({ status: 401, body: 'Unauthorized', ended: true });
		});

		it.each([
			['without a timestamp', undefined],
			['with a timestamp that is not a date', 'yesterday'],
			['with a timestamp without a time zone', '2026-10-19T08:00:00'],
			['with a timestamp that is not a string', 1792396800],
		])('refuses a correctly signed delivery %s with 401', async (_, timestamp) => {
			const body = Buffer.from(JSON.stringify({ ...delivery, timestamp }));
			const { result, response } = await receive({ rawBody: body, signature: sign(body) });

			expect(result.workflowData).toBeUndefined();
			expect(response).toEqual({ status: 401, body: 'Unauthorized', ended: true });
		});
	});
});

// golden/delivery.json is one delivery exactly as Costfluent's webhook sender writes it: the raw
// body it signs, the headers it sends and the secret it signs with. It is written by the sender and
// never edited by hand.
describe("the backend's golden delivery", () => {
	const rawBody = Buffer.from(golden.body, 'utf8');
	const body = JSON.parse(golden.body) as { app_id: string; timestamp: string };
	const realNow = clock.now;

	beforeEach(() => {
		clock.now = () => Date.parse(body.timestamp);
	});
	afterEach(() => {
		clock.now = realNow;
	});

	async function receive(received: Buffer) {
		const { context, response } = webhookContext({
			rawBody: received,
			headers: golden.headers,
			events: ['savings_item_status'],
			staticData: { appId: body.app_id, signingSecret: golden.secret },
		});
		const result = await trigger.webhook.call(context);
		return { result, response };
	}

	it('starts the workflow with its body and its X-Costfluent-Delivery header as delivery_id', async () => {
		const { result, response } = await receive(rawBody);

		expect(result.workflowData).toEqual([
			[{ json: { ...JSON.parse(golden.body), delivery_id: golden.headers['X-Costfluent-Delivery'] } }],
		]);
		expect(response.status).toBeUndefined();
	});

	// Without these, the golden delivery tests nothing the hand-written one above does not: a node
	// that verifies a re-serialised body, or reads only whole-second timestamps, would pass both.
	it('carries a body and a timestamp that re-serialising would change', () => {
		expect(golden.body).not.toBe(JSON.stringify(JSON.parse(golden.body)));
		expect(body.timestamp).not.toBe(new Date(body.timestamp).toISOString());
	});

	it('is refused with 401 when one byte of its body changes and its signature is kept', async () => {
		const tampered = Buffer.from(rawBody);
		// The last digit of the saving in data: 412.50 becomes 412.51.
		const index = tampered.lastIndexOf('412.50');
		expect(index).toBeGreaterThan(-1);
		tampered[index + 5] = '1'.charCodeAt(0);

		const { result, response } = await receive(tampered);

		expect(result.workflowData).toBeUndefined();
		expect(response).toEqual({ status: 401, body: 'Unauthorized', ended: true });
	});
});

describe('activation', () => {
	it('creates a webhook app subscribed to the chosen events and stores its id and secret', async () => {
		const { context, requests, staticData } = hookContext({
			parameters: { events: ['savings_item_status', 'anomaly_status'] },
			responses: [
				{
					id: APP_ID,
					key: 'webhook',
					name: 'n8n: Savings to Slack',
					config: { url: '***', events: ['savings_item_status', 'anomaly_status'] },
					isEnabled: true,
					createdAt: '2026-10-19T08:00:00Z',
					signingSecret: SECRET,
				},
			],
		});

		await expect(methods.create.call(context)).resolves.toBe(true);

		expect(requests).toHaveLength(1);
		expect(requests[0].credential).toBe('costfluentApi');
		expect(requests[0].options).toMatchObject({
			method: 'POST',
			baseURL: 'https://api.costfluent.test',
			url: '/v1/apps',
			body: {
				key: 'webhook',
				name: 'n8n: Savings to Slack',
				config: {
					url: 'https://n8n.example.com/webhook/abc/webhook',
					events: ['savings_item_status', 'anomaly_status'],
				},
			},
		});
		// No secret is sent: Costfluent generates it and returns it once.
		expect(requests[0].options.body).not.toHaveProperty('config.secret');
		expect(staticData).toEqual({ appId: APP_ID, signingSecret: SECRET });
	});

	it('deletes the app it created and fails when no signing secret comes back', async () => {
		const { context, requests, staticData } = hookContext({
			parameters: { events: ['spend_band'] },
			responses: [{ id: APP_ID, key: 'webhook', signingSecret: null }, fullResponse(204)],
		});

		await expect(methods.create.call(context)).rejects.toThrow(/signing secret/);

		expect(requests.map((r) => [r.options.method, r.options.url])).toEqual([
			['POST', '/v1/apps'],
			['DELETE', `/v1/apps/${APP_ID}`],
		]);
		expect(staticData).toEqual({});
	});

	it('subscribes to connection_imported, the first import notice', async () => {
		const events = trigger.description.properties.find((property) => property.name === 'events');
		expect(events?.options).toContainEqual(
			expect.objectContaining({ value: 'connection_imported' }),
		);

		const { context, requests, staticData } = hookContext({
			parameters: { events: ['connection_imported'] },
			responses: [{ id: APP_ID, key: 'webhook', signingSecret: SECRET }],
		});

		await expect(methods.create.call(context)).resolves.toBe(true);

		expect(requests).toHaveLength(1);
		expect(requests[0].options).toMatchObject({
			method: 'POST',
			url: '/v1/apps',
			body: { key: 'webhook', config: { events: ['connection_imported'] } },
		});
		expect(staticData).toEqual({ appId: APP_ID, signingSecret: SECRET });
	});

	it('refuses to activate without an event', async () => {
		const { context, requests } = hookContext({ parameters: { events: [] }, responses: [] });

		await expect(methods.create.call(context)).rejects.toThrow(/at least one event/);
		expect(requests).toHaveLength(0);
	});

	it('refuses to activate when n8n has no webhook URL for the trigger', async () => {
		const { context, requests, staticData } = hookContext({
			parameters: { events: ['spend_band'] },
			responses: [{ id: APP_ID, key: 'webhook', signingSecret: SECRET }],
			webhookUrl: '',
		});

		await expect(methods.create.call(context)).rejects.toThrow(/no webhook URL/);
		expect(requests).toHaveLength(0);
		expect(staticData).toEqual({});
	});

	it('cuts the channel name to the 200 characters the API accepts', async () => {
		const workflowName = `${'a'.repeat(250)}${'z'.repeat(50)}`;
		const { context, requests } = hookContext({
			parameters: { events: ['spend_band'] },
			responses: [{ id: APP_ID, key: 'webhook', signingSecret: SECRET }],
			workflow: { id: 'wf1', name: workflowName, active: false },
		});

		await expect(methods.create.call(context)).resolves.toBe(true);

		const { name } = requests[0].options.body as { name: string };
		expect(name).toHaveLength(200);
		expect(name).toBe(`n8n: ${'a'.repeat(195)}`);
	});

	it.each([
		['the workflow id when the workflow has no name', { id: 'wf1', active: false }, 'n8n: wf1'],
		['"workflow" when the workflow has neither name nor id', { active: false }, 'n8n: workflow'],
	])('names the channel after %s', async (_, workflow, expected) => {
		const { context, requests } = hookContext({
			parameters: { events: ['spend_band'] },
			responses: [{ id: APP_ID, key: 'webhook', signingSecret: SECRET }],
			workflow,
		});

		await expect(methods.create.call(context)).resolves.toBe(true);

		expect(requests[0].options.body).toMatchObject({ name: expected });
	});

	// Without a stored id, deactivation could never delete the channel, which would keep posting to
	// a URL nothing listens on.
	it.each([
		['no id', { key: 'webhook', signingSecret: SECRET }],
		['an empty id', { id: '', key: 'webhook', signingSecret: SECRET }],
	])('fails and stores nothing when the new channel comes back with %s', async (_, answer) => {
		const { context, requests, staticData } = hookContext({
			parameters: { events: ['spend_band'] },
			responses: [answer],
		});

		await expect(methods.create.call(context)).rejects.toThrow(
			/did not return the new webhook channel/,
		);
		expect(requests.map((r) => [r.options.method, r.options.url])).toEqual([['POST', '/v1/apps']]);
		expect(staticData).toEqual({});
	});

	it('reports an app it has never created as missing without calling the API', async () => {
		const { context, requests } = hookContext({
			parameters: { events: ['spend_band'] },
			responses: [],
		});

		await expect(methods.checkExists.call(context)).resolves.toBe(false);
		expect(requests).toHaveLength(0);
	});

	// The channel as GET /v1/apps/{appId} reads it back: the URL redacted, the secret never returned.
	const storedApp = (events?: string[]) =>
		fullResponse(200, {
			id: APP_ID,
			key: 'webhook',
			name: 'n8n: Savings to Slack',
			config: events === undefined ? { url: '***' } : { url: '***', events },
			isEnabled: true,
			createdAt: '2026-10-19T08:00:00Z',
		});

	it('keeps a stored app subscribed to the selected events, in any order', async () => {
		const { context, requests, staticData } = hookContext({
			parameters: { events: ['spend_band', 'anomaly_status'] },
			responses: [storedApp(['anomaly_status', 'spend_band'])],
			staticData: { appId: APP_ID, signingSecret: SECRET },
		});

		await expect(methods.checkExists.call(context)).resolves.toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0].options).toMatchObject({ method: 'GET', url: `/v1/apps/${APP_ID}` });
		expect(staticData).toEqual({ appId: APP_ID, signingSecret: SECRET });
	});

	it('replaces a stored app when the selected events changed', async () => {
		const newApp = 'app_BBBBBBBBBBBBBBBBBBBBBB';
		const { context, requests, staticData } = hookContext({
			parameters: { events: ['spend_band', 'provider_health'] },
			responses: [
				storedApp(['spend_band', 'anomaly_status']),
				fullResponse(204),
				{ id: newApp, key: 'webhook', signingSecret: 'whsec_new' },
			],
			staticData: { appId: APP_ID, signingSecret: SECRET },
		});

		// n8n calls create when checkExists answers false.
		await expect(methods.checkExists.call(context)).resolves.toBe(false);
		await expect(methods.create.call(context)).resolves.toBe(true);

		expect(requests.map((r) => [r.options.method, r.options.url])).toEqual([
			['GET', `/v1/apps/${APP_ID}`],
			['DELETE', `/v1/apps/${APP_ID}`],
			['POST', '/v1/apps'],
		]);
		expect(requests[2].options.body).toMatchObject({
			config: { events: ['spend_band', 'provider_health'] },
		});
		expect(staticData).toEqual({ appId: newApp, signingSecret: 'whsec_new' });
	});

	it.each([
		['subscribes to no events', undefined],
		['subscribes to more events', ['spend_band', 'anomaly_status']],
		['subscribes to fewer events', []],
	])('replaces a stored app whose read-back %s', async (_, events) => {
		const { context, requests, staticData } = hookContext({
			parameters: { events: ['spend_band'] },
			responses: [storedApp(events), fullResponse(204)],
			staticData: { appId: APP_ID, signingSecret: SECRET },
		});

		await expect(methods.checkExists.call(context)).resolves.toBe(false);
		expect(requests.map((r) => r.options.method)).toEqual(['GET', 'DELETE']);
		expect(staticData).toEqual({});
	});

	it('forgets a stored app that was deleted in Costfluent', async () => {
		const { context, staticData } = hookContext({
			parameters: { events: ['spend_band'] },
			responses: [fullResponse(404, { title: 'Not found' })],
			staticData: { appId: APP_ID, signingSecret: SECRET },
		});

		await expect(methods.checkExists.call(context)).resolves.toBe(false);
		expect(staticData).toEqual({});
	});

	it('replaces a stored app whose secret was lost', async () => {
		const { context, requests, staticData } = hookContext({
			parameters: { events: ['spend_band'] },
			responses: [storedApp(['spend_band']), fullResponse(204)],
			staticData: { appId: APP_ID },
		});

		await expect(methods.checkExists.call(context)).resolves.toBe(false);
		expect(requests.map((r) => r.options.method)).toEqual(['GET', 'DELETE']);
		expect(staticData).toEqual({});
	});

	describe('a create whose answer is lost', () => {
		const idempotencyKey = (request: { options: { headers?: unknown } }) =>
			(request.options.headers as Record<string, unknown> | undefined)?.['Idempotency-Key'];
		const created = { id: APP_ID, key: 'webhook', config: { events: ['spend_band'] } };
		// What n8n raises when no answer came back, and when a proxy answered for the API.
		const lost: Array<[string, () => Error]> = [
			[
				'a reset connection',
				() => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
			],
			[
				'a timeout',
				() => Object.assign(new Error('timeout of 60000ms exceeded'), { code: 'ECONNABORTED' }),
			],
			...[502, 503, 504].map((status): [string, () => Error] => [
				`a ${status}`,
				() =>
					Object.assign(new Error(`Request failed with status code ${status}`), {
						httpCode: String(status),
					}),
			]),
		];

		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		// Runs the hook to its end, letting every backoff pass at once.
		async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
			const settled = Promise.allSettled([promise]);
			await vi.runAllTimersAsync();
			return (await settled)[0];
		}

		it('sends an Idempotency-Key with the channel create', async () => {
			const { context, requests } = hookContext({
				parameters: { events: ['spend_band'] },
				responses: [{ ...created, signingSecret: SECRET }],
			});

			await expect(methods.create.call(context)).resolves.toBe(true);

			expect(requests).toHaveLength(1);
			expect(idempotencyKey(requests[0])).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
		});

		it.each(lost)(
			'resends a create whose answer was lost to %s under the same key and deletes the replayed channel',
			async (_, failure) => {
				// The replay of a create the API already made names the channel without its secret.
				const { context, requests, staticData } = hookContext({
					parameters: { events: ['spend_band'] },
					responses: [failure(), created, fullResponse(204)],
				});

				const result = await settle(methods.create.call(context));

				expect(result.status).toBe('rejected');
				expect((result as PromiseRejectedResult).reason.message).toMatch(/signing secret/);
				expect(requests.map((r) => [r.options.method, r.options.url])).toEqual([
					['POST', '/v1/apps'],
					['POST', '/v1/apps'],
					['DELETE', `/v1/apps/${APP_ID}`],
				]);
				expect(idempotencyKey(requests[1])).toBe(idempotencyKey(requests[0]));
				expect(requests[1].options.body).toEqual(requests[0].options.body);
				expect(staticData).toEqual({});
			},
		);

		it('stores the channel a resend creates when the first attempt never reached the API', async () => {
			const { context, requests, staticData } = hookContext({
				parameters: { events: ['spend_band'] },
				responses: [lost[0][1](), { ...created, signingSecret: SECRET }],
			});

			const result = await settle(methods.create.call(context));

			expect(result).toEqual({ status: 'fulfilled', value: true });
			expect(requests).toHaveLength(2);
			expect(staticData).toEqual({ appId: APP_ID, signingSecret: SECRET });
		});

		it('gives up after three resends and stores nothing', async () => {
			const { context, requests, staticData } = hookContext({
				parameters: { events: ['spend_band'] },
				responses: lost.slice(0, 4).map(([, failure]) => failure()),
			});

			const result = await settle(methods.create.call(context));

			expect(result.status).toBe('rejected');
			expect(requests).toHaveLength(4);
			expect(new Set(requests.map(idempotencyKey)).size).toBe(1);
			expect(staticData).toEqual({});
		});

		it.each([400, 409, 500])('does not resend a create the API refused with %s', async (status) => {
			const { context, requests, staticData } = hookContext({
				parameters: { events: ['spend_band'] },
				responses: [
					Object.assign(new Error(`Request failed with status code ${status}`), {
						httpCode: String(status),
					}),
					{ ...created, signingSecret: SECRET },
				],
			});

			const result = await settle(methods.create.call(context));

			expect(result.status).toBe('rejected');
			expect(requests).toHaveLength(1);
			expect(staticData).toEqual({});
		});

		it('uses a fresh key for each activation', async () => {
			const first = hookContext({
				parameters: { events: ['spend_band'] },
				responses: [{ ...created, signingSecret: SECRET }],
			});
			const second = hookContext({
				parameters: { events: ['spend_band'] },
				responses: [{ ...created, signingSecret: SECRET }],
			});

			await methods.create.call(first.context);
			await methods.create.call(second.context);

			expect(idempotencyKey(first.requests[0])).toEqual(expect.any(String));
			expect(idempotencyKey(second.requests[0])).not.toBe(idempotencyKey(first.requests[0]));
		});
	});
});

describe('deactivation', () => {
	it('deletes the app and forgets its id and secret', async () => {
		const { context, requests, staticData } = hookContext({
			parameters: { events: ['spend_band'] },
			responses: [fullResponse(204)],
			staticData: { appId: APP_ID, signingSecret: SECRET },
		});

		await expect(methods.delete.call(context)).resolves.toBe(true);

		expect(requests).toHaveLength(1);
		expect(requests[0].credential).toBe('costfluentApi');
		expect(requests[0].options).toMatchObject({
			method: 'DELETE',
			baseURL: 'https://api.costfluent.test',
			url: `/v1/apps/${APP_ID}`,
		});
		expect(staticData).toEqual({});
	});

	it('treats an app that is already gone as deleted', async () => {
		const { context, staticData } = hookContext({
			parameters: { events: ['spend_band'] },
			responses: [fullResponse(404, { title: 'Not found' })],
			staticData: { appId: APP_ID, signingSecret: SECRET },
		});

		await expect(methods.delete.call(context)).resolves.toBe(true);
		expect(staticData).toEqual({});
	});

	it('fails and keeps the app id when the API refuses the delete', async () => {
		const { context, staticData } = hookContext({
			parameters: { events: ['spend_band'] },
			responses: [fullResponse(403, { title: 'Forbidden' })],
			staticData: { appId: APP_ID, signingSecret: SECRET },
		});

		await expect(methods.delete.call(context)).rejects.toThrow();
		expect(staticData).toEqual({ appId: APP_ID, signingSecret: SECRET });
	});

	it('has nothing to delete when no app was created', async () => {
		const { context, requests } = hookContext({ parameters: { events: [] }, responses: [] });

		await expect(methods.delete.call(context)).resolves.toBe(true);
		expect(requests).toHaveLength(0);
	});
});
