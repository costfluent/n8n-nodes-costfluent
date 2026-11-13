import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { randomUUID } from 'crypto';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

import {
	CREDENTIAL_NAME,
	costfluentApiRequest,
	costfluentApiRequestUnlessNotFound,
} from '../shared/transport';
import { clock } from './clock';
import { isValidSignature } from './signature';

const SIGNATURE_HEADER = 'x-costfluent-signature';

// The same on every attempt at one notification, so a workflow can drop a retried delivery. A
// channel test sends none.
const DELIVERY_HEADER = 'x-costfluent-delivery';

// The signature covers the body's timestamp, the time Costfluent sent this attempt. A delivery sent
// further from now than this is refused, so a recorded delivery cannot be replayed later; a retry
// carries a new timestamp, so it is not affected.
const MAX_DELIVERY_SKEW_MS = 5 * 60 * 1000;

// An instant with an explicit zone: one without would be read in this host's local time.
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// The app name the API accepts is at most 200 characters.
const MAX_APP_NAME_LENGTH = 200;

// A channel create whose answer was lost is resent this many times, after 1, 2 and 4 seconds, as
// the SDKs resend theirs.
const MAX_CREATE_RESENDS = 3;
const CREATE_RESEND_BASE_DELAY_MS = 1_000;

// Statuses a proxy answers for an API it could not reach or that did not answer in time: the create
// may or may not have run.
const LOST_ANSWER_STATUSES = ['502', '503', '504'];

// Whether a request failed with no answer from the API: no HTTP status at all (a reset connection,
// a timeout), or a gateway's status. Any other status is the API's own final answer.
function answerWasLost(error: unknown): boolean {
	if (!(error instanceof NodeApiError)) {
		return false;
	}
	const status = error.httpCode ?? '';
	return !/^\d{3}$/.test(status) || LOST_ANSWER_STATUSES.includes(status);
}

function appPath(appId: string): string {
	return `/v1/apps/${encodeURIComponent(appId)}`;
}

function forget(data: IDataObject): void {
	delete data.appId;
	delete data.signingSecret;
}

// Whether the channel as the API reads it back subscribes to exactly these events, in any order.
function subscribesExactly(app: IDataObject, events: string[]): boolean {
	const config = app.config as IDataObject | undefined;
	const subscribed = config?.events;
	if (!Array.isArray(subscribed)) {
		return false;
	}
	const stored = new Set(subscribed);
	const wanted = new Set(events);
	return stored.size === wanted.size && [...wanted].every((event) => stored.has(event));
}

// n8n keeps the request body as received in rawBody, a Buffer, or a string on some versions. Only
// those bytes are what Costfluent signed; a re-serialised body is not, so anything else is refused.
function rawBodyOf(rawBody: unknown): Buffer | undefined {
	if (Buffer.isBuffer(rawBody)) {
		return rawBody;
	}
	if (typeof rawBody === 'string') {
		return Buffer.from(rawBody, 'utf8');
	}
	return undefined;
}

function parseBody(rawBody: Buffer): IDataObject | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody.toString('utf8'));
	} catch {
		return undefined;
	}
	return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
		? (parsed as IDataObject)
		: undefined;
}

function isFresh(timestamp: unknown, now: number): boolean {
	if (typeof timestamp !== 'string' || !INSTANT_PATTERN.test(timestamp)) {
		return false;
	}
	const sent = Date.parse(timestamp);
	return Number.isFinite(sent) && Math.abs(now - sent) <= MAX_DELIVERY_SKEW_MS;
}

// Answers the delivery without starting the workflow.
function respond(
	context: IWebhookFunctions,
	status: number,
	message: string,
): IWebhookResponseData {
	context.getResponseObject().status(status).send(message).end();
	return { noWebhookResponse: true };
}

export class CostfluentTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Costfluent Trigger',
		name: 'costfluentTrigger',
		icon: { light: 'file:../../icons/costfluent.svg', dark: 'file:../../icons/costfluent.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when Costfluent sends a subscribed state change',
		defaults: {
			name: 'Costfluent Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: CREDENTIAL_NAME,
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					'Costfluent sends events only to a public HTTPS address, so this n8n instance must be reachable on one. The credential needs an organization token that may create, view and delete notification channels.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: [],
				description: 'The state changes that start the workflow',
				options: [
					{
						name: 'Anomaly Status',
						value: 'anomaly_status',
						description: 'A cost anomaly is acknowledged, archived, ignored or reopened',
					},
					{
						name: 'Connection Imported',
						value: 'connection_imported',
						description: "A new provider connection's first import finishes",
					},
					{
						name: 'Provider Health',
						value: 'provider_health',
						description:
							'A provider connection changes health or sync outcome, or is disabled or enabled',
					},
					{
						name: 'Savings Item Status',
						value: 'savings_item_status',
						description:
							'A savings opportunity is accepted, implemented, verified, rejected, withdrawn or reopened',
					},
					{
						name: 'Spend Band',
						value: 'spend_band',
						description: "Tracked spend moves the organization toward another plan's band",
					},
					{
						name: 'Subscription Status',
						value: 'subscription_status',
						description: 'The plan or the subscription status changes',
					},
				],
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				if (typeof data.appId !== 'string') {
					return false;
				}
				const app = await costfluentApiRequestUnlessNotFound.call(this, 'GET', appPath(data.appId));
				if (app === undefined) {
					forget(data);
					return false;
				}
				// A channel whose secret was lost signs deliveries nothing here can verify, and one
				// subscribed to other events than the node now selects would keep sending the old set,
				// so either is replaced rather than kept.
				const selected = this.getNodeParameter('events', []) as string[];
				if (
					typeof data.signingSecret !== 'string' ||
					data.signingSecret === '' ||
					!subscribesExactly(app, selected)
				) {
					await costfluentApiRequestUnlessNotFound.call(this, 'DELETE', appPath(data.appId));
					forget(data);
					return false;
				}
				return true;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const url = this.getNodeWebhookUrl('default');
				if (url === undefined || url === '') {
					throw new NodeOperationError(this.getNode(), 'n8n has no webhook URL for this trigger');
				}
				const events = this.getNodeParameter('events', []) as string[];
				if (events.length === 0) {
					throw new NodeOperationError(this.getNode(), 'Choose at least one event');
				}
				const workflow = this.getWorkflow();
				const name = `n8n: ${workflow.name ?? workflow.id ?? 'workflow'}`.slice(
					0,
					MAX_APP_NAME_LENGTH,
				);

				// No secret is sent, so Costfluent generates one and returns it in this answer only.
				const body = { key: 'webhook', name, config: { url, events } };
				// A create whose answer was lost may have made the channel, and only a resend under the
				// same key names it, answered without its secret, which is why the branch below deletes
				// it. Without the key the channel would be orphaned, delivering to this URL signed with a
				// secret n8n never saw.
				const headers = { 'Idempotency-Key': randomUUID() };
				let app: IDataObject;
				for (let resend = 0; ; resend++) {
					try {
						app = await costfluentApiRequest.call(this, 'POST', '/v1/apps', {}, body, headers);
						break;
					} catch (error) {
						if (resend >= MAX_CREATE_RESENDS || !answerWasLost(error)) {
							throw error instanceof NodeOperationError
								? error
								: new NodeApiError(this.getNode(), error as JsonObject);
						}
						await sleep(CREATE_RESEND_BASE_DELAY_MS * 2 ** resend);
					}
				}

				if (typeof app.id !== 'string' || app.id === '') {
					throw new NodeOperationError(
						this.getNode(),
						'Costfluent did not return the new webhook channel',
					);
				}
				if (typeof app.signingSecret !== 'string' || app.signingSecret === '') {
					await costfluentApiRequestUnlessNotFound.call(this, 'DELETE', appPath(app.id));
					throw new NodeOperationError(
						this.getNode(),
						'Costfluent did not return the signing secret of the new webhook channel',
					);
				}

				const data = this.getWorkflowStaticData('node');
				data.appId = app.id;
				data.signingSecret = app.signingSecret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				if (typeof data.appId === 'string') {
					// A channel someone already deleted in Costfluent answers 404, which is the outcome
					// wanted here.
					await costfluentApiRequestUnlessNotFound.call(this, 'DELETE', appPath(data.appId));
				}
				forget(data);
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const secret = this.getWorkflowStaticData('node').signingSecret;
		const rawBody = rawBodyOf(req.rawBody);
		if (
			typeof secret !== 'string' ||
			secret === '' ||
			rawBody === undefined ||
			!isValidSignature(rawBody, req.header(SIGNATURE_HEADER), secret)
		) {
			return respond(this, 401, 'Unauthorized');
		}

		const body = parseBody(rawBody);
		if (body === undefined) {
			return respond(this, 400, 'Bad Request');
		}
		if (!isFresh(body.timestamp, clock.now())) {
			return respond(this, 401, 'Unauthorized');
		}

		const events = this.getNodeParameter('events', []) as string[];
		if (typeof body.event_type !== 'string' || !events.includes(body.event_type)) {
			return respond(this, 200, 'Ignored');
		}

		const deliveryId = req.header(DELIVERY_HEADER);
		return {
			workflowData: [
				this.helpers.returnJsonArray({
					...body,
					delivery_id: typeof deliveryId === 'string' && deliveryId !== '' ? deliveryId : null,
				}),
			],
		};
	}
}
