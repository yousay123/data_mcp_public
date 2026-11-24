# Isolated result delivery

This optional path keeps query rows and exported file bytes out of the MCP tool
reply. It does **not** currently prove end-to-end isolation: an orchestration
model may read delivered business messages again through history, quoted, raw
IM APIs or other credentials. See [the current review](dual-model-review-20261124.md)
before making a production isolation claim.

## Flow

1. Botmux snapshots the trusted caller identity once for the tool call.
2. Data MCP validates and executes the read-only query for that identity.
3. The isolated result Agent receives protected rows/schema/context and plans
   the requested analysis, chart and file tools. File generation belongs to
   the Agent tools, not the Python query service.
4. In the current implementation the plugin invokes one combined `botmux send`
   with the prepared card and files. It does not use the historical host-only
   MCP delivery envelope; that remains a host integration target.
5. Only confirmed complete delivery immediately deletes staged source files.
   Failed private files remain bounded by retention and stale-file cleanup.
6. The orchestration model receives metadata only. A successful receipt ends
   delivery; it must not send a second summary or read the business card back.

Raw `run_query_for_user` and `export_query_to_excel_file` result responses are
fail-closed in dual mode. Explicit single-model mode intentionally returns
bounded rows to its calling model. Dual callers use `deliver_query_result_for_user`.
`frozen_query_raw` is separately marked host-only and requires the
`frozen_query_v1` capability injected by the frozen-command host; ordinary
model-facing Gateways neither list nor route it.

## Security properties

- Caller identity is injected by the Botmux host; model arguments cannot set or
  replace it.
- Result-model endpoints require an exact hostname allowlist.
- Result-model credentials are read from the host-only environment file and are
  rejected in the plugin process environment.
- Upstream failures are mapped to fixed, allowlisted errors; partial rows,
  columns, SQL, paths, and raw responses are not returned to the caller.
- Transport and filesystem exceptions at the isolated-delivery boundary are
  also collapsed to the same fixed error and never expose addresses or paths.
- Artifacts are atomically staged and cleaned after confirmed complete
  delivery, or by bounded stale-file recovery after failure.
- Paths, sizes, counts and the trusted delivery anchor are checked before
  invoking the host. These checks do not classify subsequent IM reads.

## Deployment responsibilities

The deployment must still enforce network egress allowlists, DNS/TLS policy,
log redaction and retention, least-privilege service credentials, and controlled
access to the host configuration file. Before production use, validate the
actual internal model endpoint and the real messaging upload path in a
controlled environment.
