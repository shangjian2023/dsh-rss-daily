/**
 * 手动集成测试:真实抓源 + 规则模式 + 本地 webhook 收件。
 * 用法: node test/smoke.mjs   (需要网络)
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { runOnce } from "../lib/pipeline.js";

const stateDir = path.resolve(".test-state-e2e");
await fs.rm(stateDir, { recursive: true, force: true });

// 本地收件服务器
const received = [];
const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (d) => { body += d; });
	req.on("end", () => {
		received.push(body);
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("ok");
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const fakeCtx = { logger: () => ({ info: () => {}, warn: () => {} }) };
const config = {
	stateDir,
	llmMode: "none",
	targets: [{ type: "custom", url: `http://127.0.0.1:${port}/hook` }],
};

try {
	const r1 = await runOnce(fakeCtx, config, { force: true });
	console.log("run #1:", { delivered: r1.delivered, skipped: r1.skipped, empty: r1.empty });
	if (!r1.delivered || !r1.digest) throw new Error(`run #1 failed: ${JSON.stringify(r1).slice(0, 300)}`);
	if (received.length !== 1) throw new Error(`hook received ${received.length} posts, want 1`);
	if (!received[0].includes("每日要闻")) throw new Error("hook body missing digest title");
	console.log("hook body head:", received[0].slice(0, 120));

	const r2 = await runOnce(fakeCtx, config, {});
	if (!r2.skipped) throw new Error("run #2 should skip (already sent today)");
	console.log("run #2: skipped ✓");

	console.log("\nSMOKE PASS");
} finally {
	server.close();
	await fs.rm(stateDir, { recursive: true, force: true });
}
