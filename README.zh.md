# dsh-rss-daily

[dsh](https://github.com/deepseek-ai/deepseek-harness) 插件:每天早上把一份**精选要闻日报**推到你的 IM——46 个精选 RSS 源,覆盖科技/科学/国际/财经/人文/开发。

它和普通 RSS 阅读器的区别:

- **主编,不是聚合器。** 候选池(~20 条)先打分(源 tier × 时效 × 信号词)、去重(Jaccard + MD5 历史)、再经多源事件图谱交叉验证(newsflash,≥3 家独立媒体佐证),最后交给 **dsh 里已配置的模型**做编辑:合并同事件、剔除 PR 通稿和周刊盘点、选题平衡(同 tag ≤2 条)、每条写一句 ≤45 字的具体事实(英文新闻中文表述)。
- **零额外 LLM 凭据。** 编辑这一步走 `ctx.llm`,用你 dsh 现成的模型;模型调用失败自动降级规则模式,日报永不断供。
- **送到你读的地方。** webhook 推送:Server酱 / PushDeer / 企业微信机器人 / Telegram / Bark / gotify / 自定义 JSON 端点。
- **生产级管线。** 移植自一条 2026 年 6 月起每天在生产环境运行、迭代过 9 版的私人管线:源健康度自适应超时、feed 编码乱码修复、短摘要抓原文补全、420s 硬预算、幂等两阶段送达(fetch → outbox → 投递 → confirm)、14 天去重窗口。

## 依赖

- dsh,使用 `web`(或任意常驻)profile
- Python 3.9+ 且装了 `feedparser`:`pip install feedparser`
- Node.js ≥ 18(dsh 自带)

## 安装

一条命令——`dsh plugin add` 会用 pnpm 装包并自动追加进 profile 的 `dsh.profile.bundles`,插件行由本包自带的 `cordis.patch.yml` 提供:

```sh
dsh plugin --profile web add github:shangjian2023/dsh-rss-daily
```

重启 `dsh web`,定时任务即生效。本地开发:`dsh plugin --profile web add /绝对路径/dsh-rss-daily`(pnpm 以 link 方式挂载;先在仓库里跑一次 `pnpm install`)。

## 配置

改配置:在 profile 的补丁层(`$DSH_HOME/profiles/web/cordis.patch.yml`)覆盖该行:

```yaml
- insert:
    - id: rss-daily
      name: dsh-rss-daily
      config:
        time: "08:00"          # 本地时间,每天一次
        targets:
          - type: serverchan   # Server酱 sendkey
            key: SCTxxxxxxxx
          - type: telegram
            token: "123456:ABC..."
            chatId: "-1001234567890"
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 定时开关(agent 工具不受影响) |
| `time` | `"08:00"` | 本地 HH:MM;错过 <12h 开机补跑 |
| `stateDir` | `$DSH_HOME/rss-daily` | 源/去重历史/outbox 所在目录 |
| `sourcesFile` | `stateDir/sources.json` | 你的源列表;首次运行自动播种包内 46 源默认表 |
| `digestItems` | `8` | 每日最多条数 |
| `llmMode` | `harness` | `harness`(用 dsh 的模型)或 `none`(仅规则) |
| `llmProvider` / `llmModel` | 第一个可用 | 指定用哪个 harness 模型做编辑 |
| `footer` | `""` | 自定义日报尾注 |
| `targets[]` | `[]` | 投递目标;≥1 个成功即算送达 |

源条目格式(`sources.json`):`{ "name", "url", "category", "tier" (1–3) }`。内置列表从中国大陆实测可达;加源随意——连续失败 3 次的源自动降级 24h 后轮换回来。

## 使用

- **自动**:每天 `time` 生成并推送;错过的话开机补跑。
- **对话里**:直接吩咐 agent——它有 `rss_daily` 工具(`run` / `status` / `redo` / `deliver`),比如"现在生成今天的新闻日报"。
- **无界面/系统 cron**:管线可独立运行,LLM 走任意 OpenAI 兼容端点:

```sh
python py/daily.py --state-dir ~/.rss-daily            # 单进程跑完(规则模式)
RSS_LLM_ENDPOINT=https://api.deepseek.com/v1 \
RSS_LLM_KEY=sk-... RSS_LLM_MODEL=deepseek-chat \
python py/daily.py --state-dir ~/.rss-daily            # 带 LLM 编辑
python py/daily.py --stage confirm --state-dir ~/.rss-daily   # 送达成功后确认
```

## 管线阶段(进阶)

`py/daily.py` 可独立脚本化,stdout 输出单行 JSON:

```sh
python py/daily.py --stage fetch --state-dir DIR    # → {"status":"READY","prompt":...}
python py/daily.py --stage finalize --llm-reply 文件 --state-dir DIR
python py/daily.py --stage confirm --state-dir DIR
python py/daily.py --stage status --state-dir DIR
```

插件本体走的就是这些阶段:`fetch` 产出主编 prompt → 插件经 `ctx.llm` 流式调用 → `finalize` 解析回复(垃圾输出降级规则模式)→ 插件投递 → `confirm` 标记当天完成。**送达成功前不要 confirm**——确认后的条目会永久进入 14 天去重窗口。

## 许可

MIT
