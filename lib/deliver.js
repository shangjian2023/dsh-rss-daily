/**
 * Webhook 投递:多目标、尽力而为,单个失败不影响其他。
 * 所有提供方 15s 超时;成功 = HTTP 2xx(个别 API 看业务码)。
 */

const TIMEOUT_MS = 15_000;

/** @param {string} url @param {RequestInit} init */
async function post(url, init = {}) {
	const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
	const body = await resp.text().catch(() => "");
	if (!resp.ok) return { ok: false, status: resp.status, detail: body.slice(0, 200) };
	return { ok: true, status: resp.status, detail: body.slice(0, 200) };
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
				return await post("https://api2.pushdeer.com/message/push", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ pushkey: target.key, type: "markdown", text: `${title}\n\n${body}` }),
				});
			case "wecom": {
				// 企业微信机器人 markdown 上限 4096 字节
				// markdown 上限 4096 字节,中文 UTF-8 3 字节 → 保守 1200 字符
				const content = (`${title}\n\n${body}`).slice(0, 1200);
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
				const server = (target.server || "https://api.day.app").replace(/\/+$/, "");
				return await post(`${server}/${target.key}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`);
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
 * 逐个投递。返回 {results, okCount}。
 * @param {any[]} targets @param {string} digestText
 */
export async function deliverAll(targets, digestText) {
	const nl = digestText.indexOf("\n");
	const title = (nl > 0 ? digestText.slice(0, nl) : digestText).trim();
	const body = nl > 0 ? digestText.slice(nl + 1).trim() : "";
	const results = [];
	for (const target of targets || []) {
		const r = await sendOne(target, title, body);
		results.push({ type: target.type, ...r });
	}
	return { results, okCount: results.filter((r) => r.ok).length };
}
