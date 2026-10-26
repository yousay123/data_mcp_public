# Internal result Agent flow

The dual-model delivery path has one owner for each responsibility:

1. The calling Codex generates SQL and confirms metric, time range, filters,
   grouping, unit, and timezone.
2. Data MCP validates permissions and read-only policy, then executes the
   approved SQL exactly once.
3. Data MCP passes the bounded `rows`, `schema`, limit/quality manifest, and
   confirmed result context to the private-network result Agent.
4. The result Agent interprets the requested output types and calls its own
   `create_excel`, `create_pdf`, `create_chart`, or `create_document` tools.
5. Artifact tools bind values to the same protected rows and schema. The Agent
   chooses filenames, structure, and source columns but cannot supply rewritten
   raw values in tool arguments.
6. The plugin stages the artifacts, the trusted delivery layer verifies the
   caller/session/app binding, and Botmux sends them to the signed Lark turn.
7. The calling model receives only a fixed delivery receipt. Rows, model text,
   filenames, paths, and file bytes do not cross that boundary.

`continue_query_result_for_user` reuses the caller-bound stored result and does
not rerun SQL. This keeps analysis and all follow-up artifacts on one snapshot.
Requested file types require exactly one matching Agent tool call; missing,
duplicate, extra, oversized, or invalid tool output fails closed. Data MCP does
not expose or call a final-file export endpoint in either mode. In single-model
mode, the calling model receives the bounded query result and uses its own
artifact skills.
