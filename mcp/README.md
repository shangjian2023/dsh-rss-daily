# rss-daily MCP Server

把 `py/daily.py` 分阶段管线暴露为 [MCP](https://modelcontextprotocol.io) 工具，
Claude Code / Codex / opencode / Cursor 等任何 MCP 客户端都能调用。
架构与 dsh 插件一致：领域逻辑全在 `py/daily.py`，本目录只做传输。

宿主 agent 既是**编辑 LLM**（按 fetch 返回的 prompt 挑选改写），也是**投递渠道**
（把日报展示给用户即视为送达）。

## 工具

| 工具 | 作用 |
|------|------|
| `rss_status` | 只读查状态；候选已抓未编辑时带出 prompt |
| `rss_fetch` | 抓源出编辑提示词；分钟级长任务，超 20s 转 RUNNING，轮询 `rss_status` |
| `rss_finalize` | 把编辑回复落稿（`reply` 传你的编辑结果；`rule=true` 规则版；`redo=true` 重生成） |
| `rss_confirm` | 用户看过日报后确认送达（写幂等门，dsh 插件/cron 共享） |

依赖：`pip install mcp feedparser`

## 各客户端配置

**Claude Code**（用户级，一次配好所有项目）：

```bash
claude mcp add --scope user rss-daily -- python "D:\edge默认下载\dsh-rss-daily\mcp\server.py"
```

**Codex**（`~/.codex/config.toml`）：

```toml
[mcp_servers.rss-daily]
command = "python"
args = ['D:\edge默认下载\dsh-rss-daily\mcp\server.py']
```

**opencode**（项目 `opencode.json` 或 `~/.config/opencode/opencode.json`）：

```json
{
  "mcp": {
    "rss-daily": {
      "type": "local",
      "command": ["python", "D:\\edge默认下载\\dsh-rss-daily\\mcp\\server.py"]
    }
  }
}
```

**调试**：`npx @modelcontextprotocol/inspector python mcp/server.py`

## 状态目录与并发

- 默认 `~/.dsh/rss-daily`，与 dsh 插件**共享**：幂等门（`rss-sent.json`）互认，
  谁 confirm 了当日，另一边自动跳过；`.rss.lock` 互斥，两边同时抓取会得到 LOCKED。
- 隔离测试：环境变量 `RSS_DAILY_STATE_DIR=<目录>` 重定位（源配置缺失会自动播种）。

## 长任务约定

`rss_fetch` 默认内联等待 20s（客户端默认工具超时 30s 内），没跑完返回 `RUNNING`。
**之后只能轮询 `rss_status`**——重复调 `rss_fetch` 会全量重抓。
抓取完成后 outbox 落盘 prompt，`rss_status` 自动带出。
