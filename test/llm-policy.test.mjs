import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { completeWithPolicy, resolveTarget } from "../lib/llm.js";

/** 可脚本化的 ctx.llm 替身:replies 依次出牌,"EMPTY" 出无文本结束 */
function mockCtx(replies) {
	let call = 0;
	return {
		llm: {
			listProviders: () => [{ id: "provA" }, { id: "provB" }],
			listModels: async (p) => [{ id: p + "-m1" }, { id: p + "-m2" }],
			stream: () => (async function* () {
				const r = replies[Math.min(call, replies.length - 1)];
				call++;
				if (r !== "EMPTY") yield { type: "text-delta", index: 0, text: r };
				yield { type: "finish", reason: { kind: "stop" } };
			})(),
		},
	};
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "drd-llm-"));

test("resolveTarget: agentDefaultModel 的选择优先于 providers[0] 轮盘赌", () => {
	const ctx = mockCtx(["x"]);
	const t1 = resolveTarget(ctx, {}, () => ({ provider: "provB", model: "m-x" }));
	assert.deepEqual(t1, { provider: "provB", model: "m-x" });
	const t2 = resolveTarget(ctx, {}, () => ({ provider: "ghost", model: "m" }));
	assert.equal(t2.provider, "provA"); // 服务里选的 provider 未注册 → 回退
	const t3 = resolveTarget(ctx, { provider: "provB" });
	assert.equal(t3.provider, "provB");
	assert.throws(() => resolveTarget(ctx, { provider: "ghost" }), /not registered/);
});

test("completeWithPolicy: 空回复翻倍重试后成功,回执落两笔", async () => {
	const dir = tmp();
	const ctx = mockCtx(["EMPTY", "中文正文"]);
	const r = await completeWithPolicy(ctx, { prompt: "p", mode: "edit" },
		{ stateDir: dir, getDefaultSelection: () => ({ provider: "provA", model: "provA-m1" }) });
	assert.equal(r.text, "中文正文");
	assert.equal(r.attempts, 2);
	assert.equal(r.model, "provA-m1");
	const ledger = JSON.parse(fs.readFileSync(path.join(dir, "llm-receipts.json"), "utf8"));
	assert.equal(ledger.entries.length, 2);
	assert.equal(ledger.entries[0].ok, false);
	assert.match(ledger.entries[0].error, /empty llm reply/);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("completeWithPolicy: 两次都空 → 抛错;单日预算熔断", async () => {
	const dir = tmp();
	const ctx = mockCtx(["EMPTY", "EMPTY"]);
	await assert.rejects(
		completeWithPolicy(ctx, { prompt: "p" }, { stateDir: dir }),
		/empty llm reply/);
	// 已记 2 笔,把上限压到 2 → 再调直接熔断
	await assert.rejects(
		completeWithPolicy(ctx, { prompt: "p" }, { stateDir: dir, maxCallsPerDay: 2 }),
		/budget exhausted/);
	fs.rmSync(dir, { recursive: true, force: true });
});
