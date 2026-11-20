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
   `create_analysis`, `create_excel`, `create_pdf`, `create_chart`, or
   `create_document` tools.
6. Artifact tools bind values to the same protected rows and schema. The Agent
   authors question-specific Markdown only through `create_analysis`; the tool
   rejects unsupported numeric statements and appends the source-bound detail
   table and compact query scope. Other artifact tools cannot accept raw values
   or free-text titles, paragraphs, labels, annotations, sheet names, or
   filenames. Numeric claims declare a source column and a summary or
   ordered-series operation (including latest, interval change, labelled
   extrema, and largest adjacent change) and are calculated with
   arbitrary-precision decimal arithmetic, preserving the source Decimal scale
   and deterministic average rounding.
7. Charts are rendered inline as Feishu-native Vega-Lite card content. The
   Agent process stages only requested file artifacts, the trusted delivery
   layer verifies caller/session/app binding, and Botmux sends the result to the
   signed Lark turn.
8. The calling model receives only a fixed delivery receipt. Rows, model text,
   filenames, paths, and file bytes do not cross that boundary.

`continue_query_result_for_user` reuses the caller-bound stored result and does
not rerun SQL. This keeps analysis and all follow-up artifacts on one snapshot.
Requested output types require exactly one matching Agent tool call; missing,
duplicate, extra, oversized, or invalid tool output fails closed. The plugin does
not expose or call a final-file export endpoint in either mode. In single-model
mode, the calling model receives the bounded query result and uses its own
artifact skills.
