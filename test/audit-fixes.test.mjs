/**
 * 2026-10 审计修复回归(离线,除 deliverAll 一例起本地回环 sink)。
 * 对应报告:rss-audit/REPORT.md H1/H2/M2/M3 + 打包契约。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { deliverAll } from "../lib/deliver.js";
import { validateConfigPatch, sameOriginOk, CONFIG_KEYS } from "../lib/api.js";
import { fillMaskedTargets } from "../lib/index.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("H2: 缺 type 的畸形目标不再打崩整轮投递", async () => {
	const hits = [];
	const sink = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => { hits.push(Buffer.concat(chunks).toString()); res.end("ok"); });
	});
	await new Promise((ok) => sink.listen(0, "127.0.0.1", ok));
	const port = sink.address().port;
	try {
		const targets = [
			{ no_type_here: true }, // 畸形:deliverAll 必须吞掉它的错
			{ type: "custom", url: `http://127.0.0.1:${port}/hook` },
		];
		const r = await deliverAll(targets, "每日要闻 测试\n\n1. 条目");
		assert.equal(r.okCount, 1, JSON.stringify(r.results));
		assert.equal(hits.length, 1);
		const bad = r.results.find((x) => x.type === undefined || x.ok === false);
		assert.ok(bad && bad.ok === false, "畸形目标应有失败结果");
		assert.equal(bad.attempts, 1, "未知类型不可重试");
	} finally {
		sink.close();
	}
});

test("M3: footer 超长被拒(500 上限),正常长度放行", () => {
	assert.match(validateConfigPatch({ footer: "x".repeat(501) }).error, /footer/);
	assert.deepEqual(validateConfigPatch({ footer: "x".repeat(500) }), { patch: { footer: "x".repeat(500) } });
	assert.match(validateConfigPatch({ llmProvider: "p".repeat(121) }).error, /llmProvider/);
});

test("H1: 写路由同源防线", () => {
	const mk = (h) => ({ headers: h });
	assert.equal(sameOriginOk(mk({})), true, "无 Origin 头(非浏览器/同源)放行");
	assert.equal(sameOriginOk(mk({ origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080" })), true);
	assert.equal(sameOriginOk(mk({ origin: "https://evil.example", host: "127.0.0.1:3080" })), false, "跨站 Origin 拒");
	assert.equal(sameOriginOk(mk({ "sec-fetch-site": "cross-site" })), false);
	assert.equal(sameOriginOk(mk({ "sec-fetch-site": "same-origin" })), true);
});

test("M2: 掩码回填按 type 身份对齐,错位不再把 ••• 当密钥", () => {
	const live = [
		{ type: "serverchan", key: "REAL_SC" },
		{ type: "telegram", token: "REAL_TG", chatId: "9" },
	];
	// 面板快照只剩一个 telegram 且排在首位(下标错位场景)
	const out = fillMaskedTargets([{ type: "telegram", token: "•••", chatId: "9" }], live);
	assert.equal(out[0].token, "REAL_TG");
	// 对不上号的掩码保持字面量,由 updateConfig 拒绝(不落盘)
	const out2 = fillMaskedTargets([{ type: "bark", key: "•••" }], live);
	assert.equal(out2[0].key, "•••");
	// 下标对齐时行为不变
	const out3 = fillMaskedTargets([{ type: "serverchan", key: "•••" }], live);
	assert.equal(out3[0].key, "REAL_SC");
});

test("F-JS-17: CONFIG_KEYS 覆盖面板全部可写键", () => {
	const panelKeys = ["time", "enabled", "broadcast", "agentTool", "digestItems", "footer",
		"llmProvider", "llmModel", "llmMaxTokens", "targets", "language", "timezone"];
	assert.deepEqual([...CONFIG_KEYS].sort(), [...panelKeys].sort());
});

test("F-PKG-05: 客户端半体契约(exports/加载形态/id 一致)", async () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	const rel = pkg.exports?.["./client"];
	assert.equal(typeof rel, "string", 'exports["./client"] 指向文件');
	const file = path.join(root, rel);
	assert.ok(fs.existsSync(file));
	const head = fs.readFileSync(file, "utf8").slice(0, 200);
	assert.match(head, /window\.__ModuleLoader__\.load\(\s*\{/);
	assert.match(head, new RegExp(`id:\\s*["']${pkg.name}["']`), "bundle id 与包名一致");
});
