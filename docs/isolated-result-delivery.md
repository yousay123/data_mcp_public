# Isolated result delivery

This optional path keeps query rows and exported file bytes out of the external
orchestration model's context. It does not by itself prove that every component
is inside a company network; deployment controls remain part of the boundary.

## Flow

1. Botmux snapshots the trusted caller identity once for the tool call.
2. Data MCP validates and executes the read-only query for that identity.
3. For `analysis`, the result is sent only to an allowlisted internal model.
   For `excel`, Data MCP stages a one-shot artifact in the plugin outbound
   directory.
4. Data MCP returns a host-only delivery envelope. Model-visible tool content
   contains only a fixed receipt or a sanitized error.
5. Botmux validates the complete envelope before any user-visible side effect,
   consumes file bytes into bounded memory, removes the staged source, and
   serializes delivery until the daemon returns the final receipt.
6. The daemon sends to the trusted turn recipient and returns only a redacted
   delivery receipt to the worker.

Raw `run_query_for_user` and `export_query_to_excel_file` result responses are
unconditionally fail-closed. Callers must use `deliver_query_result_for_user`.
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
- Excel artifacts are atomically staged, consumed once, and cleaned on normal
  exit, interruption, and stale-file recovery.
- Botmux enforces per-file, file-count, markdown, and total-envelope limits and
  validates the whole envelope before sending a card or uploading a file.

## Deployment responsibilities

The deployment must still enforce network egress allowlists, DNS/TLS policy,
log redaction and retention, least-privilege service credentials, and controlled
access to the host configuration file. Before production use, validate the
actual internal model endpoint and the real messaging upload path in a
controlled environment.
