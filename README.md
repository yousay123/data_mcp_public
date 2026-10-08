# Data MCP

面向 AI Agent 的只读数据访问 MCP 服务。项目提供身份绑定、SQL 安全检查、查询限额、元数据快照、审计与 BotMux/Kai 接入能力；仓库本身不包含任何数据库地址、账号、密码或组织内部配置。

## 安全模型

- 运行时身份必须由可信网关注入，不能接受模型或普通消息自行声明的用户身份。
- 数据库连接、凭证解析 SQL、元数据来源表等部署参数只通过本机环境或密钥管理系统提供。
- 默认只允许只读查询，并限制行数、扫描量、内存、并发与超时。
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
set -a
. ./.env
set +a
ksher-agent-data-mcp
```

`.env` 已被 Git 忽略。真实环境建议由部署平台直接注入变量，不要把凭证落入源码目录。

## 私有配置

接入真实数据源时，至少需要根据部署方式配置以下变量：

- `TCHOUSE_C_JDBC_BASE_URL`：只读查询入口。
- `TCHOUSE_D_JDBC_URL`、`TCHOUSE_D_USERNAME`、`TCHOUSE_D_PASSWORD`：可选的凭证映射数据源。
- `TCHOUSE_D_CREDENTIAL_SQL`：部署方自定义的参数化 SQL，接收一个 `union_id` 参数，并将结果列命名为 `tchouse_account` 与 `tchouse_password`。
- `DATA_MCP_METADATA_SNAPSHOT_TABLE`：元数据快照来源，格式必须为 `database.table`。

完整配置项参见 [.env.example](.env.example)。生产账号应遵循最小权限原则，并由人工或密钥管理系统配置。

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
