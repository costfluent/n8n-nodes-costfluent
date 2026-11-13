import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	CREDENTIAL_NAME,
	costfluentApiRequest,
	costfluentApiRequestAllItems,
} from '../shared/transport';
import { costfluentProperties } from './descriptions';

// The largest page each kind of listing serves: cost rows come 5,000 at a time, everything else 100.
const LIST_PAGE_SIZE = 100;
const COST_ROW_PAGE_SIZE = 5000;

interface Request {
	path: string;
	qs: IDataObject;
	/** The largest page of a paginated listing; undefined for a single object. */
	maxPageSize?: number;
	/** Whether every later page is pinned to the first page's dataVersion. */
	pinDataVersion?: boolean;
}

function stringParameter(this: IExecuteFunctions, name: string, itemIndex: number): string {
	const value = String(this.getNodeParameter(name, itemIndex, '')).trim();
	if (value === '') {
		throw new NodeOperationError(this.getNode(), `${name} is required`, { itemIndex });
	}
	return value;
}

function id(this: IExecuteFunctions, name: string, itemIndex: number): string {
	return encodeURIComponent(stringParameter.call(this, name, itemIndex));
}

// The API takes calendar dates; n8n's date picker and expressions give ISO timestamps, whose first
// ten characters are that date.
function toDate(this: IExecuteFunctions, value: unknown, label: string, itemIndex: number): string {
	const date = String(value ?? '').slice(0, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new NodeOperationError(this.getNode(), `${label} must be a date such as 2026-10-01`, {
			itemIndex,
		});
	}
	return date;
}

function list(value: unknown): string[] {
	return String(value ?? '')
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part !== '');
}

// Copies the set options into the query: empty strings are left to the API default, and the two
// comma-separated options become repeated keys.
function optionsQuery(
	this: IExecuteFunctions,
	options: IDataObject,
	itemIndex: number,
): IDataObject {
	const qs: IDataObject = {};
	for (const [key, value] of Object.entries(options)) {
		if (value === '' || value === undefined || value === null) {
			continue;
		}
		if (key === 'groupBy' || key === 'cloudAccountIds') {
			const values = list(value);
			if (values.length > 0) {
				qs[key] = values;
			}
		} else if (key === 'startDate' || key === 'endDate') {
			qs[key] = toDate.call(this, value, key, itemIndex);
		} else {
			qs[key] = typeof value === 'string' ? value.trim() : value;
		}
	}
	return qs;
}

function collection(this: IExecuteFunctions, name: string, itemIndex: number): IDataObject {
	return optionsQuery.call(
		this,
		this.getNodeParameter(name, itemIndex, {}) as IDataObject,
		itemIndex,
	);
}

function dateRange(this: IExecuteFunctions, itemIndex: number): IDataObject {
	return {
		startDate: toDate.call(
			this,
			this.getNodeParameter('startDate', itemIndex),
			'Start Date',
			itemIndex,
		),
		endDate: toDate.call(this, this.getNodeParameter('endDate', itemIndex), 'End Date', itemIndex),
	};
}

function workspaceQuery(this: IExecuteFunctions, itemIndex: number): IDataObject {
	return { workspaceId: stringParameter.call(this, 'workspaceId', itemIndex) };
}

/** The GET request one operation sends for one input item. */
function buildRequest(
	this: IExecuteFunctions,
	resource: string,
	operation: string,
	i: number,
): Request {
	switch (`${resource}:${operation}`) {
		case 'anomaly:getAll':
			return {
				path: '/v1/anomalies',
				qs: collection.call(this, 'filters', i),
				maxPageSize: LIST_PAGE_SIZE,
			};
		case 'budget:get':
			return { path: `/v1/budgets/${id.call(this, 'budgetId', i)}`, qs: {} };
		case 'budget:getAll':
			return {
				path: '/v1/budgets',
				qs: collection.call(this, 'filters', i),
				maxPageSize: LIST_PAGE_SIZE,
			};
		case 'cost:getData':
			return {
				path: '/v1/costs',
				qs: { ...dateRange.call(this, i), ...collection.call(this, 'options', i) },
				maxPageSize: COST_ROW_PAGE_SIZE,
				pinDataVersion: true,
			};
		case 'cost:getSummary':
			return {
				path: '/v1/costs/summary',
				qs: { ...dateRange.call(this, i), ...collection.call(this, 'options', i) },
			};
		case 'costAlert:get':
			return {
				path: `/v1/cost-alerts/${id.call(this, 'costAlertId', i)}`,
				qs: workspaceQuery.call(this, i),
			};
		case 'costAlert:getAll':
			return {
				path: '/v1/cost-alerts',
				qs: workspaceQuery.call(this, i),
				maxPageSize: LIST_PAGE_SIZE,
			};
		case 'costAlert:getEvents':
			return {
				path: `/v1/cost-alerts/${id.call(this, 'costAlertId', i)}/events`,
				qs: workspaceQuery.call(this, i),
				maxPageSize: LIST_PAGE_SIZE,
			};
		case 'costReport:get':
			return {
				path: `/v1/cost-reports/${id.call(this, 'costReportId', i)}`,
				qs: workspaceQuery.call(this, i),
			};
		case 'costReport:getAll':
			return {
				path: '/v1/cost-reports',
				qs: { ...workspaceQuery.call(this, i), ...collection.call(this, 'filters', i) },
				maxPageSize: LIST_PAGE_SIZE,
			};
		case 'costReport:getData':
			return {
				path: `/v1/cost-reports/${id.call(this, 'costReportId', i)}/data`,
				qs: workspaceQuery.call(this, i),
			};
		case 'provider:get':
			return { path: `/v1/providers/${id.call(this, 'providerId', i)}`, qs: {} };
		case 'provider:getAll':
			return {
				path: '/v1/providers',
				qs: collection.call(this, 'filters', i),
				maxPageSize: LIST_PAGE_SIZE,
			};
		case 'workspace:get':
			return { path: `/v1/workspaces/${id.call(this, 'workspaceId', i)}`, qs: {} };
		case 'workspace:getAll':
			return { path: '/v1/workspaces', qs: {}, maxPageSize: LIST_PAGE_SIZE };
		default:
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operation}" is not supported for the resource "${resource}"`,
				{ itemIndex: i },
			);
	}
}

export class Costfluent implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Costfluent',
		name: 'costfluent',
		icon: { light: 'file:../../icons/costfluent.svg', dark: 'file:../../icons/costfluent.svg' },
		group: ['input'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Read cloud costs, cost reports, budgets, alerts and anomalies from Costfluent',
		defaults: {
			name: 'Costfluent',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: CREDENTIAL_NAME,
				required: true,
			},
		],
		properties: costfluentProperties,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				const request = buildRequest.call(this, resource, operation, i);

				let results: IDataObject[];
				if (request.maxPageSize === undefined) {
					results = [await costfluentApiRequest.call(this, 'GET', request.path, request.qs)];
				} else {
					const returnAll = this.getNodeParameter('returnAll', i) as boolean;
					const limit = returnAll ? undefined : (this.getNodeParameter('limit', i) as number);
					results = await costfluentApiRequestAllItems.call(this, request.path, request.qs, {
						maxPageSize: request.maxPageSize,
						limit,
						pinDataVersion: request.pinDataVersion,
					});
				}

				for (const json of results) {
					returnData.push({ json, pairedItem: { item: i } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				const nodeError = new NodeOperationError(this.getNode(), error as Error);
				// Set here, not through the constructor's itemIndex option: handed a NodeOperationError,
				// as the transport throws for its own failures, the constructor returns it unchanged
				// and ignores the option, so the error would name no item.
				nodeError.context.itemIndex = i;
				throw nodeError;
			}
		}

		return [returnData];
	}
}
