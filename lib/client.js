window.__ModuleLoader__.load({
	id: "dsh-rss-daily",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const { useState, useEffect, useRef, useCallback } = React;
		const h = React.createElement;
		// 插播卡片用 portal 挂进聊天滚动区(官方 ui-message-feedback 同款姿势)
		let createPortal = null;
		try { createPortal = require("react-dom").createPortal; } catch (e) { /* 缺 react-dom 则不插播 */ }
		// 宿主原生前端件:MarkdownText 是模型回答正文用的同一个 markdown 渲染组件,
		// 静态模块表常驻(web shell 打包),拿到即与真实 assistant 消息同源渲染
		let MarkdownText = null, writeClipboard = null, IconCopy16 = null;
		try {
			const P = require("@deepseek-ai/dsh-client-ui-primitives");
			MarkdownText = P.MarkdownText || null;
			writeClipboard = P.writeClipboard || null;
			IconCopy16 = P.IconCopyOutline16 || null;
		} catch (e) { /* 版本变动拿不到:降级旧的自绘卡片 */ }

		/* ── 样式(前缀 drd-,颜色全部走 dsw 主题变量,明暗双主题兼容) ── */
		const css = `
.drd-btn{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:4px;padding:3px 6px;font-size:12px;line-height:18px;display:inline-flex;font-family:inherit}
.drd-btn:hover,.drd-btn:focus-visible{color:var(--dsw-alias-label-secondary)}
.drd-backdrop{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;padding:24px}
.drd-modal{z-index:201;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu);width:min(640px,100%);max-height:min(80vh,720px);box-shadow:var(--dsw-shadow-lv3);border-radius:12px;flex-direction:column;padding:0;display:flex;overflow:hidden}
.drd-modalHead{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.drd-modalTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;flex:1}
.drd-tabs{display:flex;gap:2px;padding:8px 12px 0;flex:none}
.drd-tab{cursor:pointer;background:0 0;border:0;border-radius:8px 8px 0 0;color:var(--dsw-alias-label-tertiary);padding:6px 12px;font-size:13px;font-family:inherit;border-bottom:2px solid transparent}
.drd-tabOn{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-label-primary)}
.drd-body{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);overflow:auto;padding:14px 16px 18px;flex:1}
.drd-row{display:flex;align-items:center;gap:8px}
.drd-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.drd-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;margin-bottom:10px}
.drd-digestTitle{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;margin:2px 0 12px}
.drd-item{display:flex;gap:8px;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l2);align-items:flex-start}
.drd-item:last-child{border-bottom:0}
.drd-num{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;flex:none;width:18px;text-align:right;line-height:22px}
.drd-tag{flex:none;border-radius:5px;padding:0 6px;font-size:11px;line-height:20px;font-weight:500;margin-top:1px}
.drd-line{color:var(--dsw-alias-label-primary);font-size:13px;line-height:22px;min-width:0;flex:1;overflow-wrap:anywhere}
.drd-src{color:var(--dsw-alias-label-tertiary);font-size:11px;text-decoration:none}
.drd-src:hover{color:var(--dsw-alias-label-secondary);text-decoration:underline}
.drd-spin{width:14px;height:14px;flex:none;border:2px solid var(--dsw-alias-fill-l3);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:drd-rot .8s linear infinite}
@keyframes drd-rot{to{transform:rotate(360deg)}}
.drd-act{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font-size:12px;font-family:inherit}
.drd-act:hover{background:var(--dsw-alias-fill-l2)}
.drd-act:disabled{opacity:.5;cursor:default}
.drd-actPri{background:var(--dsw-alias-accent-solid,#3b82f6);border-color:transparent;color:#fff}
.drd-actPri:hover{background:var(--dsw-alias-accent-solid-hover,#2563eb)}
.drd-input{box-sizing:border-box;background:var(--dsw-alias-fill-l1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);padding:5px 8px;font-size:12px;font-family:inherit;width:100%}
.drd-input:focus{outline:none;border-color:var(--dsw-alias-label-secondary)}
.drd-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.drd-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.drd-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
.drd-trow{display:grid;grid-template-columns:110px 1fr 26px;gap:6px;align-items:center;margin-bottom:6px}
.drd-catHead{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;margin:12px 0 4px}
.drd-srcRow{display:flex;align-items:center;gap:8px;padding:4px 0}
.drd-srcName{color:var(--dsw-alias-label-primary);font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.drd-toggle{cursor:pointer;background:0 0;border:0;color:var(--dsw-alias-label-tertiary);font-size:12px;padding:2px 6px;border-radius:6px;font-family:inherit;flex:none}
.drd-toggle:hover{color:var(--dsw-alias-label-secondary)}
.drd-err{color:var(--dsw-alias-label-warn,#e5484d);font-size:12px;line-height:18px;margin-top:8px}
.drd-ok{color:var(--dsw-alias-label-done,#30a46c);font-size:12px;line-height:18px;margin-top:8px}
/* ── 对话内插播(portal 进聊天滚动区;正文交给宿主 MarkdownText 渲染,
   与模型回答同一组件同一 CSS;此处只复刻 AssistantMarkdown 的外壳容器) ── */
/* 插播默认挂进宿主消息列末尾:宽度/缩进/间距全部继承列样式,与真实消息一致;
   仅当找不到消息列(未来版本类名变化)才退回 composer 前占位模式 */
.drd-bwrap{animation:drd-in .35s ease}
.drd-bwrapSeat{width:min(var(--dsh-chat-content-width,748px),100%);box-sizing:border-box;margin:16px auto 0;padding:0 16px}
@keyframes drd-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.drd-msg{color:var(--dsw-alias-label-primary);flex-direction:column;font-size:16px;line-height:28px;display:flex}
/* 消息体 = 宿主 AssistantMarkdown body 容器复刻(Sxvs8a_body);内容是宿主组件,自带全部 markdown 样式 */
.drd-msgBody{flex-direction:column;gap:16px;display:flex;min-width:0}
/* 操作行 = 宿主 assistant actions 几何复刻(Sxvs8a_actions:margin-top16/left-6) */
.drd-msgMeta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-top:16px;margin-left:-6px;display:flex;align-items:center;gap:2px;flex-wrap:wrap}
.drd-msgAct svg{width:14px;height:14px;vertical-align:-2px}
/* 操作按钮复刻宿主消息 actions 行(tertiary 色小按钮,hover 提亮,无下划线) */
.drd-msgAct{cursor:pointer;background:0 0;border:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:6px;font-family:inherit}
.drd-msgAct:hover{color:var(--dsw-alias-label-secondary)}
.drd-brun{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:16px;line-height:28px}
/* ── 移动端适配:触屏加大点击目标、输入 16px 防 iOS 聚焦自动缩放;
   窄屏面板近全屏、双列栅格降单列、目标行折行、头部按钮只留图标 ── */
@media (pointer:coarse){
.drd-input{font-size:16px}
.drd-btn,.drd-act,.drd-tab,.drd-toggle,.drd-msgAct{min-height:36px}
.drd-act{padding:8px 14px}
.drd-tab{padding:9px 12px}
.drd-msgAct{padding:9px 7px}
.drd-toggle{padding:7px 10px}
.drd-src{padding:3px 0}
}
@media (max-width:520px){
.drd-backdrop{padding:10px}
.drd-modal{width:100%;max-height:calc(100vh - 20px)}
.drd-grid{grid-template-columns:1fr}
.drd-trow{grid-template-columns:minmax(0,1fr) auto}
.drd-trow>.drd-row{grid-column:1/-1}
.drd-btnLabel{display:none}
@supports (height:100dvh){.drd-modal{max-height:calc(100dvh - 20px)}}
}
@supports (height:100dvh){.drd-backdrop{height:100dvh}}
/* ── 图标:Lucide 几何(MIT),currentColor 跟主题;动效=描边绘制/悬停旋转/微摆 ── */
.drd-ic{width:14px;height:14px;flex:none;display:inline-block;vertical-align:-2px}
.drd-modalTitle .drd-ic{width:15px;height:15px;vertical-align:-3px}
.drd-draw path,.drd-draw rect{stroke-dasharray:90;stroke-dashoffset:90;animation:drd-draw .55s ease forwards}
@keyframes drd-draw{to{stroke-dashoffset:0}}
.drd-check path{stroke-dasharray:26;stroke-dashoffset:26;animation:drd-draw .4s ease .08s forwards}
.drd-x,.drd-plus{transition:transform .2s ease}
.drd-x:hover,.drd-plus:hover{transform:rotate(90deg)}
.drd-news{transition:transform .25s ease}
.drd-news:hover{transform:rotate(-8deg) scale(1.1)}
.drd-newsLive{animation:drd-sway 3.2s ease-in-out infinite}
@keyframes drd-sway{0%,64%,100%{transform:rotate(0)}70%{transform:rotate(-8deg)}78%{transform:rotate(5deg)}86%{transform:rotate(-3deg)}}
@media (prefers-reduced-motion:reduce){.drd-draw path,.drd-draw rect,.drd-check path,.drd-newsLive{animation:none;stroke-dashoffset:0}.drd-x,.drd-plus,.drd-news{transition:none}}
`;
		const tagId = "dsh-rss-daily/panel.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-rss-daily";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/* ── i18n(极简两语) ── */
		const zh = navigator.language && navigator.language.toLowerCase().startsWith("zh");
		const t = zh ? {
			title: "每日要闻", tabDigest: "日报", tabSources: "源", tabSettings: "设置",
			getBtn: "获取今日日报", redoBtn: "重新生成", running: "运行中", phaseStart: "准备中",
			phaseFetch: "抓取源中…", phaseLlm: "模型编辑中…", phaseFinalize: "编排定稿中…",
			phaseDeliver: "投递中…", empty: "今天还没有日报", sent: "今日已送达", pending: "已生成待投递",
			time: "自动播报时间(本地)", targets: "投递目标", addTarget: "添加目标", delTarget: "删",
			digestItems: "每日条数", footer: "日报尾注", provider: "Provider(留空=默认)", model: "模型(留空=默认)",
			save: "保存", saved: "已保存", sources: "个源", disabled: "已停用", enable: "启用", disable: "停用",
			addSource: "添加源", name: "名称", url: "URL", category: "类目", tier: "层级",
			close: "关闭", emptyNews: "今天没有新东西(源全挂或全是重复)", deliverFail: "已生成但全部投递失败",
			confirmDel: "删除该目标?", dailyAt: "每天 {time} 自动生成并投递",
			bcast: "在对话里插播日报(仅前端显示,不占用上下文)", bcastRunning: "今日要闻生成中",
			noCtx: "仅前端展示 · 不占用对话上下文", openPanel: "打开完整面板", hideToday: "今天不再显示",
			copyBtn: "复制", copied: "已复制",
			aiEdit: "AI 编辑", ruleEdit: "规则编排",
		} : {
			title: "Daily Digest", tabDigest: "Digest", tabSources: "Sources", tabSettings: "Settings",
			getBtn: "Get today's digest", redoBtn: "Regenerate", running: "running", phaseStart: "preparing",
			phaseFetch: "fetching sources…", phaseLlm: "LLM editing…", phaseFinalize: "finalizing…",
			phaseDeliver: "delivering…", empty: "No digest yet today", sent: "delivered today", pending: "generated, pending delivery",
			time: "Auto schedule (local)", targets: "Delivery targets", addTarget: "Add target", delTarget: "del",
			digestItems: "Max items/day", footer: "Footer", provider: "Provider (blank=default)", model: "Model (blank=default)",
			save: "Save", saved: "Saved", sources: "sources", disabled: "disabled", enable: "enable", disable: "disable",
			addSource: "Add source", name: "Name", url: "URL", category: "Category", tier: "Tier",
			close: "Close", emptyNews: "Nothing new today (sources failed or all dupes)", deliverFail: "Generated but all deliveries failed",
			confirmDel: "Delete this target?", dailyAt: "Auto generate & deliver daily at {time}",
			bcast: "Insert digest into the chat (frontend-only, no context cost)", bcastRunning: "Generating today's digest",
			noCtx: "frontend-only · no context cost", openPanel: "Open full panel", hideToday: "Hide for today",
			copyBtn: "Copy", copied: "Copied",
			aiEdit: "AI-edited", ruleEdit: "rule-based",
		};
		const fmt = (s, m) => s.replace(/\{(\w+)\}/g, (_, k) => m[k] ?? "");

		/* ── API ── */
		// 弱网(尤其手机)下防 fetch 挂死:20s 超时,超时按网络错误走各处 catch
		const fetchOpt = () => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(20000) } : {});
		const api = {
			get: (p) => fetch("/rss-daily/api/" + p, fetchOpt()).then((r) => r.json()),
			send: (p, body, method = "POST") => fetch("/rss-daily/api/" + p, {
				method, headers: { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				...fetchOpt(),
			}).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) })),
		};

		const TAG_COLORS = {
			AI: "#3b82f6", 科技: "#06b6d4", 科学: "#8b5cf6", 国际: "#f97316", 财经: "#d97706",
			人文: "#a16207", 开发: "#16a34a", 健康: "#e5484d", 环境: "#059669", 社会: "#6b7280",
			商业: "#6366f1", 产品: "#ec4899", 研究: "#4f46e5",
		};
		const tagStyle = (tag) => {
			const c = TAG_COLORS[tag] || "#6b7280";
			return { color: c, background: c + "22" };
		};

		/* ── 图标(Lucide 几何,MIT;描边走 currentColor,明暗主题自动适配) ── */
		const svgProps = (cls) => ({
			viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
			strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
			className: "drd-ic " + (cls || ""), "aria-hidden": "true",
		});
		const IcNews = (cls) => h("svg", svgProps("drd-news " + (cls || "")),
			h("path", { d: "M15 18h-5m8-4h-8m-6 8h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2" }),
			h("rect", { width: 8, height: 4, x: 10, y: 6, rx: 1 }));
		const IcX = () => h("svg", svgProps("drd-x"), h("path", { d: "M18 6L6 18M6 6l12 12" }));
		const IcPlus = () => h("svg", svgProps("drd-plus"), h("path", { d: "M5 12h14m-7-7v14" }));
		const IcCheck = () => h("svg", svgProps("drd-check"), h("path", { d: "M20 6L9 17l-5-5" }));

		/* ── 面板 ── */
		function Panel({ open, tab, onClose }) {
			const [cur, setCur] = useState(tab || "digest");
			const [st, setSt] = useState(null);
			const [err, setErr] = useState("");
			useEffect(() => { if (tab) setCur(tab); }, [tab]);
			useEffect(() => {
				if (!open) return;
				let stop = false;
				const poll = async () => {
					if (document.visibilityState === "hidden") return; // 后台标签页不轮询(手机省电)
					try {
						const s = await api.get("status");
						if (!stop) { setSt(s); setErr(s.error ? String(s.error) : ""); }
					} catch (e) { if (!stop) setErr(String(e)); }
				};
				poll();
				const timer = setInterval(poll, 2500);
				const vis = () => { if (!stop && document.visibilityState === "visible") poll(); };
				document.addEventListener("visibilitychange", vis);
				return () => { stop = true; clearInterval(timer); document.removeEventListener("visibilitychange", vis); };
			}, [open]);
			// Esc 关闭(基础键盘可达性;无焦点陷阱,靠 role="dialog" + 遮罩点击兜底)
			useEffect(() => {
				if (!open) return;
				const onKey = (e) => { if (e.key === "Escape") onClose(); };
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [open, onClose]);

			if (!open) return null;
			const run = async (redo) => {
				setErr("");
				try {
					const r = await api.send(redo ? "redo" : "run");
					if (!r.ok) setErr(r.data?.error || "request failed");
					else {
						setSt((s) => (s ? { ...s, running: true, phase: "start" } : s));
						// 主动要日报 = 解除"今天不再显示":点完按钮插播必须能出现
						window.dispatchEvent(new CustomEvent("rss-daily:unhide"));
					}
				} catch (e) { setErr(String(e)); }
			};
			const phaseMap = { start: t.phaseStart, fetch: t.phaseFetch, llm: t.phaseLlm, finalize: t.phaseFinalize, deliver: t.phaseDeliver };
			const phaseText = st?.running ? (phaseMap[st.phase] || st.phase || "") : null;

			return h("div", { className: "drd-backdrop", onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
				h("div", { className: "drd-modal", role: "dialog", "aria-modal": "true", onClick: (e) => e.stopPropagation() },
					h("div", { className: "drd-modalHead" },
						h("div", { className: "drd-modalTitle" }, IcNews("drd-draw"), " " + t.title),
						st && !st.running && st.config
							? h("span", { className: "drd-hint" }, fmt(t.dailyAt, { time: st.config.time }))
							: null,
						h("button", { className: "drd-btn", onClick: onClose, "aria-label": t.close }, IcX()),
					),
					h("div", { className: "drd-tabs" },
						["digest", "sources", "settings"].map((k) => h("button", {
							key: k, className: "drd-tab" + (cur === k ? " drd-tabOn" : ""), onClick: () => setCur(k),
						}, t["tab" + k[0].toUpperCase() + k.slice(1)])),
					),
					h("div", { className: "drd-body" },
						cur === "digest" ? h(DigestTab, { st, err, phaseText, onRun: run }) : null,
						cur === "sources" ? h(SourcesTab, {}) : null,
						cur === "settings" ? h(SettingsForm, { st }) : null,
					),
				));
		}

		function DigestTab({ st, err, phaseText, onRun }) {
			const done = st && !st.running;
			return h(React.Fragment, null,
				h("div", { className: "drd-row", style: { marginBottom: 12 } },
					st?.running
						? h(React.Fragment, null,
							h("span", { className: "drd-spin" }),
							h("span", { className: "drd-hint" }, phaseText))
						: h(React.Fragment, null,
							h("button", { className: "drd-act drd-actPri", onClick: () => onRun(false) }, t.getBtn),
							h("button", { className: "drd-act", onClick: () => onRun(true) }, t.redoBtn),
							st?.confirmed ? h("span", { className: "drd-ok" }, IcCheck(), " " + t.sent)
								: st?.digest ? h("span", { className: "drd-hint" }, t.pending) : null),
				),
				err ? h("div", { className: "drd-err" }, err) : null,
				st && st.items && st.items.length > 0
					? h("div", { className: "drd-card" },
						h("div", { className: "drd-digestTitle" }, (st.digest || "").split("\n")[0] || t.title),
						st.items.map((it) => h("div", { key: it.n, className: "drd-item" },
							h("span", { className: "drd-num" }, it.n + "."),
							h("span", { className: "drd-tag", style: tagStyle(it.tag) }, it.tag),
							h("div", { className: "drd-line" },
								h("span", null, it.one_liner),
								" ",
								h("a", { className: "drd-src", href: it.link, target: "_blank", rel: "noreferrer" }, it.source),
							),
						)))
					: (done ? h("div", { className: "drd-hint" }, t.emptyNews) : null),
			);
		}

		function SourcesTab() {
			const [list, setList] = useState(null);
			const [err, setErr] = useState("");
			const [adding, setAdding] = useState(false);
			const [draft, setDraft] = useState({ name: "", url: "", category: "科技", tier: 3 });
			const load = useCallback(async () => {
				try { setList((await api.get("sources")).sources || []); setErr(""); } catch (e) { setErr(String(e)); }
			}, []);
			useEffect(() => { load(); }, [load]);
			const save = async (next) => {
				try {
					const r = await api.send("sources", { sources: next }, "PUT");
					if (r.ok) setList(next); else setErr(r.data?.error || "save failed");
				} catch (e) { setErr(String(e)); }
			};
			const toggle = (name) => {
				const next = list.map((s) => (s.name === name ? { ...s, disabled: !s.disabled } : s));
				save(next);
			};
			const add = () => {
				if (!draft.name || !/^https?:\/\//.test(draft.url)) { setErr("name / http(s) url required"); return; }
				const next = [...list, { name: draft.name, url: draft.url, category: draft.category || "科技", tier: Number(draft.tier) || 3 }];
				save(next);
				setAdding(false); setDraft({ name: "", url: "", category: "科技", tier: 3 });
			};
			if (!list) return h("div", { className: "drd-hint" }, "…");
			const cats = {};
			for (const s of list) (cats[s.category] = cats[s.category] || []).push(s);
			return h(React.Fragment, null,
				h("div", { className: "drd-row", style: { marginBottom: 8 } },
					h("span", { className: "drd-hint" }, list.length + " " + t.sources + " · " + Object.keys(cats).length + " " + t.category),
					h("span", { style: { flex: 1 } }),
					h("button", { className: "drd-act", onClick: () => setAdding(!adding) }, t.addSource)),
				err ? h("div", { className: "drd-err" }, err) : null,
				adding ? h("div", { className: "drd-card drd-grid" },
					h("div", { className: "drd-field" }, h("span", { className: "drd-label" }, t.name),
						h("input", { className: "drd-input", value: draft.name, onChange: (e) => setDraft({ ...draft, name: e.target.value }) })),
					h("div", { className: "drd-field" }, h("span", { className: "drd-label" }, t.category + " / " + t.tier),
						h("div", { className: "drd-row" },
							h("input", { className: "drd-input", value: draft.category, onChange: (e) => setDraft({ ...draft, category: e.target.value }) }),
							h("select", { className: "drd-input", style: { width: 70 }, value: draft.tier, onChange: (e) => setDraft({ ...draft, tier: Number(e.target.value) }) },
								[1, 2, 3].map((n) => h("option", { key: n, value: n }, "T" + n))))),
					h("div", { className: "drd-field", style: { gridColumn: "1 / -1" } }, h("span", { className: "drd-label" }, t.url),
						h("div", { className: "drd-row" },
							h("input", { className: "drd-input", placeholder: "https://…/feed.xml", value: draft.url, onChange: (e) => setDraft({ ...draft, url: e.target.value }) }),
							h("button", { className: "drd-act drd-actPri", style: { flex: "none" }, onClick: add }, IcPlus()))),
				) : null,
				Object.keys(cats).sort().map((cat) => h("div", { key: cat },
					h("div", { className: "drd-catHead" }, cat + " · " + cats[cat].length),
					cats[cat].map((s) => h("div", { key: s.name, className: "drd-srcRow" },
						h("span", { className: "drd-srcName", style: s.disabled ? { opacity: .45 } : null, title: s.url }, "T" + (s.tier || 3) + " " + s.name),
						h("button", { className: "drd-toggle", onClick: () => toggle(s.name) }, s.disabled ? t.enable : t.disable),
					)))),
			);
		}

		const TARGET_FIELDS = {
			serverchan: ["key"], pushdeer: ["key"], wecom: ["key"],
			telegram: ["token", "chatId"], bark: ["key", "server"], gotify: ["token", "server"], custom: ["url"],
		};
		function SettingsForm({ st }) {
			const [draft, setDraft] = useState(null);
			const [msg, setMsg] = useState("");
			const [err, setErr] = useState("");
			useEffect(() => { if (st?.config && !draft) { const c = JSON.parse(JSON.stringify(st.config)); c.targets = c.targets || []; setDraft(c); } }, [st, draft]);
			if (!draft) return h("div", { className: "drd-hint" }, "…");
			const set = (k, v) => setDraft({ ...draft, [k]: v });
			const setT = (i, k, v) => {
				const next = draft.targets.map((x, j) => (i === j ? { ...x, [k]: v } : x));
				setDraft({ ...draft, targets: next });
			};
			const save = async () => {
				setErr(""); setMsg("");
				try {
					const body = {
						time: draft.time, enabled: draft.enabled, digestItems: Number(draft.digestItems) || 8,
						footer: draft.footer || "", llmProvider: draft.llmProvider || "", llmModel: draft.llmModel || "",
						broadcast: draft.broadcast !== false,
						targets: draft.targets || [],
					};
					const r = await api.send("config", body);
					if (r.ok) { setMsg(t.saved); if (r.data?.config) setDraft(JSON.parse(JSON.stringify(r.data.config))); }
					else setErr(r.data?.error || "save failed");
				} catch (e) { setErr(String(e)); }
			};
			return h(React.Fragment, null,
				h("div", { className: "drd-grid" },
					h("div", { className: "drd-field" }, h("span", { className: "drd-label" }, t.time),
						h("div", { className: "drd-row" },
							h("input", { className: "drd-input", value: draft.time, placeholder: "08:00", onChange: (e) => set("time", e.target.value) }),
							h("label", { className: "drd-hint", style: { flex: "none", whiteSpace: "nowrap" } },
								h("input", { type: "checkbox", checked: draft.enabled, onChange: (e) => set("enabled", e.target.checked) }), " " + t.running))),
					h("div", { className: "drd-field" }, h("span", { className: "drd-label" }, t.bcast),
						h("label", { className: "drd-hint" },
							h("input", { type: "checkbox", checked: draft.broadcast !== false, onChange: (e) => set("broadcast", e.target.checked) }),
							" " + (draft.broadcast !== false ? "ON" : "OFF"))),
					h("div", { className: "drd-field" }, h("span", { className: "drd-label" }, t.digestItems),
						h("input", { className: "drd-input", type: "number", min: 1, max: 20, value: draft.digestItems, onChange: (e) => set("digestItems", e.target.value) })),
					h("div", { className: "drd-field" }, h("span", { className: "drd-label" }, t.provider),
						h("input", { className: "drd-input", value: draft.llmProvider || "", onChange: (e) => set("llmProvider", e.target.value) })),
					h("div", { className: "drd-field" }, h("span", { className: "drd-label" }, t.model),
						h("input", { className: "drd-input", value: draft.llmModel || "", onChange: (e) => set("llmModel", e.target.value) })),
					h("div", { className: "drd-field", style: { gridColumn: "1 / -1" } }, h("span", { className: "drd-label" }, t.footer),
						h("input", { className: "drd-input", value: draft.footer || "", onChange: (e) => set("footer", e.target.value) })),
				),
				h("div", { className: "drd-row", style: { margin: "6px 0 8px" } },
					h("span", { className: "drd-label" }, t.targets),
					h("span", { style: { flex: 1 } }),
					h("button", { className: "drd-act", onClick: () => setDraft({ ...draft, targets: [...draft.targets, { type: "serverchan", key: "" }] }) }, IcPlus(), " " + t.addTarget)),
				draft.targets.map((tg, i) => h("div", { key: i, className: "drd-trow" },
					h("select", { className: "drd-input", value: tg.type, onChange: (e) => {
						const clean = { type: e.target.value };
						for (const f of TARGET_FIELDS[e.target.value] || []) clean[f] = "";
						setT(i, "type", e.target.value); setDraft((d) => ({ ...d, targets: d.targets.map((x, j) => (i === j ? clean : x)) }));
					} }, Object.keys(TARGET_FIELDS).map((k) => h("option", { key: k, value: k }, k))),
					h("div", { className: "drd-row" },
						(TARGET_FIELDS[tg.type] || []).map((f) => h("input", {
							key: f, className: "drd-input", style: { flex: f === "chatId" ? 1 : 2 },
							placeholder: f, value: tg[f] || "", type: /key|token/i.test(f) ? "password" : "text",
							onChange: (e) => setT(i, f, e.target.value),
						}))),
					h("button", { className: "drd-toggle", onClick: () => {
						if (draft.targets.length <= 1 || window.confirm(t.confirmDel)) setDraft({ ...draft, targets: draft.targets.filter((_, j) => j !== i) });
					} }, IcX()),
				)),
				h("div", { className: "drd-row", style: { marginTop: 12 } },
					h("button", { className: "drd-act drd-actPri", onClick: save }, t.save),
					msg ? h("span", { className: "drd-ok" }, IcCheck(), " " + msg) : null,
					err ? h("span", { className: "drd-err" }, err) : null),
			);
		}

		/* ── 对话内插播:portal 进聊天滚动区([data-conversation-scroll]),
		   挂在会话内容与输入区之间 → 视觉上是"对话里最新一条消息"。
		   纯前端 DOM,不写会话日志、不进模型上下文;关闭只影响本浏览器。 ── */
		const BCAST_LS = "dsh-rss-daily:bcast-dismissed";
		const strHash = (s) => { let x = 5381; for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0; return (x >>> 0).toString(36); };
		function conversationHasContent(scroller) {
			for (const child of scroller.children) {
				if (child.getAttribute("data-slot") === "conversation.session") return child.childElementCount > 0;
			}
			return false;
		}
		function findConversationScroller() {
			for (const scroller of document.querySelectorAll("[data-conversation-scroll]")) {
				if (conversationHasContent(scroller)) return scroller;
			}
			return null;
		}

		// 宿主消息列 = flowItem 的父节点。插播挂进它末尾,宽度/缩进/消息间距
		// 全部自动继承,观感与真实消息一致;找不到列则返回 null 走占位降级。
		function findMessageColumn() {
			const scroller = findConversationScroller();
			if (!scroller) return null;
			const fi = scroller.querySelector('[class*="flowItem"]');
			return fi ? fi.parentElement : null;
		}

		// 日报拼成模型回答形态的 markdown:首行标题段落 + 有序编号列表,
		// 来源做成链接——和模型输出日报的结构一字不差。
		function digestMarkdown(st) {
			const title = (st.digest || "").split("\n")[0] || t.title;
			const lines = (st.items || []).map((it) =>
				it.n + ". 【" + it.tag + "】" + it.one_liner.replace(/\s+$/, "") +
				"（[" + it.source + "](" + it.link + ")）");
			return title + "\n\n" + lines.join("\n");
		}

		// 日报按"模型回答"的原样呈现:正文走宿主 MarkdownText(与真实 assistant
		// 消息同一组件,样式/链接/列表渲染天然一致),len<全长时以 streaming 态
		// 渐显,观感等同模型正在作答;渲染件拿不到时降级旧自绘卡片。
		function BcastCard({ st, md, len, done, onDismiss }) {
			const [copied, setCopied] = useState(false);
			const copy = async () => {
				try {
					if (writeClipboard) await writeClipboard(md);
					else await navigator.clipboard.writeText(md);
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				} catch (e) { /* 剪贴板不可用则忽略 */ }
			};
			const actions = done ? h("div", { className: "drd-msgMeta" },
				h("button", { className: "drd-msgAct", onClick: copy },
					IconCopy16 ? h(IconCopy16, null) : null, " " + (copied ? t.copied : t.copyBtn)),
				h("button", { className: "drd-msgAct", onClick: () => window.dispatchEvent(new CustomEvent("rss-daily:open", { detail: { tab: "digest" } })) }, t.openPanel),
				h("button", { className: "drd-msgAct", onClick: onDismiss }, t.hideToday)) : null;
			if (MarkdownText) {
				return h("div", { className: "drd-msg", "data-streaming": done ? undefined : "" },
					h("div", { className: "drd-msgBody" },
						h(MarkdownText, { text: md.slice(0, len), streaming: !done })),
					actions);
			}
			// 降级:宿主渲染件不可用时保持自绘(样式仍是消息流复刻)
			const title = (st.digest || "").split("\n")[0] || t.title;
			return h("div", { className: "drd-msg" },
				h("div", { className: "drd-msgBody" },
					h("p", null, title),
					h("ol", null,
						st.items.map((it) => h("li", { key: it.n },
							"【" + it.tag + "】",
							it.one_liner.replace(/\s*$/, ""),
							" ",
							h("a", { href: it.link, target: "_blank", rel: "noreferrer" }, "（" + it.source + "）"),
						)))),
				actions);
		}

		function BroadcastHost() {
			const [st, setSt] = useState(null);
			const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(BCAST_LS) || ""; } catch { return ""; } });
			const [host, setHost] = useState(null);
			const [reveal, setReveal] = useState(null); // {id,len}:新日报的打字机进度
			const divRef = useRef(null);
			const startedRef = useRef(""); // 已开始渐显的日报 id(跨轮询去重)

			// 用户在面板主动点"获取/重新生成" → 解除"今天不再显示"(明确想看)
			useEffect(() => {
				const unhide = () => {
					try { localStorage.removeItem(BCAST_LS); } catch { }
					setDismissed("");
				};
				window.addEventListener("rss-daily:unhide", unhide);
				return () => window.removeEventListener("rss-daily:unhide", unhide);
			}, []);

			// 慢轮询发现新日报(空闲 20s,运行中 2.5s 跟进度;后台标签页跳过)
			useEffect(() => {
				let stop = false, timer = null;
				const poll = async () => {
					if (document.visibilityState === "hidden") { // 后台标签页不轮询(省电),回到前台由 vis 立即补
						timer = setTimeout(poll, 20000);
						return;
					}
					let s = null;
					try { s = await api.get("status"); } catch { }
					if (stop) return;
					if (s) setSt(s);
					timer = setTimeout(poll, s && s.running ? 2500 : 20000);
				};
				const vis = () => { if (document.visibilityState === "visible") { clearTimeout(timer); poll(); } };
				poll();
				document.addEventListener("visibilitychange", vis);
				return () => { stop = true; clearTimeout(timer); document.removeEventListener("visibilitychange", vis); };
			}, []);

			// 挂载点:优先宿主消息列末尾(最后一条消息之后,列样式全继承);
			// 消息列找不到才退回"会话内容与输入区之间"占位。挂载条件是"会话有
			// 内容":空白新会话不插播,但用户一发消息或切到历史会话就要能补挂 →
			// 持续慢轮询找位;宿主 div 随会话切换失联则重挂。
			useEffect(() => {
				if (!createPortal) return;
				let stop = false, timer = null, colMisses = 0;
				const find = () => {
					if (stop) return;
					if (divRef.current && !divRef.current.isConnected) { divRef.current = null; setHost(null); colMisses = 0; }
					if (!divRef.current) {
						const div = document.createElement("div");
						div.dataset.dshPlugin = "dsh-rss-daily";
						const col = findMessageColumn();
						if (col) {
							div.className = "drd-bwrap";
							col.appendChild(div);
							divRef.current = div;
							setHost(div);
						} else {
							// 消息列可能晚于滚动区渲染:先持续等它;长期找不到
							// (未来版本 DOM 变化)才退回"会话与输入区之间"占位
							const scroller = findConversationScroller();
							if (scroller && colMisses++ > 40) {
								let seat = null;
								for (const c of scroller.children) if (c.hasAttribute && c.hasAttribute("data-composer-seat")) { seat = c; break; }
								div.className = "drd-bwrap drd-bwrapSeat";
								scroller.insertBefore(div, seat || null);
								divRef.current = div;
								setHost(div);
							}
						}
					}
					timer = setTimeout(find, 800);
				};
				find();
				return () => { stop = true; clearTimeout(timer); if (divRef.current && divRef.current.parentNode) divRef.current.parentNode.removeChild(divRef.current); divRef.current = null; };
			}, []);

			const on = st?.config?.broadcast !== false;
			// 不再比对浏览器日期与服务器 today:跨午夜后两者差一天会让当日
			// 日报永远不显示。日报标题自带日期;新版生成后 id 变化自动替换。
			const ready = !!(st && st.items && st.items.length > 0 && st.digest);
			const id = ready ? st.today + ":" + strHash(st.digest) : null;
			const md = ready ? digestMarkdown(st) : "";
			const dismiss = () => { try { localStorage.setItem(BCAST_LS, id || ""); } catch { } setDismissed(id || "?"); };

			// 新日报首次上屏:以"模型打字"节奏前缀渐显(streaming 渲染态,完稿前
			// 不显示操作行,与真实生成中的消息一致);reduced-motion / 降级模式
			// 直接整篇。md 为稳定字符串,轮询刷新不会重启动画。
			useEffect(() => {
				if (!ready || !id || !md || id === dismissed || id === startedRef.current) return;
				startedRef.current = id;
				const full = md.length;
				let reduce = false;
				try { reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { }
				if (!MarkdownText || reduce) { setReveal({ id, len: full }); return; }
				setReveal({ id, len: 0 });
				let timer = null, i = 0;
				const tick = () => {
					i = Math.min(full, i + 22 + Math.floor(Math.random() * 26));
					setReveal({ id, len: i });
					if (i < full) timer = setTimeout(tick, 70 + Math.random() * 90);
				};
				timer = setTimeout(tick, 400); // 起笔前的短暂停顿
				// visibilitychange 一律快进:后台标签加载时 tick 可能从未启动
				// (reveal 停在 0),回前台必须能出全文;动画中切走的同样直接完稿
				const onVis = () => { clearTimeout(timer); setReveal({ id, len: full }); };
				document.addEventListener("visibilitychange", onVis);
				return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
			}, [id, ready, md, dismissed]);

			if (!createPortal || !host) return null;
			let content = null;
			if (st?.running) {
				const phaseMap = { start: t.phaseStart, fetch: t.phaseFetch, llm: t.phaseLlm, finalize: t.phaseFinalize, deliver: t.phaseDeliver };
				content = h("div", { className: "drd-msg" },
					h("div", { className: "drd-brun" },
						h("span", { className: "drd-spin" }), " " + t.bcastRunning + " · " + (phaseMap[st.phase] || st.phase || "")));
			} else if (on && ready && id !== dismissed) {
				// reveal 尚未初始化(首帧)不渲染,避免整篇闪现后再从头渐显
				const rv = reveal && reveal.id === id ? reveal : null;
				if (rv) {
					const len = Math.min(rv.len, md.length);
					content = h(BcastCard, { st, md, len, done: len >= md.length, onDismiss: dismiss });
				}
			}
			return content ? createPortal(content, host) : null;
		}

		/* ── 宿主组件:头部按钮(开面板) / 输入区 overlay(承载面板+插播) / 设置卡片 ── */
		function PanelHost() {
			const [state, setState] = useState({ open: false, tab: "digest" });
			useEffect(() => {
				const open = (e) => setState({ open: true, tab: (e.detail && e.detail.tab) || "digest" });
				window.addEventListener("rss-daily:open", open);
				return () => window.removeEventListener("rss-daily:open", open);
			}, []);
			return h(Panel, { ...state, onClose: () => setState({ open: false }) });
		}

		function HeaderButton() {
			return h("button", {
				className: "drd-btn", title: t.title,
				onClick: () => window.dispatchEvent(new CustomEvent("rss-daily:open", { detail: { tab: "digest" } })),
			}, IcNews("drd-newsLive"), h("span", { className: "drd-btnLabel" }, zh ? "要闻" : "News"));
		}

		function SettingsCard() {
			const [st, setSt] = useState(null);
			useEffect(() => {
				api.get("status").then(setSt).catch(() => { });
				const timer = setInterval(() => { if (document.visibilityState !== "hidden") api.get("status").then(setSt).catch(() => { }); }, 30000);
				return () => clearInterval(timer);
			}, []);
			return h("div", { className: "drd-card", style: { marginTop: 8 } },
				h("div", { className: "drd-modalTitle", style: { marginBottom: 8 } }, IcNews("drd-draw"), " " + t.title),
				h(SettingsForm, { st }));
		}

		/* ── 插件体(挂载写法对齐官方 ui-jobs:slots.inject 直接返回托底) ── */
		const inject = ["slots"];
		function apply(ctx) {
			const safe = (slotName, id, order, comp, key) => {
				try {
					ctx.slots.inject(slotName, () => ctx.slots.register(
						key ? { name: slotName, id, order, key } : { name: slotName, id, order }, comp));
				} catch (e) { console.warn("[dsh-rss-daily] slot skipped:", slotName, e); }
			};
			safe("conversation.session.header.actions", "rss-daily", 30, HeaderButton);
			safe("conversation.input.overlay", "rss-daily-panel", 30, PanelHost);
			// 插播:独立注册(list 槽可与其他插件共存),portal 卡片进聊天流
			safe("conversation.input.overlay", "rss-daily-broadcast", 40, BroadcastHost);
			// settings.plugin.item 是 keyed slot:按命名空间派发,卡片与宿主 settings 注册配对
			safe("settings.plugin.item", "rss-daily", 30, SettingsCard, "rss-daily");
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
