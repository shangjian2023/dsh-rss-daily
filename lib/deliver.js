/**
 * Webhook 投递:多目标并行、失败重试(指数退避+抖动),单个失败不影响其他。
 * 所有提供方 15s 超时;成功 = HTTP 2xx(个别 API 看业务码)。
 */

const TIMEOUT_MS = 15_000;
/** 网络错误 / 5xx / 429 才重试;4xx(参数或密钥错误)重试无意义,立即放弃。 */
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_500;

/** @param {string} url @param {RequestInit} init */
async function post(url, init = {}) {
	const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
	const body = await resp.text().catch(() => "");
	if (!resp.ok) return { ok: false, status: resp.status, detail: body.slice(0, 200) };
	return { ok: true, status: resp.status, detail: body.slice(0, 200) };
}

function isRetryable(r) {
	return !r.ok && (r.status === 0 || r.status === 429 || r.status >= 500);
}

/**
 * @param {{type: string, [k: string]: any}} target
 * @param {string} title 日报首行,如「每日要闻 2026年08月22日」
 * @param {string} body  正文(首行之后的全部)
 */
async function sendOne(target, title, body) {
	const t = target.type.toLowerCase();
	try {
		switch (t) {
			case "serverchan":
				return await post(`https://sctapi.ftqq.com/${target.key}.send`, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({ title, desp: body }),
				});
			case "pushdeer":
				return await post("https://api2.pushdeer.com/message.json", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ pushkey: target.key, type: "markdown", text: `${title}\n\n${body}` }),
				});
			case "wecom": {
				// 企业微信机器人 markdown 上限 4096 字节,中文 UTF-8 3 字节 → 保守 1150 字符
				// 截断时尾部明示,读者知道完整日报在对话内插播里,不会误以为内容就这么少
				const full = `${title}\n\n${body}`;
				const LIMIT = 1150;
				const content = full.length > LIMIT
					? full.slice(0, LIMIT) + "\n\n(企微通道有长度上限,以上为截断版;完整日报见 dsh 对话内插播)"
					: full;
				return await post(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${target.key}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ msgtype: "markdown", markdown: { content } }),
				});
			}
			case "telegram":
				return await post(`https://api.telegram.org/bot${target.token}/sendMessage`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ chat_id: target.chatId, text: `${title}\n\n${body}` }),
				});
			case "bark": {
				// POST /push 走 JSON body:长日报不再受 URL 长度限制(旧式 /key/title/body 路径会 414)
				const server = (target.server || "https://api.day.app").replace(/\/+$/, "");
				return await post(`${server}/push`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ device_key: target.key, title, body, group: target.group || "rss-daily" }),
				});
			}
			case "gotify": {
				const server = (target.server || "").replace(/\/+$/, "");
				return await post(`${server}/message?token=${target.token}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title, message: body, priority: 5 }),
				});
			}
			case "custom":
				return await post(target.url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title, body, date: new Date().toISOString() }),
				});
			default:
				return { ok: false, status: 0, detail: `unknown target type: ${t}` };
		}
	} catch (e) {
		return { ok: false, status: 0, detail: `${e?.name || "Error"}: ${(e?.message || "").slice(0, 120)}` };
	}
}

/**
 * 单目标带重试:退避 1.5s/3s × 抖动(0.7~1.3),最多 3 次尝试。
 * @returns 末次结果,附 attempts 尝试计数
 */
async function sendWithRetry(target, title, body) {
	let r = await sendOne(target, title, body);
	let attempts = 1;
	while (isRetryable(r) && attempts < RETRY_ATTEMPTS) {
		const delay = RETRY_BASE_MS * attempts * (0.7 + Math.random() * 0.6);
		await new Promise((ok) => setTimeout(ok, delay));
		r = await sendOne(target, title, body);
		attempts += 1;
	}
	return { ...r, attempts };
}

/**
 * 并行投递(目标之间互不阻塞,结果顺序与配置顺序一致)。返回 {results, okCount}。
 * @param {any[]} targets @param {string} digestText
 */
export async function deliverAll(targets, digestText) {
	const nl = digestText.indexOf("\n");
	const title = (nl > 0 ? digestText.slice(0, nl) : digestText).trim();
	const body = nl > 0 ? digestText.slice(nl + 1).trim() : "";
	const results = await Promise.all((targets || []).map(async (target) => (
		{ type: target.type, ...(await sendWithRetry(target, title, body)) }
	)));
	return { results, okCount: results.filter((r) => r.ok).length };
}
