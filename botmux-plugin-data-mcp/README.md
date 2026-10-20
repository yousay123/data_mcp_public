# botmux-plugin-data-mcp

Botmux plugin for identity-bound Data MCP access.

This source repository is public. Deployment-specific endpoints, credentials,
database names, table names, business definitions, and prompts must stay in
host-only configuration and must never be committed here.

## Capabilities

- Skill: `data-mcp`
  - data-query workflow rules
  - identity and export boundaries
  - metadata-first table discovery guidance
- MCP: `data-mcp`
  - stdio server at `dist/mcp/server.js`
  - trusts only Botmux MCP Gateway injected `_meta.botmuxTrustedCaller`
  - fails closed when Gateway trusted-caller metadata is absent
  - exposes identity-bound tools that forward explicit SQL to the Data MCP
    service side for validation/execution
  - exposes signed local snapshot refresh/search over the same private Unix socket
- CLI:
  - `botmux data-mcp:status`
  - `botmux data-mcp:show-config`

## Trust Boundary

The plugin must not trust identity from prompts or tool arguments. Real user
identity must come only from Botmux MCP Gateway per-turn metadata:

```json
{
  "_meta": {
    "botmuxTrustedCaller": {
      "requestUserOpenId": "ou_xxx",
      "requestUserUnionId": "on_xxx",
      "requestLarkAppId": "cli_xxx",
      "turnId": "om_xxx"
    }
  }
}
```

Gateway metadata is the sole trusted identity source. If it is absent, Data
MCP tools fail closed; there is no second identity source.

Scheduled data access also binds the trusted creator identity to the active
turn. A `schedule_creator` caller is accepted only when `turnId` has the form
`schedule:<taskId>:<turn>` and its embedded task id exactly matches the trusted
`taskId`. Conversely, a `schedule:` turn is rejected unless its trusted caller
source is `schedule_creator`. This prevents a scheduled input adopted into an
already-active turn from using that turn's preserved caller identity.

Trusted Excel delivery is one-shot. The plugin stages an atomic outbound file;
the Botmux host consumes it into bounded memory and removes the staged source
before any send. Plugin shutdown cleans files still owned by that process, and
startup removes abandoned Data MCP artifacts older than 15 minutes.

Query plans additionally bind to a host-injected execution context. The wrapper
prefers a non-empty `BOTMUX_SESSION_ID` and otherwise uses a non-empty
`BOTMUX_EXECUTION_ID` for sessionless execution. It reads both values only from
the plugin process environment and forwards the selected value through the
existing hidden `caller_session_id` service field; model arguments cannot set
or override it. Plans also bind union id, SQL, the fixed `tchouse-c` datasource,
Lark app id, and schedule task id when applicable. Normal plans run once;
`execution_mode=compare` plans run exactly twice with a separately capped
15-minute TTL. Every run resolves credentials and re-runs the service guard.

For sessionless execution, the Botmux host must generate a fresh random
`BOTMUX_EXECUTION_ID` per command, inject it after plugin descriptor environment
merging so descriptor values cannot override it, reuse it for that command's
byte-exact validate-to-run SQL flow, and never reuse it across commands. The
wrapper uses trimming only to reject blank SQL; it forwards non-blank SQL
without normalization because query plans bind the original string exactly.

## Develop

```bash
npm install
npm test
```

## Local Install

```bash
botmux plugin install .
botmux plugin enable data-mcp --bot <bot-name-or-index>
botmux data-mcp:status
```

Normal deployments must use the copied, non-link install shown above. A linked
install can leave Botmux pointing at a moved or deleted checkout and should not
be used as the persistent production installation.

After changing source files, rebuild and reinstall/re-enable if contribution
entries changed:

```bash
npm run build
botmux plugin install .
botmux plugin enable data-mcp --bot <bot-name-or-index>
```

Use `botmux plugin install . --link` only for source-linked development from a
stable host-only directory. After debugging, reinstall without `--link` and
verify `botmux data-mcp:status` so no runtime dependency remains on the source
checkout.

## Runtime Configuration

Use controlled environment variables or Botmux plugin private config. Do not put
real tokens, passwords, cookies, JDBC URLs, or account mapping files into the
published package.

Environment contract:

- `DATA_MCP_SERVICE_BASE_URL`
  - Default: `http://127.0.0.1:8765`
  - Used to derive `/agent/validate-sql` and `/agent/run-query`.
- `DATA_MCP_SERVICE_SOCKET_PATH`
  - Defaults to `$HOME/.cache/ksher-agent-data-mcp/run/api.sock` and is the production transport.
  - Snapshot refresh/search deliberately have no per-tool endpoint override and use this same service boundary.
- `DATA_MCP_VALIDATE_SQL_ENDPOINT`
  - Optional full URL override for `validate_sql_for_user`.
- `DATA_MCP_RUN_QUERY_ENDPOINT`
  - Optional full URL override for `run_query_for_user`.
- `DATA_MCP_QUERY_ENDPOINT`
  - Backward-compatible alias for `DATA_MCP_RUN_QUERY_ENDPOINT`.
- `DATA_MCP_INTERNAL_AUTH_TOKEN`
  - Required service-to-service token sent as `X-Internal-Auth` for both Unix-socket and URL/TCP transports.
  - Keep it in the host-only file selected by `KSHER_AGENT_DATA_MCP_ENV_FILE`; never export it into the plugin, runner, or Python API process environment, and never expose it to an agent sandbox or model-visible arguments.
- Raw `run_query_for_user` / `export_query_to_excel_file` result responses are
  always disabled. Business results must use `deliver_query_result_for_user`;
  this fail-closed boundary cannot be disabled by environment configuration.
- `DATA_MCP_RESULT_MODEL_ENDPOINT`
  - Full OpenAI-compatible internal chat-completions endpoint used only after query execution.
- `DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS`
  - Required comma-separated exact hostname allowlist for the internal result model endpoint.
  - Every request also resolves and pins the endpoint to loopback, RFC1918, or
    IPv6 ULA. Redirects and `198.18.0.0/15` proxy fake-IP addresses are rejected.
    Deployments using split DNS must configure a direct route that resolves to
    the real private address; never weaken the address check to accommodate a proxy.
- `DATA_MCP_RESULT_MODEL_TEST_EXCEPTION`
  - Test-only, default-disabled exception for exactly one public endpoint, formatted
    as `host=exact.example;ip=203.0.113.10;expires=YYYY-MM-DD`. Wildcards, CIDR
    ranges, multiple records, private/loopback addresses, and `198.18.0.0/15`
    proxy fake-IP addresses are rejected. The hostname and its sole DNS answer
    must exactly match. The expiry may be at most 60 calendar days from the
    current UTC date, and the exception expires automatically after the stated
    UTC date.
  - Every use writes a `model_endpoint_exception_used` audit event containing
    only a host fingerprint. This exception is only for synthetic data or
    non-sensitive aggregate queries during integration testing. Remove it when
    the model moves to the Tencent Cloud private network; never use it as a
    production deployment substitute.
- `DATA_MCP_RESULT_MODEL`
  - Internal model name.
- `DATA_MCP_RESULT_MODEL_API_KEY`
  - Optional internal endpoint credential. Keep it only in the host-only file
    selected by `KSHER_AGENT_DATA_MCP_ENV_FILE`; the plugin rejects it in the
    process environment.
- `DATA_MCP_RESULT_BINDING_HMAC_KEY`
  - Required, host-only secret of at least 32 characters for interactive result
    bindings. Missing keys fail closed. Keep it in the same host-only env file.
- `DATA_MCP_TEST_PROFILE_APP_ID` / `DATA_MCP_TEST_PROFILE_ENV_FILE`
  - Optional test-only selector. When the host-signed per-call
    `requestLarkAppId` exactly matches the configured app id, the plugin loads
    the absolute env-file path as that call's test profile. Missing, malformed,
    symlinked, non-regular, or permissions broader than `0600` fail closed for
    the selected app and never fall back to the default profile.
  - The test profile may override only the dedicated service socket and result
    model endpoint, exact-host allowlist, model, API key, and endpoint test
    exception. Socket, model endpoint, exact-host allowlist, and model are all
    required; the socket cannot be `disabled`. A selected profile is a closed
    configuration group: omitted optional keys remain absent and never inherit
    their default-profile values. HMAC keys, caller/session identity, service
    authentication, and all other settings are ignored even if present in the
    file. The cache is isolated by signed app id, absolute file path, and mtime.
  - Configure this only for a dedicated integration-test bot. Remove both
    selector variables and the public-endpoint exception after moving the model
    to the Tencent Cloud private network. While enabled, use only synthetic data
    or explicitly approved non-sensitive aggregates.
- `DATA_MCP_RESULT_IDLE_TTL_MS` / `DATA_MCP_RESULT_ABSOLUTE_TTL_MS`
  - Optional positive integer overrides. Defaults are 24 hours idle and 7 days absolute.
- `DATA_MCP_RESULT_MAX_BYTES` / `DATA_MCP_RESULT_MAX_OWNER_BYTES` /
  `DATA_MCP_RESULT_MAX_TOTAL_BYTES`
  - Optional positive byte quotas for one result, one owner, and the store.

The service runner passes only an allowlisted non-sensitive environment to the
Python API. The API loads private configuration directly from the host-only file
into its settings object. This is intentional: on supported macOS hosts, file
isolation does not imply that another same-UID process cannot inspect a process
environment.

For interactive tools, the plugin forwards explicit SQL and Botmux Gateway
trusted identity to the Data MCP service. SQL validation, permission checks,
account mapping, execution, export limits, and audit remain on the Data MCP
side. No model-visible tool may return raw query rows.

Interactive results are bound to the host-authenticated union id and app id,
plus `BOTMUX_SESSION_ID`, which Botmux freezes in the plugin process environment
and the model cannot supply as a tool argument. The result handle is never
model-visible. When Botmux adds a signed session id to per-turn metadata, the
plugin should migrate from the process environment to that value.

`continue_query_result_for_user` accepts only the user's follow-up text and an
output mode. Analysis uses the stored result. Excel follow-ups deliberately
revalidate permissions and rerun the original SQL; therefore the spreadsheet
may differ from the earlier analysis snapshot. Its reply states that it is a
fresh query and includes the generation time. Per trusted turn id, only
one follow-up call is accepted. Internal-model text and Excel files are replied
directly to the signed `turnId` message by the session-bound bot identity.
Topic messages stay in the original topic; ordinary group and P2P messages
remain flat replies in the same conversation. Before sending, the plugin uses
Botmux's live session observation to verify that the bound session app matches
the signed app id, then delegates routing to `botmux send`. Direct delivery has
no cross-invocation deduplication: repeating the same delivery tool call can
send duplicate text and attachments, so callers must not retry after an
ambiguous receipt.
It fails closed rather than falling back to another bot profile. Normal MCP content contains only delivery
counts/status or a fixed error code; it never contains result text, filenames,
paths, or file bytes.

Direct replies remain in ordinary Lark chat history. A calling model with access
to Botmux history/quoted-message tools can read that content in a later turn,
even though the delivery tool response itself is redacted. Use direct delivery
only with synthetic test data until the host provides result-message filtering
or the protected result-page flow is restored.

Known host limitation: a busy shared topic can expose the most recently
captured human identity to a tool call. Binding mismatches fail closed, so this
can interrupt a response but cannot return rows to the calling model. Deploy
the internal model without tools or general outbound network access, and do not
write its prompts or responses to ordinary logs.

### Model-visible tool boundary

| Tool | Success visible to the calling model | Failure visible to the calling model |
| --- | --- | --- |
| `data_mcp_identity_probe` | Trusted-identity diagnostics only; no query data | Fixed identity error |
| `data_mcp_query_plan` | Planning guidance only; does not execute SQL | Fixed planning error |
| `validate_sql_for_user` | Sanitized datasource, table/column names, normalized SQL, and plan id; never rows or sample values | Fixed validation code; database error details are removed |
| `run_query_for_user` | Always `isolated_delivery_required`; raw execution is closed | Fixed isolated-operation error |
| `export_query_to_excel_file` | Always `isolated_delivery_required`; file metadata is closed | Fixed isolated-operation error |
| `deliver_query_result_for_user` | Fixed direct-delivery status, byte/attachment counts, and truncation flag; result content is replied to the signed original Feishu message | Fixed isolated-operation or direct-delivery error |
| `continue_query_result_for_user` | Fixed direct-delivery receipt; active-result handles are not arguments | Fixed deterministic state or direct-delivery error only |
| `refresh_metadata_snapshot` | Refresh status; schedule-only and no SQL arguments | Policy/service status without query rows |
| `search_metadata_snapshot` | Allowlisted dictionary fields only; example and sample values are removed | Fixed snapshot status code |
| `audit_ck_default_role_baseline` | Access-control audit metadata; schedule-only | Policy/service status without query rows |
| `inspect_ck_subjects_by_table` | Bounded access-holder metadata for explicit tables | Policy/service status without query rows |
| `inspect_ck_resources_by_subject` | Bounded access metadata for explicit subjects | Policy/service status without query rows |

There is no model-visible raw-result tool or handler route. Database service
errors must not be relayed verbatim when they can echo literals from a query.

Metadata discovery calls `search_metadata_snapshot`; refresh accepts only a
host-injected `schedule_creator` identity with task/app/owner binding and never
accepts SQL, table names, identity, or task fields from model arguments.

## Current Status

This plugin expects a Data MCP HTTP service to be reachable from the host. If
the service is absent, identity-bound tools return a structured
`Data MCP 服务不可达` error instead of falling back to model-supplied identity or
local SQL execution.
