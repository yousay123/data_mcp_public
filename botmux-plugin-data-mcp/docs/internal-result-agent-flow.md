# Internal result Agent flow

The dual-model delivery path has one owner for each responsibility:

1. The calling Codex generates SQL and confirms metric, time range, filters,
   grouping, unit, and timezone.
2. Data MCP validates permissions and read-only policy, then executes the
   approved SQL exactly once. ClickHouse JSON transport forces quoted Decimal
   and 64-bit integer output; Python also preserves unquoted float tokens as a
   defensive fallback, so values do not round before reaching the Agent.
3. Data MCP derives canonical context from validated normalized SQL, binds it to
   the query plan, adds the returned schema, and attaches an integrity digest.
4. The MCP server passes bounded `rows`, `schema`, limit/quality manifest, and
   canonical context over bounded stdio IPC to a separate private-network Agent
   child process with an allowlisted environment.
5. The result Agent interprets the requested output types and calls its own
   `create_excel`, `create_pdf`, `create_chart`, or `create_document` tools.
6. Artifact tools bind values to the same protected rows and schema. The Agent
   chooses columns, aggregations, chart type, and layout but cannot supply raw
   values or any free-text title, paragraph, label, annotation, sheet name, or
   filename. Controlled templates render every word. Numeric claims declare a
   source column and aggregation and are calculated with arbitrary-precision
   decimal arithmetic, preserving the source Decimal scale and deterministic
   average rounding.
7. The Agent process stages the artifacts, the trusted delivery layer verifies the
   caller/session/app binding, and Botmux sends them to the signed Lark turn.
8. The calling model receives only a fixed delivery receipt. Rows, model text,
   filenames, paths, and file bytes do not cross that boundary.

`continue_query_result_for_user` reuses the caller-bound stored result and does
not rerun SQL. This keeps analysis and all follow-up artifacts on one snapshot.
Requested output types require exactly one matching Agent tool call; missing,
duplicate, extra, oversized, or invalid tool output fails closed. The plugin does
not expose or call a final-file export endpoint in either mode. In single-model
mode, the calling model receives the bounded query result and uses its own
artifact skills.
