# Kai 接入

本目录提供 Kai MCP manifest 与本机 launcher 示例。仓库只保存固定启动入口；数据库连接、账号、密码和部署路径应保存在使用者机器或密钥管理系统中。

## 准备本机 launcher

```bash
mkdir -p ~/.config/ksher-agent-data-mcp
chmod 700 ~/.config/ksher-agent-data-mcp

cp kai/launcher.sh ~/.config/ksher-agent-data-mcp/launcher.sh
chmod 700 ~/.config/ksher-agent-data-mcp/launcher.sh

cp .env.example ~/.config/ksher-agent-data-mcp/env
chmod 600 ~/.config/ksher-agent-data-mcp/env
```

编辑私有 `env` 文件，填入当前部署环境需要的连接参数与凭证。不要把该文件复制回仓库。

默认 launcher 路径是：

```bash
launcher="${KSHER_AGENT_DATA_MCP_LAUNCHER:-$HOME/.config/ksher-agent-data-mcp/launcher.sh}"
exec "$launcher"
```

## 安装

将 `<team-slug>` 与 `<version>` 替换为实际 Kai 团队和已发布版本：

维护者发布 manifest 时可使用：

```bash
kai publish mcp/<team-slug>/ksher-agent-data-mcp@<version> \
  --manifest kai/mcp.manifest.json \
  --team <team-slug> \
  --visibility internal
```

使用者安装已发布版本：

```bash
kai install mcp/<team-slug>/ksher-agent-data-mcp@<version> \
  --scope project \
  --yes
```

Kai 安装不会替代本机私有配置，也不会自动注册 BotMux plugin descriptor。BotMux 部署仍需按其插件规范配置沙箱、身份注入与私有环境变量。

## 构建本地 wheel

建议从固定 tag 或 commit 构建，验证后再交给 launcher 使用：

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[dev]'
pytest
python -m pip wheel --no-deps . -w dist
```

如 wheel 不在 launcher 默认目录，可在私有 `env` 中设置：

```bash
KSHER_AGENT_DATA_MCP_PACKAGE_REF='/absolute/path/to/package.whl'
```

生产部署应固定版本并保留回滚包；不要从浮动分支直接更新运行中的服务。
