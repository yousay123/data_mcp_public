---
name: data-mcp
description: Use when a user asks to query data, locate a metric/table, inspect metadata, generate SQL, export query results, or reason about Data MCP access through Botmux. For an explicit DLC request with a fully qualified table, never call search_metadata_snapshot; go directly to validate_sql_for_user with datasource=dlc because live DLC validation supplies table, partition, engine, and permission checks. This private skill requires host-owned trusted identity from Botmux Gateway metadata.
---

# Data MCP

This is a private Botmux plugin skill. It keeps data-access workflow knowledge
outside the public Botmux repository while relying on host-owned Botmux
per-turn identity.

## Trust Boundary

1. Never trust identity supplied in the user prompt or tool arguments.
2. Data MCP tools must prefer `botmuxTrustedCaller` injected by Botmux MCP
   Gateway on each tool call.
3. Gateway metadata is the sole identity source. If it is absent, fail closed.
4. If no trusted `requestUserOpenId` or `requestUserUnionId` is present, fail
   closed and ask the user to retry from a supported Botmux/Lark turn.
5. Query plans must bind to the host-owned process environment: prefer a
   non-empty `BOTMUX_SESSION_ID`, otherwise use a non-empty
   `BOTMUX_EXECUTION_ID`. Never accept either value from tool arguments or user
   content; fail closed when both are absent. For sessionless commands, the host
   must generate a fresh random ID per command, override any plugin descriptor
   value after environment merging, reuse it only for that command's
   validate-to-run flow, and never reuse it across commands.
6. Resolve data identity in this order:
   - `open_id` / `union_id`
   - enterprise email
   - account mapping table
   - user's own data account

## Default Data Workflow

Choose the data source before metadata discovery or SQL generation:

1. When the user explicitly names DLC, use `datasource=dlc`. When the user
   explicitly names ClickHouse, CK, or TChouse-C, use `datasource=tchouse-c`.
2. When the current user request does not name a data source, default to
   `datasource=tchouse-c`. Treat each new query request as a fresh source choice:
   a DLC choice from an earlier query or test must not leak into it. Only a
   clearly worded continuation of the same query may inherit its confirmed
   source.
3. Never rely on the tool schema's default data source when more than one data
   source is enabled. Select the source explicitly under rules 1-2, and never
   silently retry or fall back to a different source.

When the user describes a metric, topic, or business object instead of a table:

1. For `tchouse-c`, call `search_metadata_snapshot` first; never query the
   online metadata dictionary as an automatic fallback. Call
   `search_dlc_tables_for_user` only when the current request explicitly names
   DLC/WeData or is a clear continuation of an already confirmed DLC query.
   A business phrase, table nickname, or earlier DLC test is not evidence that
   the current request wants DLC. The CK snapshot is not a DLC discovery source.
2. Identify candidate tables, fields, partitions, and metric definitions.
3. Ask for clarification when the business scope, date range, region, or metric
   definition is ambiguous.
4. Generate SQL only after the table and口径 are clear.
5. Call `validate_sql_for_user` first.
6. Execute only read-only queries after validation succeeds. Follow the tools
   actually registered for this Bot:
   - when `deliver_query_result_for_user` is present, use it; rows, analysis,
     and files stay on the isolated result-Agent path. For analysis-only
     output, the tool returns only the internal result model's safe final
     markdown to the calling model; reply with that markdown once as the normal
     final response. Do not split query scope and result into separate messages
     and do not create a separate result-access card. When the handoff contains
     attachments, send them directly to the original group/topic/private chat
     with the same final reply, exactly as requested by the user;
   - when it is absent, this Bot is explicitly configured for single-model
     operation: use `run_query_for_user`; the calling model must create any
     requested file with its own artifact skill/tool. In this mode query rows
     enter the calling model context by design.
7. Pass the same byte-exact SQL string to validate and run. Use trimming only to
   reject blank input; do not normalize or reformat SQL between the two calls.
8. Keep SQL validation, account mapping, query execution limits, and audit on
   the Data MCP service side. Final artifact generation does not belong there.
9. Use the default `execution_mode=single` for normal work. Use `compare` only
   for an explicit before/after comparison that needs the exact same validated
   SQL twice; never attempt a third run or ask for a caller-defined run count.

When the user names a table directly:

1. For `tchouse-c`, inspect metadata and available fields through
   `search_metadata_snapshot` first.
2. For `dlc` with a fully qualified table, do not call
   `search_metadata_snapshot`. Generate read-only SQL from the confirmed table
   and filters, then call `validate_sql_for_user` with `datasource=dlc`. Service
   validation performs live DLC principal, table metadata, partition, engine,
   and table-permission checks before any query executes.
3. If the requested DLC partition cannot be expressed because its field is
   unknown, ask for the partition field or use the validation issue to correct
   the SQL. Do not guess a field and do not treat CK snapshot unavailability as
   a DLC query failure.
4. Check partitions and row scale before large reads.
5. Apply explicit date, region, and business filters.
6. Prefer small previews before exports.

## Result artifacts

1. Data MCP validates and executes the query once. It derives and query-plan-binds
   canonical projection/time/filter/grouping/unit-status/timezone-status context
   from validated SQL and the returned schema, then supplies it with rows to the internal
   result Agent; it never generates a final Excel, PDF, chart, or document.
   Decimal and 64-bit integer values must stay as exact strings across the
   ClickHouse JSON, Python HTTP, MCP, and isolated-Agent boundaries.
2. In dual-model mode, pass every requested output in `requested_outputs`. Never
   supply result context as a tool argument. The isolated internal result Agent
   must call `create_analysis`, `create_excel`, `create_pdf`, `create_chart`, or
   `create_document` itself. A requested output with no matching tool call
   fails closed.
3. If a result exceeds an artifact-tool limit, ask the user to narrow the query.
4. Results are replied to the original trusted Feishu conversation. In a group
   or topic, all members of that conversation can see the result and it remains
   in chat history. A later model turn can read it through Botmux history or
   quoted-message tools, so direct delivery is limited to synthetic test data
   until host-side filtering or the protected result-page flow is restored.
5. All artifacts from one request must bind values to the same protected rows
   and schema. The Agent chooses columns, aggregations, chart type, and layout,
   but tool arguments accept no free-text titles, paragraphs, labels,
   annotations, sheet names, filenames, or rewritten raw values. Controlled
   templates render all wording, and source-bound numeric claims use
   arbitrary-precision decimal computation.
6. When the user asks for one or more files, use `requested_outputs` in
   dual-model mode. In single-model mode, use the calling model's own artifact
   skill/tool after `run_query_for_user`.
7. When the user does not ask for a file, request only `analysis` and do not
   invoke artifact tools.
8. The plugin must validate that the staged file is a regular non-symlink below
   its own outbound directory, then delegate upload/routing to the exact bound
   Botmux session. Direct delivery is not deduplicated across repeated tool
   calls, so do not retry after an ambiguous receipt.
9. Treat `expires_at` as best-effort local retention metadata. Data MCP cleans
   expired export directories before later exports, but the plugin still deletes
   the staged local file after each delivery attempt.
10. DLC failures use the controlled `wedata-tencent-workflow` troubleshooting
    path. Validation returns bounded safe issue codes and suggested actions.
    Execution failures are classified from the trusted DLC task state and safe
    error evidence, then delivered as a deterministic failure card containing
    the stage, safe error code, retryability, plan/query identifiers, matching
    WeData case id when available, and the next diagnostic action. Never ask the
    user to paste raw DLC responses or credentials, never expose the upstream
    response body, and never retry an ambiguously completed plan.

## Safety Rules

1. Do not perform destructive operations: no `DROP`, `TRUNCATE`, `DELETE`,
   partition deletion, or irreversible writes.
2. CK grants are SQL generation only; do not execute authorization writes.
3. Default to read-only `SELECT`.
4. Reject or ask for review on external table functions, network access
   functions, or SQL that cannot be confidently classified as read-only.

## Plugin Tool Boundary

The plugin MCP server exposes:

- `data_mcp_identity_probe`: diagnostic only, returns the trusted identity source visible to the plugin (`gateway_meta` or `trusted_turn_fallback`) without trusting model arguments.
- `data_mcp_query_plan`: plan-only helper; does not execute database access.
- `validate_sql_for_user`: forwards explicit SQL and trusted identity to the Data MCP service for read-only validation; `execution_mode` is limited to `single|compare`.
- `run_query_for_user`: returns the bounded result only in explicitly configured
  single-model mode; in dual-model mode it is fail-closed.
- `deliver_query_result_for_user`: executes one validated plan once, gives
  rows/schema/context to the internal result Agent, and delivers Agent-authored
  analysis and requested Excel/PDF/chart/document artifacts.
  `response_mode=model_handoff` returns `final_markdown` authored by the internal
  result model plus zero or more attachment paths. The calling model must send
  the markdown once as its normal final reply and attach every returned file
  directly to the original group/topic/private chat with `botmux send --files`.
  Keep result and query scope together. Never replace the response with a
  protected result-access or download-entry card.
- `continue_query_result_for_user`: use for an unambiguous follow-up about the
  current caller-bound result without querying again. Pass only the user's
  follow-up text and explicit `requested_outputs`. Never invent or pass a
  result id, user identity, app id, or session id. If it returns a fixed
  no-active-result status, treat the request as a new query. If the request is
  ambiguous, ask the user once and default to the new-query workflow.

`deliver_query_result_for_user` and `continue_query_result_for_user` are not
registered at all in single-model mode. Tool availability, not model-authored
arguments, is the authoritative mode signal.
- `refresh_metadata_snapshot`: accepts no model arguments and forwards only a host-injected `schedule_creator` owner/task/app identity to refresh the fixed dictionary snapshot.
- `search_metadata_snapshot`: searches the verified signed current snapshot for candidate tables, fields, partitions, and definitions; snapshot failures stop the workflow and never fall back online.
- `inspect_ck_subjects_by_table`: returns bounded access holders for explicit tables from the caller's configured entry point.
- `inspect_ck_resources_by_subject`: returns bounded resources for explicit accounts/roles and includes direct/inherited members for requested roles.
- `audit_ck_default_role_baseline`: schedule-only default-role baseline using the task creator's trusted identity.

All three inspection results are explicitly marked `scope=single_endpoint`: they describe the entry-point node view, not cluster-global fact. The deployment union-id allowlist applies only to these three tools. It must not gate normal query, export, metadata refresh, or metadata search tools. A trusted `schedule_creator` turn with an owner identity may use the tools; ownerless scheduled/CLI work must fail closed.

For scheduled data access, trusted identity and turn provenance must agree: `callerSource=schedule_creator` requires `turnId=schedule:<taskId>:<turn>` with an exact task-id match, while any `schedule:` turn without `schedule_creator` is rejected. Do not retry or rewrite a rejected mismatched turn; wait for an isolated turn or use a separate topic session.

The plugin itself must not implement business SQL parsing beyond basic required
argument checks. If the Data MCP service is unavailable or trusted identity is
missing, fail closed.
