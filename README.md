# n8n-nodes-costfluent

[n8n](https://n8n.io) nodes for [Costfluent](https://costfluent.com), the cloud cost management
platform:

- **Costfluent Trigger** starts a workflow when something changes in Costfluent: a savings
  opportunity is accepted, a provider connection fails, an anomaly is acknowledged, the plan changes.
- **Costfluent** reads costs, cost reports, budgets, cost alerts, anomalies, provider connections
  and workspaces from the Costfluent Public API.

The package has no runtime dependencies. It is MIT licensed.

## Install

In n8n, open **Settings**, **Community Nodes**, select **Install** and enter `n8n-nodes-costfluent`.
On a self-hosted instance you can instead install it into n8n's custom nodes folder:

```bash
cd ~/.n8n/nodes
npm install n8n-nodes-costfluent
```

Then restart n8n. See n8n's
[community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
for queue mode and Docker.

## Credential

Both nodes use one **Costfluent API** credential:

| Field | Meaning |
|---|---|
| **API Token** | A Costfluent API token, created in Costfluent under **Settings**, **API tokens**. Organization tokens start with `cf_org_`, workspace tokens with `cf_ws_`. |
| **Base URL** | The API to call: `https://api.costfluent.com` unless Costfluent gave you another. It must use https; plain http is accepted only for `localhost`. With any other address the nodes refuse to run and the token is not sent, so the credential test fails. |

n8n tests the credential by listing workspaces, so the token needs **View workspace**
(`viewWorkspace`) for the test to pass.

Give the token only what the workflow needs:

- For the **Costfluent** node, the **Read only** preset covers every operation. An operation the
  token cannot perform fails with `403` and names the missing capability.
- For the **Costfluent Trigger**, an **organization** token that can create, view and delete
  notification channels (`createApp`, `viewMembers` and `deleteApp`, in the **Users, teams and
  channels** group), because the trigger registers its own webhook channel.

The [authentication guide](https://docs.costfluent.com/api/authentication) explains tokens and
capabilities.

## Costfluent

Every operation reads; none changes anything in Costfluent. Listing operations follow the API's
pages for you: turn on **Return All** for every result, or set **Limit**.

| Resource | Operations | API |
|---|---|---|
| Anomaly | Get Many, filtered by cloud account, severity, date range or unacknowledged only | `GET /v1/anomalies` |
| Budget | Get, Get Many (optionally for one workspace) | `GET /v1/budgets` |
| Cost | Get Data: cost rows over a date range, by day, week, month, quarter or cumulative, grouped by up to three dimensions | `GET /v1/costs` |
| Cost | Get Summary: the total, the change and the top services over a date range | `GET /v1/costs/summary` |
| Cost Alert | Get, Get Many, Get Events (the times an alert fired) of a workspace | `GET /v1/cost-alerts` |
| Cost Report | Get, Get Many, Get Data (the summary, series and breakdown the report shows) of a workspace | `GET /v1/cost-reports` |
| Provider | Get, Get Many (optionally by type) | `GET /v1/providers` |
| Workspace | Get, Get Many | `GET /v1/workspaces` |

Dates are calendar days: a date picker value or an expression such as `{{ $today.minus(30, 'days') }}`
is read as its `YYYY-MM-DD` day. **Group By** and **Cloud Account IDs** take comma-separated
values, for example `ServiceName,Tag:team`.

Each object or row is one output item, exactly as the [API reference](https://docs.costfluent.com/api)
describes it. Amounts are decimal strings in the item's `currency`.

## Costfluent Trigger

Choose the **Events** that should start the workflow. When you activate the workflow, or listen for
a test event, the trigger creates a webhook notification channel in Costfluent named
`n8n: <workflow name>`, pointed at the workflow's webhook URL and subscribed to those events, and
keeps the channel's signing secret in the workflow. When the chosen events no longer match the
channel's, activation replaces the channel with one subscribed to the new set. Deactivating the
workflow deletes the channel. A channel someone already deleted in Costfluent counts as deleted.

> [!IMPORTANT]
> Costfluent delivers only to a public `https` address. An n8n instance on `localhost`, a private
> network address or plain `http` cannot receive events: set n8n's `WEBHOOK_URL` to its public https
> address, for example behind a reverse proxy or a tunnel.

| Event | Starts the workflow when |
|---|---|
| Anomaly Status (`anomaly_status`) | A cost anomaly is acknowledged, archived, ignored or reopened, by a person or by Costfluent archiving it. |
| Connection Imported (`connection_imported`) | A new provider connection's first import finishes: every month its first collection queued has been imported. Sent once per connection. |
| Provider Health (`provider_health`) | A provider connection's health changes, its last sync turns from success to failure or back, or it is disabled or enabled again. |
| Savings Item Status (`savings_item_status`) | A savings opportunity is accepted, implemented, verified, rejected, withdrawn or reopened. |
| Spend Band (`spend_band`) | A month's tracked spend is counted above the plan's band, or a second such month schedules the move to a larger plan or, on Free, pauses collection. |
| Subscription Status (`subscription_status`) | The subscription's plan or status changes. |

### What the workflow receives

One item: the body Costfluent sent, and beside its fields `delivery_id`, the request's
`X-Costfluent-Delivery` header:

```json
{
  "event_type": "savings_item_status",
  "schema_version": 1,
  "subject": "Savings opportunity accepted",
  "content": "Rightsize the build agents was accepted.",
  "html_content": "<p>Rightsize the build agents was accepted.</p>",
  "timestamp": "2026-10-19T08:00:00.0000000Z",
  "app_id": "app_Xk2pQ9vLr4mN8tY1wZ3aBc",
  "data": {
    "opportunity_id": "sav_Rk7mV2pQx9LnT4wY8cZ1aB",
    "workspace_id": "wsp_Hq3nB8xLm2vK9tR4yP7cWd",
    "title": "Rightsize the build agents",
    "status": "accepted",
    "previous_status": "open",
    "estimated_monthly_saving": 120.5,
    "currency": "EUR",
    "changed_at": "2026-10-19T07:59:58Z"
  },
  "delivery_id": "delivery-0192a3b4c5d67e8f9a0b1c2d3e4f5a6b"
}
```

Costfluent retries a delivery that failed, so a workflow can start twice for one change.
`delivery_id` is the same on every attempt at one delivery, so drop an item whose `delivery_id` the
workflow already handled. It is `null` for a channel test, which sends none.

Branch on `event_type`, and read ids and figures from `data` rather than from the text in
`subject` and `content`, whose wording can change. `timestamp` is when the delivery was sent, in
UTC. Ids are the ones the Public API uses, instants are UTC, and the enumerated values below are
spelled as shown:

| Event | Fields of `data` |
|---|---|
| `anomaly_status` | `anomaly_id`, `workspace_id`, `status` and `previous_status` (`open`, `acknowledged`, `archived` or `ignored`), `reason` (`expired` or `restated` when Costfluent archived it, otherwise `null`), `changed_at` |
| `connection_imported` | `connection_id`, `provider`, `connection_name`, `first_month` and `last_month` (`YYYY-MM`, the first and last month with imported cost, or `null` when the import found none), `records` (the number of cost records imported, `0` when none), `data_through` (`YYYY-MM-DD`, the last day the imported data covers, or `null` when none), `detail_follows` (`true` when an AWS period was read from Cost Explorer, so resource and tag detail follows with the AWS export within 24 to 72 hours), `changed_at` |
| `provider_health` | `connection_id`, `provider`, `connection_name`, `health_status` and `previous_health_status` (`unknown`, `healthy`, `degraded` or `failed`), `sync_status` and `previous_sync_status` (`success`, `error`, `throttled`, `quota_exceeded`, `restatement_refused`, `collection_stopped`, `processing_failed`, or `null` before the first sync), `disabled`, `error`, `changed_at` |
| `savings_item_status` | `opportunity_id`, `workspace_id`, `title`, `status` and `previous_status` (`open`, `accepted`, `implemented`, `verified`, `rejected` or `withdrawn`), `estimated_monthly_saving`, `currency`, `changed_at` |
| `spend_band` | `step` (`firstMonthAbove`, `upgradeScheduled`, `salesReferral` or `collectionPaused`), `month` (`YYYY-MM`), `tracked_spend`, `currency`, `plan`, `band_plan`, `effective_on` (`YYYY-MM-DD`, or `null`) |
| `subscription_status` | `plan`, `previous_plan`, `status`, `previous_status`, `changed_at` |

A new field can appear in `data` without notice, and `schema_version` rises only when a field
changes meaning or goes away. Costfluent's
[webhook reference](https://docs.costfluent.com/api/webhooks) describes the delivery in full.

### Signature verification

Every delivery carries `X-Costfluent-Signature: sha256=<hex>`, the HMAC-SHA256 of the raw request
body keyed with the channel's signing secret. The trigger recomputes it over the bytes n8n received,
before parsing them, and compares the two in constant time:

- A delivery with a missing, malformed or wrong signature is answered `401` and does not start the
  workflow. So is any delivery while the trigger holds no signing secret.
- A correctly signed delivery whose `timestamp` is more than 5 minutes before or after the n8n
  host's clock, or is missing or not an ISO 8601 instant with its time zone, is answered `401` too.
  The signature covers the timestamp, so a recorded delivery cannot be replayed later; a retry
  carries a new timestamp. Keep the host's clock synchronised.
- A correctly signed delivery of an event you did not choose is answered `200` and does not start
  the workflow.
- A correctly signed delivery of a chosen event is answered `200` and starts the workflow.

The signing secret is generated by Costfluent when the trigger creates the channel and is returned
only once, so it is kept in the workflow's static data and never shown. If it is lost, the next
activation replaces the channel with a new one.

## Development

```bash
npm ci
npm run lint
npm run build
npm test
```

`npm run dev` starts a local n8n with the nodes loaded. Releases are published to npm from the
`publish` workflow when a `vX.Y.Z` tag is pushed, with an npm provenance statement.

## License

[MIT](LICENSE.md)
