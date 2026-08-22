/**
 * dsh-rss-daily — 每日 RSS 要闻插件
 *
 * 46 源综合日报:定时抓取 → dsh harness 里的模型做主编式精选(失败降级
 * 规则模式)→ webhook 投递 → 幂等确认。管线领域逻辑全部在 py/daily.py
 * (移植自 openclaw 生产脚本 v9)。
 *
 * 三层自定义面:
 *  - settings 命名空间 "rss-daily"(ctx.settings):改时间/目标等,官方
 *    设置 UI 可写,变更实时重排定时器
 *  - 同源 HTTP API /rss-daily/api/*(lib/api.js):status/run/sources/config,
 *    浏览器面板与斜杠命令用,不经 agent 不占上下文
 *  - 浏览器半体 lib/client.js(包声明 dsh.client):会话头部小按钮 +
 *    设置页卡片 + /rss 命令
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOnce, getStatus } from "./pipeline.js";
import { deliverAll } from "./deliver.js";
import { registerApi } from "./api.js";

// 依赖按需加载,缺失时优雅降级:裸 link/离线安装也能启动。
// schemastery 缺失 → 无设置面板 schema(normalize() 兜底默认值);
// dsh-tools 缺失 → 工具以普通对象注册。
let z = null;
try { z = (await import("@deepseek-ai/schemastery")).default; } catch { /* optional */ }
function fallbackDefineTool(options) {
	const properties = {};
	const required = [];
	for (const [key, spec] of Object.entries(options.parameters || {})) {
		const property = { ...spec };
		if (property.required) required.push(key);
		delete property.required;
		properties[key] = property;
	}
	return {
		...options,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties,
			...(required.length ? { required } : {}),
		},
	};
}
let defineTool = fallbackDefineTool;
try {
	const m = await import("@deepseek-ai/dsh-tools");
	if (typeof m.defineTool === "function") defineTool = m.defineTool;
} catch { /* optional: fallback still emits valid JSON Schema */ }

/** Cordis plugin name used by loader diagnostics. */
const name = "rss-daily";
/** 模型调用走 dsh 已配置的 LLM 运行时。 */
const inject = ["llm"];
/** settings 命名空间(settings 体系与浏览器卡片都以它配对)。 */
const NS = "rss-daily";

const schemaShape = {
	enabled: true,
	broadcast: true,
	time: "08:00",
	python: "",
	stateDir: "",
	sourcesFile: "",
	footer: "",
	digestItems: 8,
	llmMode: "harness",
	llmProvider: "",
	llmModel: "",
	llmMaxTokens: 900,
	targets: [],
};

/** 归一化配置,兜住 schema 未覆盖的手写 yml */
function normalize(config) {
	const c = { ...schemaShape, ...(config || {}) };
	c.enabled = c.enabled !== false;
	c.broadcast = c.broadcast !== false;
	c.time = /^\d{1,2}:\d{2}$/.test(c.time || "") ? c.time : "08:00";
	c.stateDir = c.stateDir || path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "rss-daily");
	c.targets = Array.isArray(c.targets) ? c.targets : [];
	c.llmMode = c.llmMode === "none" ? "none" : "harness";
	c.digestItems = Math.min(20, Math.max(1, Number(c.digestItems) || 8));
	return c;
}

const Config = z ? z.object({
	enabled: z.boolean().default(true).description("Enable the daily schedule (manual trigger stays available)."),
	broadcast: z.boolean().default(true).description("Show the finished digest as a frontend-only card inside the chat view (no model context cost)."),
	time: z.string().default("08:00").description("Local HH:MM each day to generate and deliver."),
	python: z.string().default("").description("Python executable override (e.g. python3.11)."),
	stateDir: z.string().default("").description("State directory. Default: $DSH_HOME/rss-daily."),
	sourcesFile: z.string().default("").description("Custom sources JSON. Default: stateDir/sources.json."),
	footer: z.string().default("").description("Footer appended to the digest text."),
	digestItems: z.number().default(8).description("Max digest items per day."),
	llmMode: z.string().default("harness").description("harness = use the model configured in dsh; none = rule-based only."),
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
	// 第三方插件惯例:显式 console(biaoqingbao 同款),宿主日志管道不可见时不至于全盲
	const log = (...args) => {
		console.log(`[rss-daily]`, ...args);
		try { ctx.logger(name).info(...args); } catch { /* logger 可选 */ }
	};

	// ── 活配置:settings 命名空间(运行时注入,有则用,无则静态) ──
	let live = normalize(config);
	let scope = null;
	fs.mkdirSync(live.stateDir, { recursive: true });
	if (z) {
		try {
			ctx.inject(["settings"], (sctx) => {
				try {
					scope = sctx.settings.register(NS, Config, { base: normalize(config) });
					const resolved = scope.get();
					if (resolved && typeof resolved === "object") live = normalize(resolved);
					sctx.effect(() => scope.watch((next) => {
						live = normalize(next);
						try { fs.mkdirSync(live.stateDir, { recursive: true }); } catch { }
						log(`config updated: time=${live.time} targets=${live.targets.length}`);
						rearm();
					}));
					log("settings namespace registered");
				} catch (e) {
					log(`settings namespace unavailable, static config only: ${e?.message || e}`);
					scope = null;
				}
			});
		} catch (e) {
			log(`settings inject failed: ${e?.message || e}`);
		}
	}

	// ── 运行状态(面板轮询的单一事实源) ──
	const runState = { running: false, phase: null, phaseDetail: null, startedAt: null, error: null };

	async function runNow(reason, opts = {}) {
		if (runState.running) return { skipped: true, reason: "already running" };
		runState.running = true;
		runState.phase = "start";
		runState.phaseDetail = null;
		runState.startedAt = new Date().toISOString();
		runState.error = null;
		try {
			const result = await runOnce(ctx, live, {
				force: !!opts.force,
				onPhase: (phase, detail) => {
					runState.phase = phase;
					runState.phaseDetail = detail ?? null;
				},
			});
			if (result.skipped) log(`(${reason}) skipped: already sent today`);
			else if (result.empty) log(`(${reason}) empty digest, nothing delivered`);
			else if (result.delivered) log(`(${reason}) delivered to ${result.delivery?.okCount}/${result.delivery?.results?.length} target(s), confirmed`);
			else log(`(${reason}) delivery failed on all targets: ${JSON.stringify(result.delivery?.results || [])}`);
			return result;
		} catch (e) {
			runState.error = String(e?.message || e).slice(0, 500);
			log(`(${reason}) run failed: ${e?.stack || e}`);
			return { error: runState.error };
		} finally {
			runState.running = false;
			runState.phase = null;
			runState.startedAt = null;
		}
	}

	// ── 定时:settings/time 变更即重排 ──
	const pendingTimers = new Set();
	function armTimer(fn, ms) {
		try {
			if (typeof ctx.setTimeout === "function") return ctx.setTimeout(fn, ms);
		} catch { /* timer 服务未注入 */ }
		const t = setTimeout(() => { pendingTimers.delete(t); fn(); }, ms);
		pendingTimers.add(t);
		return () => { clearTimeout(t); pendingTimers.delete(t); };
	}
	let disarm = null;
	function rearm() {
		if (disarm) { disarm(); disarm = null; }
		if (!live.enabled) return;
		disarm = armTimer(async () => { await runNow("schedule"); rearm(); }, nextDelay(live.time));
	}
	ctx.effect(() => () => { for (const t of pendingTimers) clearTimeout(t); });

	if (live.enabled) {
		rearm();
		// 开机补跑:计划时刻已过、窗口 12h 内、今天还没送
		armTimer(async () => {
			if (!overdueToday(live.time)) return;
			try {
				const st = await getStatus(live);
				if (st.last_sent_date !== st.today) await runNow("catchup");
			} catch (e) {
				log(`catchup check failed: ${e?.message || e}`);
			}
		}, 20_000);
	}

	// ── 配置写入(API/面板入口;掩码字段回填真实值) ──
	async function updateConfig(patch) {
		let next = { ...patch };
		if (Array.isArray(next.targets)) {
			next.targets = next.targets.map((t, i) => {
				const merged = { ...t };
				for (const [k, v] of Object.entries(merged)) {
					if (v === "•••" && live.targets[i]?.[k]) merged[k] = live.targets[i][k];
				}
				return merged;
			});
		}
		if (scope) {
			await scope.update(next); // watcher 负责 live 替换 + rearm
		} else {
			live = normalize({ ...live, ...next });
			try { fs.mkdirSync(live.stateDir, { recursive: true }); } catch { }
			rearm();
		}
	}

	// ── 同源 HTTP API(web profile) ──
	try {
		registerApi(ctx, { getLive: () => live, runNow: (opts) => runNow("manual", opts), runState, updateConfig });
	} catch (e) {
		log(`api registration failed: ${e?.message || e}`);
	}

	// ── agent 工具(对话里也能要日报;这个会占上下文,面板不会) ──
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
					output: {
						schema: { type: "string" },
						render: (_args, value) => [{ type: "text", text: String(value) }],
					},
					async execute(args) {
						const action = (args?.action || "run").toLowerCase();
						if (action === "status") {
							const st = await getStatus(live);
							return JSON.stringify(st, null, 2);
						}
						if (action === "deliver") {
							const st = await getStatus(live);
							if (!st.digest) return "No pending digest today.";
							const delivery = await deliverAll(live.targets, st.digest);
							return JSON.stringify({ delivery: delivery.results, digest: st.digest }, null, 2);
						}
						if (action === "redo") {
							try { fs.rmSync(path.join(live.stateDir, "rss-outbox.json"), { force: true }); } catch { /* ignore */ }
						}
						const result = await runNow(action === "redo" ? "agent-redo" : "agent", { force: action === "redo" });
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

	log(`loaded: time=${live.time} state=${live.stateDir} targets=${live.targets.length} llm=${live.llmMode} settings=${scope ? "on" : "off"}`);
}

export { Config, apply, inject, name };
