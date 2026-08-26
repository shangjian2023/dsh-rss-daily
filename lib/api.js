/**
 * 同源 HTTP API:面板/斜杠命令经 fetch 调用,不经 agent、不进会话日志。
 * 路由挂 ctx.webServer(web profile 专用;headless 无此服务时静默跳过)。
 * 安全说明:webserver 默认只绑 127.0.0.1;若用户改绑 0.0.0.0,这些路由
 * 会随之暴露——run/sources 只读无密钥,config/sources 写入做了字段白名单。
 */
import fs from "node:fs";
import path from "node:path";

const PREFIX = "/rss-daily/api"; // 无尾斜杠:webserver 匹配规则是 pathname===prefix 或 startsWith(prefix+"/")
const TARGET_TYPES = new Set(["serverchan", "pushdeer", "wecom", "telegram", "bark", "gotify", "custom"]);
const CONFIG_KEYS = new Set(["time", "enabled", "broadcast", "digestItems", "footer", "llmProvider", "llmModel", "llmMaxTokens", "targets", "language", "timezone"]);

function sendJson(res, code, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(body);
}

async function readJsonBody(req, limit = 200_000) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new Error("body too large");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** 校验一份配置补丁;返回 {patch} 或 {error} */
function validateConfigPatch(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "body must be an object" };
	const patch = {};
	for (const [k, v] of Object.entries(input)) {
		if (!CONFIG_KEYS.has(k)) return { error: `unknown key: ${k}` };
		patch[k] = v;
	}
	if (patch.time !== undefined && !/^\d{1,2}:\d{2}$/.test(String(patch.time))) return { error: "time must be HH:MM" };
	if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") return { error: "enabled must be boolean" };
	if (patch.broadcast !== undefined && typeof patch.broadcast !== "boolean") return { error: "broadcast must be boolean" };
	if (patch.digestItems !== undefined && (!Number.isInteger(patch.digestItems) || patch.digestItems < 1 || patch.digestItems > 20)) {
		return { error: "digestItems must be 1-20" };
	}
	if (patch.footer !== undefined && typeof patch.footer !== "string") return { error: "footer must be string" };
	if (patch.llmProvider !== undefined && typeof patch.llmProvider !== "string") return { error: "llmProvider must be string" };
	if (patch.llmModel !== undefined && typeof patch.llmModel !== "string") return { error: "llmModel must be string" };
	if (patch.llmMaxTokens !== undefined && (!Number.isInteger(patch.llmMaxTokens) || patch.llmMaxTokens < 100 || patch.llmMaxTokens > 8000)) {
		return { error: "llmMaxTokens must be 100-8000" };
	}
	if (patch.language !== undefined && !["zh", "en"].includes(patch.language)) {
		return { error: "language must be zh or en" };
	}
	if (patch.timezone !== undefined && !/^UTC([+-]\d{1,2})(:\d{2})?$/.test(String(patch.timezone))) {
		return { error: "timezone must look like UTC+8 / UTC-5 / UTC+5:30" };
	}
	if (patch.targets !== undefined) {
		if (!Array.isArray(patch.targets)) return { error: "targets must be an array" };
		if (patch.targets.length > 10) return { error: "too many targets" };
		for (const t of patch.targets) {
			if (!t || typeof t !== "object") return { error: "target must be an object" };
			if (!TARGET_TYPES.has(t.type)) return { error: `unknown target type: ${t.type}` };
			for (const [fk, fv] of Object.entries(t)) {
				if (typeof fv !== "string") return { error: `target.${fk} must be string` };
				if (fv.length > 500) return { error: `target.${fk} too long` };
			}
		}
	}
	return { patch };
}

/** 校验源列表;返回 {sources} 或 {error} */
function validateSources(input) {
	if (!Array.isArray(input)) return { error: "body.sources must be an array" };
	if (input.length > 300) return { error: "too many sources" };
	const names = new Set();
	for (const s of input) {
		if (!s || typeof s !== "object") return { error: "source must be an object" };
		for (const k of ["name", "url"]) {
			if (typeof s[k] !== "string" || !s[k].trim() || s[k].length > 300) return { error: `source.${k} must be a non-empty string` };
		}
		if (names.has(s.name)) return { error: `duplicate source name: ${s.name}` };
		names.add(s.name);
		if (!/^https?:\/\//.test(s.url)) return { error: `source.url must be http(s): ${s.name}` };
		if (typeof s.category !== "string" || !s.category.trim() || s.category.length > 20) return { error: `source.category invalid: ${s.name}` };
		if (s.tier !== undefined && ![1, 2, 3].includes(s.tier)) return { error: `source.tier must be 1-3: ${s.name}` };
		if (s.disabled !== undefined && typeof s.disabled !== "boolean") return { error: `source.disabled must be boolean: ${s.name}` };
	}
	return { sources: input };
}

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {{
 *   getLive: () => any, runNow: (opts: {force?: boolean}) => Promise<any>,
 *   runState: any, updateConfig: (patch: any) => Promise<void>,
 * }} deps
 */
export function registerApi(ctx, deps) {
	const { getLive, runNow, runState, updateConfig, redeliver } = deps;

	const handler = (fn) => async (req, res) => {
		try {
			await fn(req, res);
		} catch (e) {
			sendJson(res, 500, { error: String(e?.message || e).slice(0, 300) });
		}
	};

	const readOutbox = () => {
		try {
			return JSON.parse(fs.readFileSync(path.join(getLive().stateDir, "rss-outbox.json"), "utf-8"));
		} catch { return {}; }
	};
	const readSent = () => {
		try {
			return JSON.parse(fs.readFileSync(path.join(getLive().stateDir, "rss-sent.json"), "utf-8"));
		} catch { return {}; }
	};
	const readDeliveryLast = () => {
		try {
			return JSON.parse(fs.readFileSync(path.join(getLive().stateDir, "delivery-last.json"), "utf-8"));
		} catch { return null; }
	};

	// 本地日期 YYYY-MM-DD:与调度器(nextDelay)同一时区语义。
	// 不能用 outbox.date 冒充"今天":陈旧未确认 outbox(如隔夜)或 redo 删
	// 箱期间会把昨天甚至前天的日期报给面板/插播轮询方。
	const localToday = () => {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	};
	const statusView = () => {
		const live = getLive();
		const outbox = readOutbox();
		const sent = readSent();
		return {
			running: runState.running,
			phase: runState.phase,
			phaseDetail: runState.phaseDetail,
			startedAt: runState.startedAt,
			error: runState.error,
			today: localToday(),
			digestDate: outbox.date || null,
			last_sent_date: sent.last_sent_date,
			confirmed: !!outbox.confirmed,
			used_llm: !!outbox.used_llm,
			digest: outbox.digest_text || "",
			items: (outbox.items || []).map((it) => ({
				n: it.n, tag: it.tag, one_liner: it.one_liner, title: it.title,
				link: it.link, source: it.source,
			})),
			delivery: readDeliveryLast(),
			config: {
				time: live.time,
				enabled: live.enabled,
				broadcast: live.broadcast !== false,
				digestItems: live.digestItems,
				footer: live.footer,
				language: live.language,
				timezone: live.timezone,
				llmProvider: live.llmProvider,
				llmModel: live.llmModel,
				targets: (live.targets || []).map((t) => ({ ...t, key: t.key ? "•••" : "", token: t.token ? "•••" : "" })),
			},
		};
	};

	// 运行时注入:webServer 就绪才挂路由(headless 无此服务时回调不跑)
	ctx.inject(["webServer"], (hostCtx) => {
		hostCtx.effect(() => hostCtx.webServer.register({
			kind: "prefix",
			path: PREFIX,
			handler: handler(async (req, res) => {
			const route = (req.url || "").slice(PREFIX.length).split("?")[0].replace(/^\//, "");
			if (req.method === "GET" && route === "status") {
				sendJson(res, 200, statusView());
			} else if (req.method === "POST" && (route === "run" || route === "redo")) {
				if (runState.running) { sendJson(res, 409, { error: "already running", phase: runState.phase }); return; }
				const force = route === "redo";
				if (force) {
					try { fs.rmSync(path.join(getLive().stateDir, "rss-outbox.json"), { force: true }); } catch { }
				}
				runNow({ force });
				sendJson(res, 202, { started: true, force });
			} else if (req.method === "GET" && route === "sources") {
				const live = getLive();
				let sources = [];
				try { sources = JSON.parse(fs.readFileSync(live.sourcesFile || path.join(live.stateDir, "sources.json"), "utf-8")).sources || []; } catch { }
				sendJson(res, 200, { sources, stateDir: live.stateDir });
			} else if (req.method === "PUT" && route === "sources") {
				const body = await readJsonBody(req);
				const v = validateSources(body.sources);
				if (v.error) { sendJson(res, 400, { error: v.error }); return; }
				const live = getLive();
				const file = live.sourcesFile || path.join(live.stateDir, "sources.json");
				const tmp = `${file}.tmp`;
				fs.writeFileSync(tmp, JSON.stringify({ sources: v.sources }, null, 1), "utf-8");
				fs.renameSync(tmp, file);
				sendJson(res, 200, { saved: v.sources.length });
			} else if (req.method === "POST" && route === "redeliver") {
				if (runState.running) { sendJson(res, 409, { error: "already running" }); return; }
				const body = await readJsonBody(req).catch(() => ({}));
				const r = await redeliver({ onlyFailed: body?.onlyFailed === true });
				if (r.error) { sendJson(res, 409, { error: r.error }); return; }
				sendJson(res, 200, { delivery: r.delivery });
			} else if (req.method === "POST" && route === "config") {
				const body = await readJsonBody(req);
				const v = validateConfigPatch(body);
				if (v.error) { sendJson(res, 400, { error: v.error }); return; }
				await updateConfig(v.patch);
				sendJson(res, 200, { saved: true, config: statusView().config });
			} else {
				sendJson(res, 404, { error: `no such route: ${req.method} ${PREFIX}${route}` });
			}
			}),
		}), "rss-daily: api routes");
		console.log("[rss-daily] api routes mounted at " + PREFIX + "/");
	});
}
