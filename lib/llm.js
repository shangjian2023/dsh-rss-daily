/**
 * harness LLM 单次调用:走 ctx.llm(dsh 已配置的模型),零额外凭据。
 * 失败向上抛;调用方(catch)降级规则模式,日报永不断供。
 */

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {{prompt: string, system?: string, provider?: string, model?: string,
 *          maxTokens?: number, temperature?: number, timeoutMs?: number}} opts
 * @returns {Promise<string>} 模型完整文本回复
 */
export async function complete(ctx, opts) {
	const providers = ctx.llm.listProviders();
	if (providers.length === 0) throw new Error("no llm provider registered");
	const provider = opts.provider || providers[0].id;

	let model = opts.model || "";
	if (!model) {
		const models = await ctx.llm.listModels(provider);
		if (!models || models.length === 0) throw new Error(`no model listed for provider ${provider}`);
		model = models[0].id;
	}

	const chunks = [];
	let failure = null;
	const signal = AbortSignal.timeout(opts.timeoutMs ?? 180_000);
	const stream = ctx.llm.stream({
		provider,
		model,
		system: opts.system,
		messages: [{ role: "user", content: [{ type: "text", text: opts.prompt }] }],
		temperature: opts.temperature ?? 0.2,
		maxTokens: opts.maxTokens ?? 900,
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
