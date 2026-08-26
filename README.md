# 📰 dsh-rss-daily

> **一句话：每天早上 8 点，dsh 自动给你端上一份主编级的要闻日报** —— 用你已经配好的模型编辑、送到你的微信 / Telegram，还会像一条普通回复一样出现在对话里（不占任何上下文）。

[![npm](https://img.shields.io/npm/v/dsh-rss-daily)](https://www.npmjs.com/package/dsh-rss-daily)
[![npm downloads](https://img.shields.io/npm/dw/dsh-rss-daily)](https://www.npmjs.com/package/dsh-rss-daily)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![CI](https://github.com/shangjian2023/dsh-rss-daily/actions/workflows/ci.yml/badge.svg)](https://github.com/shangjian2023/dsh-rss-daily/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[English README](README.en.md)

## 长什么样

日报**直接出现在你的对话里，样式和模型回答一模一样** —— 纯 markdown 排版、同样的字体和宽度：

![对话内日报](docs/in-chat.png)

它是纯前端渲染：**只显示，不写会话记录、不发给模型**，你的上下文干干净净。

## 为什么值得装

- **像主编选的，不是聚合器堆的。** ~20 条候选先打分（源等级 × 时效 × 信号词）、去重（Jaccard + 14 天 MD5 历史）、多源事件图谱交叉验证，最后交给 **dsh 里你已配好的模型**做主编：合并同事件、剔除 PR 通稿、平衡选题（同话题 ≤2 条）、每条浓缩成一句 ≤45 字的具体事实。
- **零额外 API key。** 编辑这步走 `ctx.llm`，用 dsh 现成的模型，不多花一分钱、不多配一个密钥。
- **永不断更。** 模型调用失败自动降级规则模式照常出稿；错过定时段落，开机 12 小时内自动补跑。
- **送到你读的地方。** Server酱 / PushDeer / 企业微信 / Telegram / Bark / gotify / 自定义 webhook，任一成功即算送达。
- **生产级管线。** 移植自 2026 年 6 月起每天在生产环境运行、迭代过 9 版的私人脚本：源健康度自适应超时、feed 乱码修复、短摘要抓原文补全、420 秒硬预算、幂等两阶段送达（fetch → outbox → 投递 → confirm）。

## 安装（npm 推荐）

```sh
# npm（推荐，无 git 克隆、无构建脚本）
dsh plugin --profile web add dsh-rss-daily

# 或 GitHub
dsh plugin --profile web add github:shangjian2023/dsh-rss-daily
```

重启 `dsh web`：每个会话头部出现 **📰** 按钮，定时任务即刻生效。

**30 秒配好：**

1. 点任意会话头部的 **📰** 按钮 → **设置** 标签
2. 改时间、加一个投递目标（Server酱 / PushDeer / 企微 / Telegram / Bark / gotify / 自定义）
3. 点 **获取今日日报** —— 立刻生成、立刻投递、立刻出现在对话里

不用碰任何 YAML —— 时间、目标、源、条数、模型，全部在面板里改，即时生效。

## 亮点

- 🖥 **三个界面，零上下文消耗**：对话内插播、📰 面板（日报 / 源 / 设置）、设置页卡片 —— 全部客户端渲染，永不进会话日志
- 📝 **插播即模型回答的原样**：日报正文用宿主同款 `MarkdownText` 渲染组件（与真实 assistant 消息同一组件、同一套样式），上屏时以打字机节奏渐显、完稿前不显示操作行——看起来就是模型在作答，但一个 token 的上下文都不占
- 🧰 **46 个精选源**，覆盖科技 / 科学 / 国际 / 财经 / 人文 / 开发，从中国大陆实测可达；源标签页里随意增删停启（连续失败 3 次的源自动降级 24 小时后轮换回来）
- 🤖 **`rss_daily` 对话工具** —— `run` / `status` / `redo` / `deliver`，直接吩咐 agent "生成今天的新闻日报"也行
- 🔌 **无界面模式** —— `py/daily.py` 可脱离 dsh 独立跑，对接任意 OpenAI 兼容端点：

  ```sh
  RSS_LLM_ENDPOINT=https://api.deepseek.com/v1 RSS_LLM_KEY=sk-... \
    python py/daily.py --state-dir ~/.rss-daily
  ```

## 配置

默认值开箱即用，面板覆盖一切。主要开关：

| 键 | 默认 | 含义 |
|---|---|---|
| `time` | `08:00` | 每天本地 HH:MM 运行（错过 <12h 开机补跑）。日报标题日期按北京时间（UTC+8）计算 |
| `targets[]` | `[]` | 投递目标；≥1 个成功即算送达 |
| `digestItems` | `8` | 每日最多条数 |
| `llmMode` | `harness` | `harness`（用 dsh 的模型）或 `none`（仅规则） |
| `broadcast` | `true` | 对话内插播开关 |
| `stateDir` | `~/.dsh/rss-daily` | 源 / 去重历史 / outbox 目录 |

进阶用户也可以在 profile 的 `cordis.patch.yml` 里覆盖配置行；HTTP API 与管线阶段见下文。

## 工作原理

```
46 源 ──▶ 抓取(健康度/超时/去重) ──▶ ~20 条候选
                                          │
                        ctx.llm 主编编排(失败降级规则模式)
                                          │
                            日报 ──▶ webhook 投递 ──▶ confirm
                                          │
                          对话内插播(纯前端,零上下文)
```

`py/daily.py` 可独立脚本化（`--stage fetch|finalize|confirm|status`，stdout 输出单行 JSON），插件本体驱动的就是这些阶段。**送达成功前绝不 confirm** —— 确认过的条目会永久进入 14 天去重窗口。

## HTTP API（进阶）

同源 API `/rss-daily/api/*`（仅带 webserver 的 profile 注册）：`GET status`、`POST run`、`POST redo`、`GET/PUT sources`、`POST config`。投递目标里的密钥在响应中打码；写回时带打码值的字段保留原值。所有写入先过字段白名单校验再落盘。

## 依赖

- dsh，使用 `web`（或任意常驻）profile
- Python 3.9+ 且装了 `feedparser`：`pip install feedparser`
- Node.js ≥ 18（dsh 自带）

## 许可

MIT
