/**
 * harness LLM 单次调用:走 ctx.llm(dsh 已配置的模型),零额外凭据。
 * 失败向上抛;调用方(catch)降级规则模式/翻译兜底,日报永不断供。
 *
 * AIHOT 蒸馏的三条纪律:
 *  - 默认模型跟着宿主走:优先 agentDefaultModel 服务(用户聊天用的那个),
 *    而不是 listProviders()[0] 轮盘赌——桌面版上后者会命中无凭据路由。
 *  - 花钱的请求有回执:每次调用记进 stateDir/llm-receipts.json,重启可查。
 *  - 预算熔断:单日调用超上限直接拒绝,防止重试循环烧 token。
 */

const RECEIPTS_FILE = "llm-receipts.json";
const MAX_CALLS_PER_DAY = 8;
const MAX_TOKENS_CEILING = 8000; // 与 api.js 的校验上限一致

/**
 * 解析本次调用的 provider/model。
 * 优先级:显式配置 > 宿主默认模型(agentDefaultModel) > 第一个注册的 provider。
 * @returns {{provider: string, model: string}}
 */
export function resolveTarget(ctx, opts = {}, getDefaultSelection) {
	const providers = ctx.llm.listProviders();
	if (providers.length === 0) throw new Error("no llm provider registered");
	const ids = new Set(providers.map((p) => p.id));

	let provider = opts.provider || "";
	if (!provider) {
		const sel = getDefaultSelection?.() || null;
		if (sel?.provider && ids.has(sel.provider)) {
			provider = sel.provider;
			// 默认选择的模型只在该 provider 下有效;校验失败不阻塞,交给 listModels 兜底
			if (sel.model) return { provider, model: sel.model };
			return { provider, model: "" };
		}
		provider = providers[0].id;
	} else if (!ids.has(provider)) {
		throw new Error(`llm provider "${provider}" not registered (have: ${[...ids].join(", ")})`);
	}
	return { provider, model: opts.model || "" };
}

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {{prompt: string, system?: string, provider?: string, model?: string,
 *          maxTokens?: number, temperature?: number, timeoutMs?: number}} opts
 * @returns {Promise<string>} 模型完整文本回复
 */
export async function complete(ctx, opts) {
	let model = opts.model || "";
	if (!model) {
		const models = await ctx.llm.listModels(opts.provider);
		if (!models || models.length === 0) throw new Error(`no model listed for provider ${opts.provider}`);
		model = models[0].id;
	}

	const chunks = [];
	let failure = null;
	const signal = AbortSignal.timeout(opts.timeoutMs ?? 240_000);
	const stream = ctx.llm.stream({
		provider: opts.provider,
		model,
		system: opts.system,
		messages: [{ role: "user", content: [{ type: "text", text: opts.prompt }] }],
		temperature: opts.temperature ?? 0.2,
		maxTokens: opts.maxTokens ?? 3072,
		signal,
	});
	for await (const chunk of stream) {
		switch (chunk.type) {
			case "text-delta":
				chunks[chunk.index] = (chunks[chunk.index] || "") + chunk.text;
				break;
			case "finish":
				if (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted") {
					failure = chunk.reason.failure || new Error(`llm finish: ${chunk.reason.kind}`);
				}
				break;
			default:
				break;
		}
	}
	if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
	const text = chunks.filter(Boolean).join("").trim();
	if (!text) throw new Error("empty llm reply");
	return text;
}

/* ── 回执与预算 ── */

function readReceipts(fs, filePath) {
	try {
		const d = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (d && typeof d === "object") return d;
	} catch { /* 无文件或损坏都按空账本处理 */ }
	return {};
}

function writeReceipts(fs, filePath, today, entry) {
	const d = readReceipts(fs, filePath);
	const fresh = d.date !== today; // 跨天自动清零重计
	const entries = fresh ? [] : Array.isArray(d.entries) ? d.entries : [];
	entries.push(entry);
	while (entries.length > 50) entries.shift();
	fs.writeFileSync(filePath, JSON.stringify({ date: today, entries }, null, 1), "utf8");
	return fresh ? 1 : entries.length;
}

/**
 * 带策略的单次"编辑级"调用:
 *  - 预算熔断:当日已记满 MAX_CALLS_PER_DAY 笔回执 → 直接抛错走降级
 *  - 空回复重试:思考型模型常把 max_tokens 全烧在推理上、content 空手而归
 *    (2026-09-29 桌面版实录:qwen3.7-plus + 900 tokens → "empty llm reply"),
 *    同一预算翻倍再试一次
 * @returns {Promise<{text: string, provider: string, model: string, attempts: number}>}
 */
export async function completeWithPolicy(ctx, opts, policy = {}) {
	const fs = policy.fs;
	const stateDir = policy.stateDir;
	const log = typeof policy.log === "function" ? policy.log : () => {};
	const today = new Date().toISOString().slice(0, 10);
	const receiptsPath = stateDir ? `${stateDir}/${RECEIPTS_FILE}` : null;

	if (receiptsPath && fs) {
		const d = readReceipts(fs, receiptsPath);
		const used = d.date === today ? (Array.isArray(d.entries) ? d.entries.length : 0) : 0;
		if (used >= (policy.maxCallsPerDay ?? MAX_CALLS_PER_DAY)) {
			throw new Error(`llm daily budget exhausted (${used} calls today); falling back`);
		}
	}

	const target = resolveTarget(ctx, opts, policy.getDefaultSelection);
	let model = target.model;
	if (!model) {
		const models = await ctx.llm.listModels(target.provider);
		if (!models || models.length === 0) throw new Error(`no model listed for provider ${target.provider}`);
		model = models[0].id;
	}
	const base = opts.maxTokens ?? 3072;
	let lastErr = null;
	for (let attempt = 1; attempt <= 2; attempt++) {
		const maxTokens = Math.min(base * attempt, MAX_TOKENS_CEILING);
		const t0 = Date.now();
		try {
			const text = await complete(ctx, { ...opts, provider: target.provider, model, maxTokens });
			if (receiptsPath && fs) {
				writeReceipts(fs, receiptsPath, today,
					{ at: new Date().toISOString(), provider: target.provider, model, mode: opts.mode || "", ok: true, ms: Date.now() - t0 });
			}
			return { text, provider: target.provider, model, attempts: attempt };
		} catch (e) {
			lastErr = e;
			if (receiptsPath && fs) {
				writeReceipts(fs, receiptsPath, today,
					{ at: new Date().toISOString(), provider: target.provider, model, mode: opts.mode || "", ok: false, error: String(e?.message || e).slice(0, 200), ms: Date.now() - t0 });
			}
			const retryable = /empty llm reply/i.test(String(e?.message || "")) && maxTokens < MAX_TOKENS_CEILING;
			if (!retryable) throw e;
			log(`llm empty reply with maxTokens=${maxTokens}, retrying with doubled budget`);
		}
	}
	throw lastErr || new Error("llm failed");
}
