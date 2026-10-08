# Amber → Data MCP 受信调用

## 范围

第一期只开放 `POST /amber/query`，请求体固定为：

```json
{"sql":"SELECT ...","datasource":"tchouse-c"}
```

请求体不接受 `sub`、union_id、open_id、app_id、chat、run 等身份字段。用户身份
只取自 `Authorization: Amber <JWS>` 中经过固定公钥验证的 `sub`。入口只执行现有
Data MCP 的只读 SQL guard、本人账号解析、权限探测和查询链路；不开放导出、权限
审计、元数据刷新和内部 `/agent/*` 接口。

## 进程与信任边界

- `ksher-agent-data-amber-api` 是独立进程，只绑定 `127.0.0.1`，只挂载
  `/health` 和 `/amber/query`。
- 原 Data MCP API 继续使用私有 Unix Socket；不得把内部 token 交给 Amber，也不得
  让 Amber 脚本访问 `/agent/*`。
- Amber 公钥必须由部署方离线导出，通过受控部署记录交付并按 `kid` 核对。Data MCP
  只读配置文件中的固定 JWKS；未知 `kid` 直接拒绝，运行时不访问 Amber 的 7341
  端口或其它公钥地址。
- 当前若 Amber 与其它 bot 同属一个 OS 用户，则凭证只能证明“来自该主机上的该
  用户”，不能证明“来自 Amber 进程”。正式登记服务前必须由负责人明确接受这一
  风险；生产环境应使用独立服务用户或等价的进程身份/密钥隔离。

## JWS 契约

只接受 `alg=EdDSA`、`typ=JWT`、JWKS 中已固定的 `kid`，并校验以下 claim：

| claim | 约束 |
| --- | --- |
| `iss` | 与 `DATA_MCP_AMBER_ISSUER` 一致，默认 `amber` |
| `aud` | 与 `DATA_MCP_AMBER_AUDIENCE` 一致，默认 `data-mcp` |
| `sub` | Amber 当前真实用户的 `union_id`，必须以 `on_` 开头 |
| `cmd` / `rev` / `run` / `chat` | 必填审计字段；`chat` 不参与权限判断 |
| `channel` | `bot`、`web`、`agent`、`schedule`，可带 `.trial` |
| `iat` / `exp` | 短时凭证；默认最大寿命 300 秒，时钟偏差默认 30 秒 |
| `jti` | 每张凭证独立；Data MCP 持久化后仅允许消费一次 |
| `call_index` / `call_count` | 1-based，`call_count` 为 1–20 |

Data MCP 不要求 token 按序消费，也不要求全部用完；每张 token 各自最多使用一次。
同一请求中先持久化消费 `jti` 和审计记录，再执行 validate→run。SQL 原文在两步间
必须逐字一致，query plan 同时绑定 `sub`、`run` 对应的 session 和部署侧固定的
`trust_domain`。

渠道策略：`schedule` / `schedule.trial` 使用 `sender_type=bot` 和独立的
`schedule_creator + task_id` 来源，不伪装成在场真人，并按用户每分钟的新 run 数限流；同一
run 的多张调用凭证只计一次。所有
`.trial` 渠道把 SQL 输出上限收紧到 `DATA_MCP_AMBER_TRIAL_MAX_ROWS`。默认定时上限
为每用户每分钟 10 次，试运行输出上限为 20 行。

审计检索不要只按 `caller_source=amber`：定时执行的 caller_source 必须是
`schedule_creator`。统一检索 Amber 调用应使用 `trust_domain` 加非空
`amber_channel`，再按 `amber_channel` 区分交互、试运行和定时。

## 持久化与审计

`DATA_MCP_AMBER_STATE_DB` 同时保存防重放状态与 Amber SQL 审计。目录启动时收紧为
0700，数据库文件为 0600。普通结构化日志只记录 SQL hash、命令/版本/run、调用序号
和 `jti` 的 hash 引用，不记录 token、真实 `jti` 或 SQL 原文。

实际执行的完整 SQL 使用 AES-256-GCM 加密后写入受限审计表。密钥由
`DATA_MCP_AMBER_AUDIT_KEY_FILE` 指定，文件必须已经存在、是普通文件且权限不宽于
0600；文件内容只接受 32 个随机字节的 URL-safe Base64 编码，不接受原始文本、
hex 或二进制。密钥不能提交到 Git，也不能
放进 Amber 脚本、模型上下文或普通日志。密钥轮换和审计解密访问须通过部署/安全
流程另行留痕。

## 配置与启动

```bash
export DATA_MCP_AMBER_ENABLED=true
export DATA_MCP_AMBER_JWKS_FILE=/restricted/amber-jwks.json
export DATA_MCP_AMBER_STATE_DB=/restricted/data-mcp/amber-state.db
export DATA_MCP_AMBER_AUDIT_KEY_FILE=/restricted/data-mcp/amber-audit.key
export DATA_MCP_AMBER_TRUST_DOMAIN=dev-beta:ksher-user
export DATA_MCP_AMBER_REPLAY_GRACE_SECONDS=120
export DATA_MCP_AMBER_TRIAL_MAX_ROWS=20
export DATA_MCP_AMBER_SCHEDULE_MAX_RUNS_PER_MINUTE=10
ksher-agent-data-amber-api
```

进程在绑定端口前校验固定公钥、审计密钥和状态库；任何一项缺失或权限不安全都
启动失败。防重放保留时长必须至少比验签时钟偏差多 60 秒，避免过期边界上的
跨秒竞态。不要把真实内部路径、密钥、数据库凭证或 token 写回仓库。

## 验收

- Amber 停止且 7341 被其它进程占用时，伪造公钥/凭证仍被拒绝。
- 同次执行签发的 N 张凭证各自只能成功一次；重复使用任意 `jti` 返回 409。
- 缺失/伪造身份、未知 `kid`、错误签名、错误 `iss/aud`、过期/超长凭证均拒绝。
- 请求体夹带任何身份字段返回 422，且不会消费 token。
- 非只读 SQL 仍由现有 guard 拒绝；校验失败后 token 也不能再次使用。
- 审计表能按 `audit_id` 关联完整加密 SQL；数据库原始内容和普通日志中看不到 SQL
  原文。
- 原 BotMux stdio、内部 API、single/compare query plan 全量回归通过。
- 登记真实服务、改线上配置或重启之前，完成审批、风险接受和回滚方案。
