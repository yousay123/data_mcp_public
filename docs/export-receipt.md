# Excel export receipt contract

Every successful Excel export is published under one service-created directory:

```text
<outbox>/export-<32 lowercase hex>/
  <sanitized filename>.xlsx
  receipt.json
```

The directory name is the `export_id`. The workbook is written through a
same-directory temporary file and atomically renamed first. `receipt.json` is
written and atomically renamed last, so its presence with `status=complete` is
the commit marker. If receipt publication fails, the service removes the whole
export directory and returns an error.

## Receipt schema version 1

The receipt records:

- trusted caller binding: `union_id`, `lark_app_id`, `sender_type`, `task_id`,
  `session_id`, `turn_id`, and `caller_source`;
- query binding: `query_id`, `requested_sql_sha256`,
  `executed_sql_sha256`, and `tables`;
- artifact binding: `export_id`, `filename`, `row_count`, `file_bytes`,
  `file_sha256`, `truncated`, and `file_expires_at`;
- execution evidence: `read_rows`, `read_bytes`, `execution_ms`, and
  `generated_at`;
- version evidence: `source_version`, `source_version_provider`,
  `source_version_status`, `source_version_nodes`, and
  `source_version_captured_at`; `expected_source_version` records the caller's
  requested batch version when present.

`snapshot_version` is always `null` in schema version 1. The service does not
claim transactional snapshot semantics.

The two SQL hashes have different consumer semantics:

- recompute `requested_sql_sha256` from the exact SQL bytes submitted with the
  export plan and require an exact match;
- retain `executed_sql_sha256` as the service's attestation of the normalized
  SQL sent to the executor and cross-check it with service audit when needed.
  The service may add or normalize a `LIMIT`, so consumers must not require the
  requested and executed hashes to be equal. Schema version 1 does not expose
  the executed SQL text or promise a client-reproducible rewrite algorithm.

The default source-version provider reports `status=unavailable` and a null
version. A consumer that needs a same-version multi-query batch must reject
that receipt. When a caller supplies `expected_source_version`, the service
checks it before and after query execution and rejects unavailable, changed, or
mismatching observations without publishing an export.

## Trust boundary

The sidecar is tamper evidence only when the consuming sandbox can read but
cannot write the outbox. It does not provide confidentiality between identities
that can read the same outbox. A consumer must still compare all caller fields
with its host-owned expected identity and fail closed on any mismatch.

Cross-identity file confidentiality requires a separate authenticated read API
or sandbox-isolated outbox roots and is outside schema version 1.

## Deployment gate

The Data MCP service itself must be able to write the outbox, so it cannot prove
the consumer sandbox is read-only. Before enabling a sidecar consumer, the
deployment operator must run the consumer under its real sandbox profile and
verify that all of these outbox operations fail: create, overwrite, append,
rename, delete, symbolic link, hard link, create directory, chmod, and remove
directory. The probe result belongs to the deployment evidence. A consumer
must also fail closed at runtime when its configured read-only self-check or
the recorded deployment gate is absent.
