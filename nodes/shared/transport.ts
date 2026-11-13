import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	IN8nHttpFullResponse,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

export const CREDENTIAL_NAME = 'costfluentApi';

export const DEFAULT_BASE_URL = 'https://api.costfluent.com';

// A cost query over a long range can take tens of seconds; past this the request is abandoned
// rather than holding the workflow open.
const REQUEST_TIMEOUT_MS = 60_000;

type Context = IExecuteFunctions | IHookFunctions;

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// Every request carries the API token, so it goes only over https, or plain http to this machine.
async function baseUrl(this: Context): Promise<string> {
	const credentials = await this.getCredentials(CREDENTIAL_NAME);
	const configured = typeof credentials.baseUrl === 'string' ? credentials.baseUrl.trim() : '';
	const value = (configured === '' ? DEFAULT_BASE_URL : configured).replace(/\/+$/, '');
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new NodeOperationError(
			this.getNode(),
			`The Costfluent base URL "${value}" is not a URL`,
			{
				description: (error as Error).message,
			},
		);
	}
	if (
		url.protocol !== 'https:' &&
		!(url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname))
	) {
		throw new NodeOperationError(
			this.getNode(),
			`The Costfluent base URL must use https, got "${value}"`,
		);
	}
	return value;
}

async function requestOptions(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	qs: IDataObject,
	body: IDataObject | undefined,
	headers?: IDataObject,
): Promise<IHttpRequestOptions> {
	const options: IHttpRequestOptions = {
		method,
		baseURL: await baseUrl.call(this),
		url: path,
		qs,
		json: true,
		// The API reads a list parameter such as groupBy as one repeated key per value.
		arrayFormat: 'repeat',
		timeout: REQUEST_TIMEOUT_MS,
	};
	if (body !== undefined) {
		options.body = body;
	}
	if (headers !== undefined) {
		options.headers = headers;
	}
	return options;
}

/** Sends one authenticated request and answers its parsed JSON body. */
export async function costfluentApiRequest(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	qs: IDataObject = {},
	body?: IDataObject,
	headers?: IDataObject,
): Promise<IDataObject> {
	const options = await requestOptions.call(this, method, path, qs, body, headers);
	try {
		return (await this.helpers.httpRequestWithAuthentication.call(
			this,
			CREDENTIAL_NAME,
			options,
		)) as IDataObject;
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}

/**
 * Sends one authenticated request and answers undefined when the API answers 404, so a caller can
 * treat a resource that is already gone as gone. Any other error status fails.
 */
export async function costfluentApiRequestUnlessNotFound(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
): Promise<IDataObject | undefined> {
	const options = await requestOptions.call(this, method, path, {}, body);
	options.returnFullResponse = true;
	options.ignoreHttpStatusErrors = true;
	let response: IN8nHttpFullResponse;
	try {
		response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			CREDENTIAL_NAME,
			options,
		)) as IN8nHttpFullResponse;
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
	if (response.statusCode === 404) {
		return undefined;
	}
	const responseBody =
		response.body !== null && typeof response.body === 'object' && !Buffer.isBuffer(response.body)
			? (response.body as JsonObject)
			: {};
	if (response.statusCode >= 400) {
		throw new NodeApiError(this.getNode(), responseBody, {
			httpCode: String(response.statusCode),
		});
	}
	return responseBody as IDataObject;
}

/**
 * The query of a page link. The next page is requested from the same path on the configured base
 * URL with this query, never from the link's own host, so the token only ever goes to the address
 * the credential names.
 */
export function queryFromLink(link: string): IDataObject {
	const url = new URL(link, 'https://link.invalid');
	const qs: IDataObject = {};
	for (const key of new Set(url.searchParams.keys())) {
		const values = url.searchParams.getAll(key);
		qs[key] = values.length === 1 ? values[0] : values;
	}
	return qs;
}

export interface PageOptions {
	/** The largest page the endpoint serves. */
	maxPageSize: number;
	/** Stop after this many items; undefined reads every page. */
	limit?: number;
	/**
	 * Sends the first page's meta.dataVersion with every later page and reads again from the first
	 * page when the API refuses one. Only GET /v1/costs takes a dataVersion.
	 */
	pinDataVersion?: boolean;
}

// How many times a pinned read starts again from the first page before it gives up.
const MAX_PINNED_READS = 3;

// The API answers 409 with this code to a page whose dataVersion a sync has since replaced.
function isDataVersionConflict(error: unknown): boolean {
	if (!(error instanceof NodeApiError) || error.httpCode !== '409') {
		return false;
	}
	const problem = error.context.data as IDataObject | undefined;
	return problem?.code === 'conflict';
}

/**
 * Reads a paginated listing by following links.next until it is null or the limit is reached.
 * With pinDataVersion it answers rows from one state of the data or fails.
 */
export async function costfluentApiRequestAllItems(
	this: IExecuteFunctions,
	path: string,
	qs: IDataObject,
	options: PageOptions,
): Promise<IDataObject[]> {
	if (options.pinDataVersion !== true) {
		return await readPages.call(this, path, qs, options);
	}
	// A cost page read without the first page's version comes from whatever is committed when it is
	// requested, so a sync landing between two pages repeats or drops rows. With the version the API
	// answers such a page 409 instead, which means the read starts again from the first page.
	for (let read = 1; ; read++) {
		try {
			return await readPages.call(this, path, qs, options);
		} catch (error) {
			if (!isDataVersionConflict(error)) {
				throw error instanceof NodeOperationError
					? error
					: new NodeApiError(this.getNode(), error as JsonObject);
			}
			if (read >= MAX_PINNED_READS) {
				throw new NodeOperationError(
					this.getNode(),
					`The Costfluent cost data kept changing while ${path} was read: a provider sync landed during each of ${MAX_PINNED_READS} reads`,
					{ description: 'Run the node again once the sync has finished.' },
				);
			}
		}
	}
}

async function readPages(
	this: IExecuteFunctions,
	path: string,
	qs: IDataObject,
	{ maxPageSize, limit, pinDataVersion }: PageOptions,
): Promise<IDataObject[]> {
	const items: IDataObject[] = [];
	const seen = new Set<string>();
	let dataVersion: string | undefined;
	let query: IDataObject = {
		...qs,
		limit: limit === undefined ? maxPageSize : Math.min(limit, maxPageSize),
	};
	for (;;) {
		const page = await costfluentApiRequest.call(this, 'GET', path, query);
		// Only the first page's version pins the read; no link has been followed before it.
		if (pinDataVersion === true && seen.size === 0) {
			const meta = page.meta as IDataObject | undefined;
			if (typeof meta?.dataVersion === 'string' && meta.dataVersion !== '') {
				dataVersion = meta.dataVersion;
			}
		}
		const data = Array.isArray(page.data) ? (page.data as IDataObject[]) : [];
		items.push(...data);
		if (limit !== undefined && items.length >= limit) {
			return items.slice(0, limit);
		}
		const links = page.links as IDataObject | undefined;
		const next = links?.next;
		if (typeof next !== 'string' || next === '' || data.length === 0) {
			return items;
		}
		if (seen.has(next)) {
			throw new NodeOperationError(
				this.getNode(),
				`The Costfluent API returned the page ${next} twice while listing ${path}`,
			);
		}
		seen.add(next);
		query = queryFromLink(next);
		if (dataVersion !== undefined) {
			query.dataVersion = dataVersion;
		}
	}
}
