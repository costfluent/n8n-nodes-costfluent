import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

// The base URL as an n8n expression: the default when the field is emptied, as the nodes read it.
const BASE_URL = '($credentials.baseUrl || "https://api.costfluent.com").trim()';

// n8n sends the credential test itself, outside the nodes' https check, so the token is attached
// only for an https base URL or plain http to this machine, the rule the nodes apply. Any other base
// URL gets no token, and the test fails with 401 instead of sending the token in clear.
const TOKEN_ALLOWED = String.raw`/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$))/i`;

export class CostfluentApi implements ICredentialType {
	name = 'costfluentApi';

	displayName = 'Costfluent API';

	icon: Icon = { light: 'file:../icons/costfluent.svg', dark: 'file:../icons/costfluent.svg' };

	documentationUrl = 'https://docs.costfluent.com/api/authentication';

	properties: INodeProperties[] = [
		{
			displayName: 'API Token',
			name: 'apiToken',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'A Costfluent API token, starting with cf_org_ or cf_ws_. The Costfluent Trigger needs an organization token that may create, view and delete notification channels.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.costfluent.com',
			description:
				'The Costfluent Public API address. Change it only if Costfluent gave you another one.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: `={{ ${TOKEN_ALLOWED}.test(${BASE_URL}) ? "Bearer " + $credentials.apiToken : "" }}`,
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: `={{ ${BASE_URL} }}`,
			url: '/v1/workspaces',
			method: 'GET',
			qs: { limit: 1 },
		},
	};
}
