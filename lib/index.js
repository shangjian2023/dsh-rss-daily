/**
 * dsh-rss-daily — 每日 RSS 要闻插件
 *
 * 46 源综合日报:定时抓取 → dsh harness 里的模型做主编式精选(失败降级
 * 规则模式)→ webhook 投递 → 幂等确认。管线领域逻辑全部在 py/daily.py
 * (移植自 openclaw 生产脚本 v9),本插件负责调度、LLM 传输与投递。
 *
 * 见 README.md / README.zh.md。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOnce, getStatus } from "./pipeline.js";
import { deliverAll } from "./deliver.js";

// 依赖按需加载,缺失时优雅降级:裸 link/离线安装也能启动。
// schemastery 缺失 → 无设置面板 schema(normalize() 兜底默认值);
// dsh-tools 缺失 → 工具以普通对象注册。
let z = null;
try { z = (await import("@deepseek-ai/schemastery")).default; } catch { /* optional */ }
let defineTool = (t) => t;
try {
	const m = await import("@deepseek-ai/dsh-tools");
	if (typeof m.defineTool === "function") defineTool = m.defineTool;
} catch { /* optional */ }

/** Cordis plugin name used by loader diagnostics. */
const name = "rss-daily";
/** 模型调用走 dsh 已配置的 LLM 运行时。 */
const inject = ["llm"];

const Config = z ? z.object({
	enabled: z.boolean().default(true).description("Enable the daily schedule (the rss_daily agent tool stays available)."),
	time: z.string().default("08:00").description("Local HH:MM each day to generate and deliver."),
	python: z.string().default("").description("Python executable override (e.g. python3.11)."),
	stateDir: z.string().default("").description("State directory (sources/dedup/outbox). Default: $DSH_HOME/rss-daily."),
	sourcesFile: z.string().default("").description("Custom sources JSON. Default: stateDir/sources.json, seeded from the bundled 46-source list."),
	footer: z.string().default("").description("Footer appended to the digest text."),
	digestItems: z.number().default(8).description("Max digest items per day."),
	llmMode: z.string().default("harness").description("harness = use the model configured in dsh; none = rule-based selection only."),
	llmProvider: z.string().default("").description("Provider override (default: first registered provider)."),
	llmModel: z.string().default("").description("Model override (default: first listed model of the provider)."),
	llmMaxTokens: z.number().default(900),
	targets: z.array(z.object({
		type: z.string().description("serverchan | pushdeer | wecom | telegram | bark | gotify | custom"),
		key: z.string().default(""),
		token: z.string().default(""),
		chatId: z.string().default(""),
		server: z.string().default(""),
		url: z.string().default(""),
	})).default([]).description("Delivery targets; the digest counts as delivered when at least one succeeds."),
}) : undefined;

/** 归一化配置,兜住 schema 未覆盖的手写 yml */
function normalize(config) {
	const c = { ...(config || {}) };
	c.enabled = c.enabled !== false;
	c.time = /^\d{1,2}:\d{2}$/.test(c.time || "") ? c.time : "08:00";
	c.stateDir = c.stateDir || path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "rss-daily");
	c.targets = Array.isArray(c.targets) ? c.targets : [];
	c.llmMode = c.llmMode === "none" ? "none" : "harness";
	return c;
}

/** 距下一次 HH:MM(本地时区)的毫秒数;非法输入回退到明早 08:00 */
function nextDelay(hhmm) {
	const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
	const now = new Date();
	let h = 8, min = 0;
	if (m) {
		h = Math.min(23, parseInt(m[1], 10));
		min = Math.min(59, parseInt(m[2], 10));
	}
	const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0);
	if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
	return target.getTime() - now.getTime();
}

/** 今天计划时刻是否已过但还在追赶窗口内(开机补跑) */
function overdueToday(hhmm) {
	const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
	if (!m) return false;
	const now = new Date();
	const scheduled = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
		parseInt(m[1], 10), parseInt(m[2], 10));
	const age = now.getTime() - scheduled.getTime();
	return age > 0 && age < 12 * 3600 * 1000;
}

function apply(ctx, config) {
	const c = normalize(config);
	const log = (...args) => {
		try { ctx.logger(name).info(...args); } catch { console.log(`[rss-daily]`, ...args); }
	};

	fs.mkdirSync(c.stateDir, { recursive: true });

	// 统一 setTimeout:cordis ctx.setTimeout 优先(getter 未注入 timer 服务时访问即抛,
	// 包 try/catch);回退全局 timer 由下方 effect 统一回收
	const pendingTimers = new Set();
	function armTimer(fn, ms) {
		try {
			if (typeof ctx.setTimeout === "function") return ctx.setTimeout(fn, ms);
		} catch { /* timer service not injected in this composition */ }
		const t = setTimeout(() => { pendingTimers.delete(t); fn(); }, ms);
		pendingTimers.add(t);
		return () => { clearTimeout(t); pendingTimers.delete(t); };
	}
	ctx.effect(() => () => { for (const t of pendingTimers) clearTimeout(t); });

	let running = false;
	async function tick(reason) {
		if (running) return;
		running = true;
		try {
			const result = await runOnce(ctx, c, {});
			if (result.skipped) log(`(${reason}) skipped: already sent today`);
			else if (result.empty) log(`(${reason}) empty digest, nothing delivered`);
			else if (result.delivered) log(`(${reason}) delivered to ${result.delivery?.okCount}/${result.delivery?.results?.length} target(s), confirmed`);
			else log(`(${reason}) delivery failed on all targets, will retry as PENDING_SEND: ${JSON.stringify(result.delivery?.results || [])}`);
		} catch (e) {
			log(`(${reason}) run failed: ${e?.stack || e}`);
		} finally {
			running = false;
		}
	}

	if (c.enabled) {
		// 每日定时
		const armNext = () => armTimer(async () => { await tick("schedule"); armNext(); }, nextDelay(c.time));
		armNext();
		// 开机补跑:计划时刻已过、窗口 12h 内、今天还没送
		armTimer(async () => {
			if (!overdueToday(c.time)) return;
			try {
				const st = await getStatus(c);
				if (st.last_sent_date !== st.today) await tick("catchup");
			} catch (e) {
				log(`catchup check failed: ${e?.message || e}`);
			}
		}, 20_000);
	}

	// agent 工具:在 dsh 对话里直接要日报
	try {
		ctx.on("agent/created", ({ agent }) => {
			try {
				if (!agent?.ctx?.tools?.register) return;
				agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
					name: "rss_daily",
					description:
						"Generate or inspect the daily RSS news digest (46 curated sources, LLM-edited, webhook-delivered). " +
						"Actions: run (default; generate & deliver today's digest if not yet sent), status, redo (force regenerate today), deliver (re-send pending digest).",
					parameters: {
						action: {
							type: "string",
							required: false,
							description: "run | status | redo | deliver",
						},
					},
					async execute(args) {
						const action = (args?.action || "run").toLowerCase();
						if (action === "status") {
							const st = await getStatus(c);
							return { json: st };
						}
						if (action === "deliver") {
							const st = await getStatus(c);
							if (!st.digest) return "No pending digest today.";
							const delivery = await deliverAll(c.targets, st.digest);
							return { json: { delivery, digest: st.digest } };
						}
						if (action === "redo") {
							try { fs.rmSync(path.join(c.stateDir, "rss-outbox.json"), { force: true }); } catch { /* ignore */ }
						}
						const result = await runOnce(ctx, c, { force: action === "redo" });
						if (result.skipped) return "Already delivered today. Use action \"redo\" to regenerate.";
						if (result.empty) return "No fresh news today (all sources failed or duplicates).";
						if (result.digest && !result.delivered) {
							return `Digest generated but delivery failed on all targets:\n\n${result.digest}`;
						}
						return result.digest || JSON.stringify(result);
					},
				})));
			} catch (e) {
				log(`tool registration skipped: ${e?.message || e}`);
			}
		});
	} catch (e) {
		log(`agent tool unavailable: ${e?.message || e}`);
	}

	log(`loaded: time=${c.time} state=${c.stateDir} targets=${c.targets.length} llm=${c.llmMode}`);
}

export { Config, apply, inject, name };
