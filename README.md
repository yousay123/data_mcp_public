# Data MCP

面向 AI Agent 的只读数据访问 MCP 服务。项目提供身份绑定、SQL 安全检查、查询限额、元数据快照、审计与 BotMux/Kai 接入能力；仓库本身不包含任何数据库地址、账号、密码或组织内部配置。

## 安全模型

- 运行时身份必须由可信网关注入，不能接受模型或普通消息自行声明的用户身份。
- 数据库连接、凭证解析 SQL、元数据来源表等部署参数只通过 host-only
  配置文件或密钥管理系统提供。数据库密码和内部鉴权令牌不得放进进程环境或启动参数。
- 默认只允许只读查询，并限制行数、扫描量、内存、并发与超时。
- Excel 导出目录会原子写入 `receipt.json` sidecar，记录可信调用身份、请求/执行 SQL
  哈希、查询与文件摘要及数据版本状态。当前默认数据版本提供方为 `unavailable`，
  不会伪造快照版本；需要同版本批处理的消费端必须 fail-closed。
- sidecar 的当前信任边界是防止受控只读沙盒伪造，不提供共享 outbox 内的文件读取隔离。
  跨身份文件机密性需要另行采用服务端鉴权读取或独立目录隔离。
- 示例地址使用保留域名，示例账号和密码只用于测试，不能用于生产。
- 不要把 `.env`、私有 launcher、wheel、查询结果或审计日志提交到 Git。

## 本地开发

需要 Python 3.11+。

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[dev]'
pytest
```

启动本地 dry-run 服务前，复制示例配置并按需修改：

```bash
cp .env.example .env
KSHER_AGENT_DATA_MCP_ENV_FILE="$PWD/.env" ksher-agent-data-mcp
```

`.env` 已被 Git 忽略。本地命令只把配置文件路径放进环境；不要 `source` 该文件，
否则密码和内部令牌会被复制进进程环境。生产配置应放在模型沙盒不可读的
host-only 路径（默认 `~/.config/ksher-agent-data-mcp/env`），不要把凭证落入源码目录。

## 私有配置

接入真实数据源时，至少需要根据部署方式配置以下变量：

- `TCHOUSE_C_JDBC_BASE_URL`：只读查询入口。
- `TCHOUSE_D_JDBC_URL`、`TCHOUSE_D_USERNAME`、`TCHOUSE_D_PASSWORD`：可选的凭证映射数据源。
- `TCHOUSE_D_CREDENTIAL_SQL`：部署方自定义的参数化 SQL，接收一个 `union_id` 参数，并将结果列命名为 `tchouse_account` 与 `tchouse_password`。
- `DATA_MCP_METADATA_SNAPSHOT_TABLE`：元数据快照来源，格式必须为 `database.table`。

完整配置项参见 [.env.example](.env.example)。生产账号应遵循最小权限原则，并由人工或密钥管理系统配置。
导出 sidecar 的字段、原子发布顺序与信任边界见
[`docs/export-receipt.md`](docs/export-receipt.md)。

### 可配置数据源与腾讯云 DLC

`DATA_MCP_ENABLED_DATASOURCES` 是逗号分隔的数据源注册表。默认仅启用
`tchouse-c`；当前还实现了 `dlc` 适配器。新增 TCHouse-D、MySQL 等数据源时，
应增加独立的身份解析、元数据、SQL 方言和执行适配器，不能复用另一个数据源的
权限判断。

DLC 入口只接受 BotMux 注入的可信身份，并从 host-only 文件按 `union_id` 取 CAM UIN。
映射文件可由人工维护的飞书多维表格导出，
但运行时只读取本机私有快照，不向模型暴露 CAM UIN。每条记录必须显式标记
`enabled=true`（或 `status="启用"`），空白/停用记录拒绝使用；同一 `union_id` 对应多个
UIN、或同一 UIN 对应多个 `union_id` 时服务启动失败。解析后再查询该主体的 DLC 数据权限和
引擎权限；模型不能提交或覆盖 CAM UIN。执行前会按当前权限重新检查 SQL 涉及的表。

腾讯云鉴权可选隔离更强的本机 `signer`（长期密钥不进入 Data MCP），或
`skill_tc_call` 复用配置的 WeData Skill `scripts/tc_call.py`，并沿用该 Skill 已有的
凭据选择（现有签名通道或环境变量回退），Data MCP 不再实现或配置另一套签名逻辑。
部署机把 Skill 凭据放在交互式 zsh 配置中时，可使用
`DATA_MCP_DLC_TC_CALL_ENV_MODE=zsh_interactive`；Data MCP 只启动 Skill 脚本，不读取、
保存或回传云密钥。
SQL 请求载荷通过权限为 600 的临时文件交给 Skill 脚本，不进入进程命令行、MCP 参数或
模型上下文。首版 DLC 适配限定 `ap-hongkong`、只读 SELECT、显式数据库/引擎配置。WeData
ProjectId 不参与 DLC 查询；`DATA_MCP_DLC_PROJECT_ID` 仅为可选审计标签。若主体带有
尚未安全支持的行级过滤或数据脱敏策略，服务会 fail-closed，不会用签名代理的服务
身份绕过细粒度策略。

## Amber 受信调用入口

Amber 可通过独立的 loopback HTTP 进程调用只读 `/amber/query`，不复用内部
`/agent/*` 接口或内部 token。入口默认关闭；固定公钥、一次性凭证、防重放、
渠道限流和加密 SQL 审计的完整配置见
[`docs/amber-integration.md`](docs/amber-integration.md)。

## 部署与更新

其他使用者可以从本仓库拉取固定 tag 或 commit，在各自环境构建并部署：

```bash
git clone https://github.com/yousay123/data_mcp_public.git
cd data_mcp_public
git checkout <tag-or-commit>
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[dev]'
pytest
python -m pip wheel --no-deps . -w dist
```

升级时先在独立目录验证新版本，再替换运行版本。部署者负责在本机重新提供私有配置；代码更新不会自动同步或覆盖凭证。

## 目录

- `src/ksher_agent_data_mcp/`：MCP 服务与安全控制核心。
- `tests/`：Python 回归测试。
- `java-gateway/`：Java 网关组件。
- `botmux-plugin-data-mcp/`：BotMux 插件描述与校验脚本。
- `kai/`：Kai 启动入口示例。

## 许可证

当前仓库尚未声明开源许可证。在许可证确定前，公开可见不等于获得复制、修改或再分发授权。
