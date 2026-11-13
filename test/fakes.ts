import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestOptions,
	INode,
	IWebhookFunctions,
} from 'n8n-workflow';

// Hand-made stand-ins for the `this` n8n passes to a node's methods: only what the nodes call, with
// every outgoing request recorded and answered from a queue.

export const CREDENTIALS = { apiToken: 'cf_org_test', baseUrl: 'https://api.costfluent.test/' };

export interface RecordedRequest {
	credential: string;
	options: IHttpRequestOptions;
}

const node: INode = {
	id: 'node-id',
	name: 'Costfluent',
	type: 'n8n-nodes-costfluent.costfluent',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

function parameterReader(parameters: Record<string, unknown>) {
	return (name: string, ...rest: unknown[]) => {
		if (name in parameters) {
			return parameters[name];
		}
		// getNodeParameter(name, fallback) on hooks and webhooks, (name, itemIndex, fallback) on execute.
		const fallback =
			rest.length >= 2
				? rest[1]
				: rest.length === 1 && typeof rest[0] !== 'number'
					? rest[0]
					: undefined;
		if (fallback !== undefined) {
			return fallback;
		}
		throw new Error(`Could not get parameter "${name}"`);
	};
}

function requester(responses: unknown[], requests: RecordedRequest[]) {
	return async (credential: string, options: IHttpRequestOptions) => {
		requests.push({ credential, options: structuredClone(options) });
		if (responses.length === 0) {
			throw new Error(`No response queued for ${options.method} ${options.url}`);
		}
		const response = responses.shift();
		if (response instanceof Error) {
			throw response;
		}
		return response;
	};
}

/** One parameter map runs the node on one input item; a list runs it on one item per map. */
export function executeContext(
	parameters: Record<string, unknown> | Array<Record<string, unknown>>,
	responses: unknown[],
	credentials: IDataObject = CREDENTIALS,
) {
	const requests: RecordedRequest[] = [];
	const readers = (Array.isArray(parameters) ? parameters : [parameters]).map(parameterReader);
	const context = {
		getInputData: () => readers.map(() => ({ json: {} })),
		getNodeParameter: (name: string, itemIndex: number, ...rest: unknown[]) => {
			const read = readers[itemIndex];
			if (read === undefined) {
				throw new Error(`No input item ${itemIndex} for parameter "${name}"`);
			}
			return read(name, itemIndex, ...rest);
		},
		getNode: () => node,
		getCredentials: async () => credentials,
		continueOnFail: () => false,
		helpers: { httpRequestWithAuthentication: requester(responses, requests) },
	};
	return { context: context as unknown as IExecuteFunctions, requests, responses };
}

export function hookContext(options: {
	parameters: Record<string, unknown>;
	responses: unknown[];
	staticData?: IDataObject;
	webhookUrl?: string;
	workflow?: { id?: string; name?: string; active: boolean };
}) {
	const requests: RecordedRequest[] = [];
	const staticData = options.staticData ?? {};
	const workflow = options.workflow ?? { id: 'wf1', name: 'Savings to Slack', active: false };
	const context = {
		getNodeParameter: parameterReader(options.parameters),
		getNode: () => node,
		getCredentials: async () => CREDENTIALS,
		getWorkflowStaticData: () => staticData,
		getNodeWebhookUrl: () => options.webhookUrl ?? 'https://n8n.example.com/webhook/abc/webhook',
		getWorkflow: () => workflow,
		helpers: { httpRequestWithAuthentication: requester(options.responses, requests) },
	};
	return { context: context as unknown as IHookFunctions, requests, staticData };
}

export interface RecordedResponse {
	status?: number;
	body?: unknown;
	ended: boolean;
}

export function webhookContext(options: {
	rawBody: unknown;
	headers?: Record<string, string>;
	events: string[];
	staticData?: IDataObject;
}) {
	const response: RecordedResponse = { ended: false };
	const res = {
		status(code: number) {
			response.status = code;
			return res;
		},
		send(body: unknown) {
			response.body = body;
			return res;
		},
		end() {
			response.ended = true;
			return res;
		},
	};
	const headers = Object.fromEntries(
		Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
	);
	const req = {
		rawBody: options.rawBody,
		header: (name: string) => headers[name.toLowerCase()],
	};
	const context = {
		getRequestObject: () => req,
		getResponseObject: () => res,
		getWorkflowStaticData: () => options.staticData ?? {},
		getNodeParameter: parameterReader({ events: options.events }),
		getNode: () => node,
		helpers: {
			returnJsonArray: (data: IDataObject) => [{ json: data }],
		},
	};
	return { context: context as unknown as IWebhookFunctions, response };
}

/** A full response, as httpRequestWithAuthentication answers with returnFullResponse. */
export function fullResponse(statusCode: number, body: unknown = '') {
	return { statusCode, body, headers: {} };
}
