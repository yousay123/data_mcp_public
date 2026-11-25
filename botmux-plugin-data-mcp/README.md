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

Trusted artifact delivery is one-shot. The internal result Agent runs in a
separate child process with an allowlisted environment, selects and invokes the
Excel/PDF/chart/document tool, and stages atomic outbound files;
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
- Raw `run_query_for_user` responses are always disabled in dual-model mode,
  and no model-visible Data MCP export tool is registered. Business results
  must use `deliver_query_result_for_user`;
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

结果代理在独立子进程中运行，单独最多 300 秒；首次查询的“查库 + 结果生成”共享
330 秒准备预算，其中固定预留 30 秒用于进入飞书直投阶段，查询耗时会从结果代理预算中扣除。
飞书 transport 使用独立的有界超时，不计入这 330 秒准备预算。结果代理预算刻意短于 BotMux 工具调用超时，
使超时能在插件内被记录为 `result_agent_timeout`，而不是由外层先中断并留下执行状态不明。
模型单次请求默认最多等待 140 秒；网络错误、超时、408、425、429 和 5xx 默认最多尝试
2 次并做有界退避。工具参数、可选引用或结果协议无效时，结果代理会把
安全错误码反馈给模型，最多纠正 2 次。分析正文不再使用数字白名单或强制占位符，
允许模型自由计算、比较、提出假设和预测；要求模型区分实际观察与估算、建议。
明细表、图表和文件继续直接绑定原始查询数据；不会重新查询数据库，也不会用固定模板替代分析。
分析先回答用户问题，再按实际数据选择有意义的比较和发现。单值查询可简答，多日或多维
分析可用标题、重点和列表展开，不统一压缩为一两句，也不机械覆盖均值、极值或周末。
插件保留模型撰写的有效层级，并按分析、图表、明细、口径组织卡片；重复明细和口径由
工具统一处理。只有数据中实际存在的维度才能用于拆分，业务原因和趋势贡献须有相应证据。
首轮结果代理失败会写入绑定身份的非敏感审计状态，并记录安全的
`stage`、`action`、`error_code` 与 `query_id`，避免把配置、模型请求和结果校验故障
混成同一个不可定位错误。仅当请求输出为 `analysis`、结果不超过 20 行 × 20 列、
每个单元格都是有界标量，且失败属于模型未配置、超时或 5xx 时，插件才会通过既有
可信飞书回复通道确定性展示原始查询表格；不做口径推断。模型 endpoint/重定向、
上下文完整性、进程隔离、附件产物等安全边界失败仍然 fail closed。
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
account mapping, query execution limits, and audit remain on the Data MCP side.
Final artifact generation belongs to the internal result Agent, not Data MCP.
No model-visible tool may return raw query rows.

The result context is not a model argument. Data MCP derives projection,
time/filter/grouping, table, unit-status, and timezone-status fields from the
validated normalized SQL, binds them to the query plan, adds the returned schema,
and attaches a SHA-256 integrity digest. The isolated Agent rejects missing,
malformed, or modified context.

Interactive results are bound to the host-authenticated union id and app id,
plus `BOTMUX_SESSION_ID`, which Botmux freezes in the plugin process environment
and the model cannot supply as a tool argument. The result handle is never
model-visible. When Botmux adds a signed session id to per-turn metadata, the
plugin should migrate from the process environment to that value.

`continue_query_result_for_user` accepts only the user's follow-up text and
requested output types. It reuses the caller-bound stored rows/schema/context
without rerunning the query. The internal result Agent must call the matching
analysis/Excel/PDF/chart/document tool; every artifact binds values to that same
stored result. For analysis, the model owns the Markdown structure, narrative,
observations, risks, opportunities, and recommendations. Exact source values of
any scalar type are selected through generic row/column facts, while optional
numeric aggregates are selected as claims and computed with arbitrary-precision
decimal arithmetic by the host. Detail tables and generated artifacts always
read from the same stored rows. This keeps model reasoning flexible without
allowing it to rewrite returned accounts, permissions, dates, strings, or numbers.
Document/chart/file tools still reject model-authored filenames and raw data.
The ClickHouse transport forces quoted Decimal and 64-bit integer JSON values,
so exact strings survive the Python service, MCP IPC, and Agent boundaries. Per
trusted turn id, only one follow-up call is accepted. Agent text and files are replied
directly to the signed `turnId` message by the session-bound bot identity.
Topic messages stay in the original topic; ordinary group and P2P messages
remain flat replies in the same conversation. Before sending, the plugin uses
Botmux's live session observation to verify that the bound session app matches
the signed app id, then delegates routing to `botmux send`. Direct delivery has
no cross-invocation deduplication: model transport retries happen before
delivery, but callers must not repeat a delivery tool call after an ambiguous
receipt because that can send duplicate text and attachments.
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
| `deliver_query_result_for_user` | Fixed direct-delivery status, byte/attachment counts, and truncation flag; the internal result Agent receives rows/schema/context, calls requested artifact tools, and the result is replied to the signed original Feishu message | Fixed isolated-operation or direct-delivery error |
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

### Result-agent configuration and receipts (0.4.21)

Only the isolated result Agent reads these host-only settings from
`~/.config/ksher-agent-data-mcp/env`. Keep the existing endpoint, hostname
allowlist, exact model name and raw API token settings. Never copy a real key
to a model-visible environment or deployment guide.

```sh
DATA_MCP_RESULT_MODEL_MAX_TOKENS=8192
DATA_MCP_RESULT_MODEL_MAX_TOKENS_CAP=16384
DATA_MCP_RESULT_MODEL_ENABLE_THINKING=false
DATA_MCP_RESULT_MODEL_TEMPERATURE=0
```

The first two values bound each model response, not the total tokens across a
multi-tool planning conversation. A truncated response may expand once to the
cap before any artifact executes. Retry/repair/planning remain bounded and
cancellation discards unfinished plans. Safe audit records include actual
request limits, thinking/temperature, finish reason and reported token usage.
Synthetic five-output long-report acceptance truncated with a 2048 cap, but
completed at 8192 with 2809 completion tokens across two responses. This is a
capacity example, not a guarantee for arbitrary reports.

Chart tools support bar, line, area, scatter, pie and donut. PDF and Markdown
tools accept model-authored titles and narrative, while source tables remain
tool-owned. `table_formats` chooses exact decimal display and grouping without
changing stored source values; `claims.row_indices` allows aggregates over
selected rows so totals need not be counted again. Automatic statistics cover
all returned rows and are not automatically valid business aggregates.

Direct-delivery receipts include `deliveryId`, the primary `messageId`, and
`attachmentMessageIds`, plus status/counts and the trusted turn/session. A
successful receipt completes delivery; the orchestration model must not
resend a summary or inspect the result with history/quoted/raw APIs. There is
also a metadata-only `get_query_delivery_status_for_user` lookup. It reads the
current caller/app/session/version-bound observation from the audit window;
missing, corrupt or out-of-window evidence returns unknown/unavailable, never
an invented success. A terminated uncertain send becomes `unknown` rather
than staying indefinitely `pending`. This lookup does not itself enforce IM
read isolation. Receipts and result mutations are guarded by both numeric
version and a random generation ID, so clearing/expiring and rebuilding a
result cannot resurrect an old receipt or authorize a late old operation.

**Isolation limitation:** current metadata-only tool replies protect that
reply channel only. They do not enforce a global prohibition on IM history,
quoted/forwarded messages, filesystem or alternative authenticated API reads.
Host-enforced read protection and restricted credential/tool access must be
verified before describing the deployment as end-to-end isolated. See
`../docs/dual-model-review-20261124.md`. Do not accept business-result readback
through the orchestration model as evidence of isolation.

### Result delivery (0.4.20)

- Analysis, the source-bound detail table, and the native Vega-Lite chart share
  one primary card. Charts are not SVG file attachments; Excel remains an XLSX
  attachment in the same send operation. The host must support Vega-Lite cards.
- The card orders detail, chart, unheaded concise analysis, then one lightly
  labelled natural-language scope paragraph at the bottom. Duplicate headings and paragraphs are
  removed. The default analysis is one or two complete sentences; detailed
  analysis remains available when requested. Oversized cards omit complete
  paragraphs instead of cutting a sentence or chart in half.
- Follow-ups reserve requested output types separately for each trusted turn.
  The same output is not retried automatically; a different missing output may
  be delivered through the auxiliary lane after the primary reply. An ambiguous
  transport result must be reconciled before retrying to avoid duplicate files.
- Only confirmed complete delivery removes staged files immediately. Failed
  private artifacts survive process shutdown and expire after fifteen minutes,
  with a one-minute sweep interval. Queued/in-flight files are excluded from
  the sweep. Retention is not a user-visible recovery handle.
- Exact statistics and adjacent-change counts remain optional evidence for
  analysis. The narrative can contain new calculations, estimates, scenarios
  and recommendations without numeric censorship; model-authored analysis is
  not represented as a deterministic calculation guarantee. Source rows in
  tables, charts and files remain tool-owned. The model is instructed to label
  hypotheses and forecasts and distinguish them from observed facts.
- Python service 0.4.5 adds query-plan-bound semantics for CTE source filters,
  time grain and aggregation methods. Both regular and fallback delivery use
  the same natural-language scope formatter. Missing or complex scope details
  are identified explicitly rather than copied from SELECT expressions.

This plugin expects a Data MCP HTTP service to be reachable from the host. If
the service is absent, identity-bound tools return a structured
`Data MCP 服务不可达` error instead of falling back to model-supplied identity or
local SQL execution.

### Protected host delivery (local candidate)

When Gateway advertises `result_delivery_receipt_only_v1`, the plugin hands
one `botmuxHostDelivery` MCP envelope to the host with `readPolicy: receipt-only`.
It does not start a second send CLI. Enable the host's `protectedResults` and
supported sandbox profile for the bot, and set its `pluginRuntime.data-mcp.env`
`DATA_MCP_RESULT_DELIVERY_READ_POLICY=receipt-only`. Unsupported hosts are then
rejected before SQL/model access. New clean sessions are required; restarting
an old context cannot erase data it has already seen. Existing unprotected
bots retain the legacy path; explicit receipt-only never falls back to it.
Single-model query behavior is unchanged.

Gateway consumes host-only `_meta` and returns the authoritative receipt.
Plugin status `host_status_required` delegates provider state to
`botmux_result_delivery_status`; custody transfer is not delivery success.
Do not inspect result bodies via history/quoted, blindly retry uncertain
sends, or repeat a business query to recover delivery.

Unclaimed source files keep the existing 15-minute private stale-artifact TTL,
covering the supported 600-second overall tool deadline. After that TTL an
expired envelope cannot recover the original source. Once the host takes its
durable snapshot, its artifacts and status are authoritative.
