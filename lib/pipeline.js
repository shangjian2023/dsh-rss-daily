/**
 * Python 管道编排:fetch → (harness LLM) → finalize → deliver → confirm。
 * 全部子进程化,python 崩溃/超时不拖垮宿主。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { complete } from "./llm.js";
import { deliverAll } from "./deliver.js";

const PY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "py", "daily.py");
const RUN_TIMEOUT_MS = 460_000; // python 内部预算 420s,留 40s 余量

let cachedPython = null;

/** 依次探测可用的 python 解释器 */
export async function resolvePython(configured) {
	if (cachedPython) return cachedPython;
	const candidates = configured
		? [configured]
		: [...(process.env.RSS_DAILY_PYTHON ? [process.env.RSS_DAILY_PYTHON] : []), "python3", "python", "py"];
	for (const cmd of candidates) {
		const args = cmd === "py" ? ["-3"] : [];
		try {
			const r = await runRaw(cmd, [...args, "-c", "import feedparser,sys;print(sys.version_info[0])"], 20_000);
			if (r.code === 0 && r.stdout.trim().endsWith("3")) {
				cachedPython = { cmd, args };
				return cachedPython;
			}
		} catch {
			// try next
		}
	}
	throw new Error(`no python3 with feedparser found (tried: ${candidates.join(", ")}); install: pip install feedparser`);
}

/**
 * @param {string} cmd @param {string[]} args @param {number} timeoutMs
 */
function runRaw(cmd, args, timeoutMs) {
	return new Promise((resolve, reject) => {
		// Windows 管道下 python 默认用本地代码页(GBK),强制 UTF-8
		const child = spawn(cmd, args, {
			windowsHide: true,
			env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
		});
		// Buffer 收集、结束时统一 utf8 解码:分块拼接字符串会把多字节中文截断成乱码
		const outBufs = [], errBufs = [];
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`timeout after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout.on("data", (d) => { outBufs.push(d); });
		child.stderr.on("data", (d) => { errBufs.push(d); });
		child.on("error", (e) => { clearTimeout(timer); reject(e); });
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				code,
				stdout: Buffer.concat(outBufs).toString("utf8"),
				stderr: Buffer.concat(errBufs).toString("utf8"),
			});
		});
	});
}

/** 非默认时区补进每次子进程调用(fetch/confirm/status 的"今天"语义才一致) */
const tzArgs = (config) => (config.timezone && config.timezone !== "UTC+8" ? ["--tz", config.timezone] : []);

/** 跑 daily.py 一个阶段,解析 stdout 单行 JSON */
async function runStage(config, stageArgs) {
	const py = await resolvePython(config.python);
	const extra = py.cmd === "py" ? ["-3"] : [];
	const args = [PY_SCRIPT, ...extra, "--stage", ...stageArgs, ...tzArgs(config)];
	const r = await runRaw(py.cmd, args, RUN_TIMEOUT_MS);
	if (r.code !== 0) {
		throw new Error(`daily.py exited ${r.code}: ${r.stderr.slice(-400)}`);
	}
	const line = r.stdout.trim().split("\n").filter(Boolean).pop() || "";
	try {
		return JSON.parse(line);
	} catch {
		throw new Error(`daily.py bad json output: ${line.slice(0, 200)}`);
	}
}

function baseArgs(config, force = false) {
	const args = ["fetch", "--state-dir", config.stateDir];
	if (config.sourcesFile) args.push("--sources", config.sourcesFile);
	if (config.footer) args.push("--footer", config.footer);
	if (config.language === "en") args.push("--lang", "en");
	if (config.timezone && config.timezone !== "UTC+8") args.push("--tz", config.timezone);
	if (config.digestItems) args.push("--digest-items", String(config.digestItems));
	if (force) args.push("--force");
	return args;
}

/**
 * 完整跑一轮。LLM 失败自动降级规则模式;投递到 ≥1 个目标即算送达并 confirm。
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {any} config 归一化后的插件配置
 * @param {{force?: boolean, onPhase?: (phase: string, detail?: any) => void}} opts
 */
export async function runOnce(ctx, config, opts = {}) {
	const onPhase = typeof opts.onPhase === "function" ? opts.onPhase : () => {};
	const status = await getStatus(config);
	if (!opts.force && (status.last_sent_date === status.today
		|| (status.outbox?.date === status.today && status.outbox?.confirmed))) {
		return { skipped: true, ...status };
	}

	let fetched;
	if (status.outbox?.date === status.today && !status.outbox?.confirmed && status.outbox?.has_digest) {
		fetched = { status: "PENDING_SEND", date: status.today };
	} else {
		onPhase("fetch");
		fetched = await runStage(config, baseArgs(config, !!opts.force));
	}

	let digest = fetched.status === "PENDING_SEND" ? (status.digest || "") : "";
	if (fetched.status === "LOCKED") return { skipped: true, reason: "locked", ...fetched };
	if (fetched.status === "SKIPPED_TODAY") return { skipped: true, ...fetched };
	if (fetched.status === "EMPTY") return { empty: true, ...fetched };

	if (fetched.status === "READY" || fetched.status === "PENDING_SEND") {
		if (fetched.status === "READY" && config.llmMode !== "none" && fetched.need_llm) {
			try {
				onPhase("llm");
				const reply = await complete(ctx, {
					prompt: await readPrompt(config),
					provider: config.llmProvider || undefined,
					model: config.llmModel || undefined,
					maxTokens: config.llmMaxTokens || 900,
				});
				const replyFile = path.join(config.stateDir, `llm-reply-${randomUUID()}.txt`);
				await fs.writeFile(replyFile, reply, "utf-8");
				try {
					const done = await runStage(config, ["finalize", "--state-dir", config.stateDir,
						"--llm-reply", replyFile, ...(config.footer ? ["--footer", config.footer] : [])]);
					digest = done.digest || "";
				} finally {
					await fs.rm(replyFile, { force: true });
				}
			} catch (e) {
				ctx?.logger?.warn?.(`[rss-daily] harness llm failed, fallback to rule mode: ${e?.message || e}`);
				onPhase("finalize", "rule");
				const done = await runStage(config, ["finalize", "--state-dir", config.stateDir, "--rule",
					...(config.footer ? ["--footer", config.footer] : [])]);
				digest = done.digest || "";
			}
		} else if (fetched.status === "READY") {
			onPhase("finalize", "rule");
			const done = await runStage(config, ["finalize", "--state-dir", config.stateDir, "--rule",
				...(config.footer ? ["--footer", config.footer] : [])]);
			digest = done.digest || "";
		}
	}

	if (!digest) return { empty: true };
	onPhase("deliver");
	const delivery = await deliverAll(config.targets, digest);
	await writeDeliveryLast(config, delivery);
	if (delivery.okCount === 0) {
		onPhase("done", { delivered: false });
		return { delivered: false, digest, delivery };
	}
	const confirmed = await runStage(config, ["confirm", "--state-dir", config.stateDir]);
	onPhase("done", { delivered: true });
	return { delivered: true, digest, delivery, confirmed };
}

/** 从 outbox 里取 fetch 阶段存好的 prompt */
async function readPrompt(config) {
	const outbox = JSON.parse(await fs.readFile(path.join(config.stateDir, "rss-outbox.json"), "utf-8"));
	if (!outbox.prompt) throw new Error("outbox has no prompt");
	return outbox.prompt;
}

/** 投递结果落盘(面板"上次投递"数据源);opts.prev 提供时=重投,保留上次成功项 */
async function writeDeliveryLast(config, delivery, opts = {}) {
	try {
		let outboxDate = null;
		try {
			outboxDate = (JSON.parse(await fs.readFile(path.join(config.stateDir, "rss-outbox.json"), "utf-8"))).date || null;
		} catch { /* outbox 不可读时 date 置空 */ }
		let results = delivery.results.map((r) => ({ type: r.type, ok: r.ok, status: r.status,
			attempts: r.attempts, detail: (r.detail || "").slice(0, 200) }));
		if (opts.prev && Array.isArray(opts.prev.results)) {
			const pending = [...results];
			results = opts.prev.results.map((p) => {
				const i = pending.findIndex((n) => n.type === p.type);
				return i >= 0 ? pending.splice(i, 1)[0] : p;
			});
			results.push(...pending);
		}
		const payload = { date: outboxDate, at: new Date().toISOString(),
			okCount: results.filter((r) => r.ok).length, results };
		await fs.writeFile(path.join(config.stateDir, "delivery-last.json"), JSON.stringify(payload), "utf-8");
	} catch { /* 记录失败不影响投递主流程 */ }
}

/** 重投当前 outbox 里的日报(默认全部目标;onlyFailed 只投上次失败的目标) */
export async function redeliver(config, opts = {}) {
	const status = await getStatus(config);
	if (!status.digest) return { error: "no digest to deliver" };
	// 只重投"今天"的 outbox:隔夜陈旧箱(昨天生成未确认)不该当今天的新闻发
	if (status.outbox?.date && status.outbox.date !== status.today) {
		return { error: `outbox stale (${status.outbox.date}, today is ${status.today}); use action "run" to generate today's digest first` };
	}
	let targets = config.targets || [];
	let last = null;
	try { last = JSON.parse(await fs.readFile(path.join(config.stateDir, "delivery-last.json"), "utf-8")); } catch { /* 无历史记录 */ }
	if (opts.onlyFailed) {
		if (!last || !Array.isArray(last.results)) return { error: "no previous delivery record" };
		const failed = new Set(last.results.filter((r) => !r.ok).map((r) => r.type));
		if (!failed.size) return { error: "nothing failed last time" };
		targets = targets.filter((tg) => failed.has(tg.type));
	}
	if (!targets.length) return { error: "no delivery targets configured" };
	const delivery = await deliverAll(targets, status.digest);
	await writeDeliveryLast(config, delivery, { prev: last });
	if (delivery.okCount > 0 && !status.outbox?.confirmed) {
		await runStage(config, ["confirm", "--state-dir", config.stateDir]);
	}
	return { delivery, digest: status.digest };
}

/** status 阶段直通 */
export async function getStatus(config) {
	return runStage(config, ["status", "--state-dir", config.stateDir]);
}
