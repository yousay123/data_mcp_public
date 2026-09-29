# botmux-plugin-data-mcp

Private Botmux plugin for Data MCP access.

This package is intentionally private and is not registered in the public
Botmux plugin market. It is meant to be installed only in controlled
environments and enabled only for selected bots.

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
  - exposes `execute_frozen_query` for host-approved templates: the plugin owns
    SQL literal encoding plus byte-exact validate/run, and returns only the service
    fields `rows`, `columns`, `row_count`, `query_id`, and `error_code`; BotMux owns display
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
  - Optional service-to-service token sent as `X-Internal-Auth`.

For interactive tools, the plugin forwards explicit SQL and Botmux Gateway
trusted identity to the Data MCP service. For `execute_frozen_query`, Botmux
passes an approved template plus already type-checked values as opaque plugin
payload; the plugin alone encodes SQL literals, renders the final SQL, and sends
the exact same bytes through validate and run. The returned presentation never
contains SQL and raw HTML is not part of the contract. SQL validation,
permission checks, account mapping, execution, export limits, and audit remain
on the Data MCP side.

Each `execute_frozen_query` call performs one validate/run pair. The plugin does
not replay a failed run with an old plan; a caller retry starts a new invocation
and obtains a new plan under the same host-injected identity boundary.
Metadata discovery calls `search_metadata_snapshot`; refresh accepts only a
host-injected `schedule_creator` identity with task/app/owner binding and never
accepts SQL, table names, identity, or task fields from model arguments.

## Current Status

This plugin expects a Data MCP HTTP service to be reachable from the host. If
the service is absent, identity-bound tools return a structured
`Data MCP 服务不可达` error instead of falling back to model-supplied identity or
local SQL execution.
