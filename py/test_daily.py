"""纯函数单测:清洗/去重/类目限额/截断逻辑,不触网不落盘。"""
import hashlib
from datetime import timedelta
import importlib.util
import re
from pathlib import Path

_spec = importlib.util.spec_from_file_location("daily", Path(__file__).with_name("daily.py"))
daily = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(daily)


def test_strip_html():
	assert daily.strip_html("<p>苹果 <b>发布</b></p>") == "苹果 发布"
	assert daily.strip_html(None) == ""
	assert daily.strip_html("  无标签  ") == "无标签"


def test_fix_mojibake_roundtrip():
	moji = "苹果".encode("utf-8").decode("cp1252")
	assert daily.fix_mojibake(moji) == "苹果"


def test_fix_mojibake_clean_noop():
	s = "正常的中文标题 normal title"
	assert daily.fix_mojibake(s) == s


def test_tokenize_mixed():
	t = daily.tokenize("Apple 发布 M6 芯片苹果新机")
	assert {"apple", "m6", "苹果", "芯片"} <= t


def test_jaccard():
	assert daily.jaccard({"a", "b"}, {"a", "c"}) == 1 / 3
	assert daily.jaccard({"a"}, {"a"}) == 1.0
	assert daily.jaccard(set(), {"a"}) == 0.0


def test_title_hash_stable():
	h = daily.title_hash("苹果 发布会")
	assert h == hashlib.md5(re.sub(r"\s+", "", "苹果 发布会".lower()).encode()).hexdigest()[:16]
	assert h == daily.title_hash("苹果  发布会")
	assert len(h) == 16


def _mk(i, tag):
	return {"tag": tag, "cand": {"category": "fallback"}, "line": f"第{i}条"}


def test_cap_per_tag_hard_cap():
	picked = [_mk(i, "科技") for i in range(5)] + [_mk(9, "国际")]
	out = daily.cap_per_tag(picked, cap=2)
	assert len(out) == 3
	assert [p["tag"] for p in out] == ["科技", "科技", "国际"]


def test_cap_per_tag_falls_back_to_category():
	picked = [{"cand": {"category": "财经"}, "line": str(i)} for i in range(3)]
	assert len(daily.cap_per_tag(picked, cap=2)) == 2


def test_cut_line_noop_when_short():
	s = "一句话,不超长。"
	assert daily.cut_line(s, "zh") == s


def test_cut_line_punctuates():
	s = "字" * 45 + "。后面的内容全都超出了限制范围"
	assert daily.cut_line(s, "zh") == "字" * 45 + "。"


def test_cut_line_hard_cut_without_punct():
	assert daily.cut_line("字" * 60, "zh") == "字" * 50
	assert len(daily.cut_line("a" * 300, "en")) == 200  # 英文按词长放宽(audit M15)


def test_parse_tz():
	assert daily.parse_tz("UTC+8").utcoffset(None) == timedelta(hours=8)
	assert daily.parse_tz("UTC-5").utcoffset(None) == timedelta(hours=-5)
	assert daily.parse_tz("UTC+5:30").utcoffset(None) == timedelta(hours=5, minutes=30)
	assert daily.parse_tz("bogus").utcoffset(None) == timedelta(hours=8)
	assert daily.parse_tz("UTC+99").utcoffset(None) == timedelta(hours=8)


def test_digest_date_shape():
	daily.ACTIVE_TZ = daily.parse_tz("UTC+9")
	try:
		import re as _re
		assert _re.search(r"\d{4}年\d{2}月\d{2}日", daily.digest_date("zh"))
		assert _re.search(r"[A-Z][a-z]{2} \d{2}, \d{4}", daily.digest_date("en"))
	finally:
		daily.ACTIVE_TZ = daily.BEIJING


def test_editor_prompt_lang():
	assert "主编" in daily.editor_prompt("zh")
	assert "editor" in daily.editor_prompt("en").lower()


def test_parse_reply_en_tags():
	pool = [{"title": "t", "link": "l", "source": "s", "category": "Tech"}]
	reply = '{"items":[{"n":1,"tag":"Tech","line":"A concrete fact with numbers 42 and version 3.2."}]}'
	out = daily.parse_reply(reply, pool, "en")
	assert out and out[0]["tag"] == "Tech"


def test_cut_line_ascii_punct():
	s = "a" * 10 + ". " + "b" * 300
	assert daily.cut_line(s, "en") == "a" * 10 + "."


# ── 2026-10 审计修复回归(不触网) ──

def test_as_completed_timeout_is_catchable():
	"""B2:fetch_all/enrich 的 except 必须接住 concurrent.futures.TimeoutError。
	3.9/3.10 上它不是内置 TimeoutError 的别名,except TimeoutError 会漏(实测)。"""
	import concurrent.futures as cf
	import time as _time
	from concurrent.futures import ThreadPoolExecutor, as_completed
	ex = ThreadPoolExecutor(max_workers=1)
	try:
		fut = ex.submit(_time.sleep, 2)
		_time.sleep(0.05)
		try:
			for _ in as_completed([fut], timeout=0.05):
				pass
			raise AssertionError("expected timeout")
		except cf.TimeoutError:
			pass  # daily.py 现在捕获的正是这个类型
	finally:
		ex.shutdown(wait=False, cancel_futures=True)


def test_pick_sources_all_disabled_returns_empty(tmp_path):
	"""M17:全部源被停用时不再 max() 崩溃。"""
	srcs = [{"name": f"s{i}", "url": f"https://x/{i}", "category": "科技",
	         "tier": 2, "disabled": True} for i in range(3)]
	assert daily.pick_sources(srcs, {}, str(tmp_path / "state.json"), 3) == []


def test_parse_reply_survives_two_json_objects():
	"""M18:贪婪正则在回复含两个 JSON 对象时静默丢掉全部编辑。"""
	pool = [{"title": "t", "link": "l", "source": "s", "category": "AI"} for _ in range(2)]
	reply = ('思考:先给个示例 {"items":[{"n":99,"tag":"AI","line":"占位示例条目"}]}\n'
			 '正式输出 {"lead":"今天的主线","items":[{"n":1,"tag":"AI","line":"OpenAI 发布了 GPT-7,上下文翻倍"}]}')
	out = daily.parse_reply(reply, pool, "zh")
	assert out and out[0]["line"].startswith("OpenAI")
	assert daily.parse_lead(reply, "zh") == "今天的主线"


def test_fetch_page_text_blocks_non_http():
	"""H4:file:/data: 链接不做正文增强(本地文件读取+注入面)。"""
	assert daily.fetch_page_text("file:///C:/Windows/win.ini") is None
	assert daily.fetch_page_text("data:text/html,<article><p>XXXX<p>YYYY</article>") is None


def test_record_tolerates_partial_health_entry():
	"""F-PY-15:health 条目缺键不再 KeyError。"""
	health = {"src1": {"total_successes": 3}}
	daily.record(health, "src1", True, 120)
	assert health["src1"]["consecutive_successes"] == 1
	daily.record(health, "src2", False, 0)
	assert health["src2"]["total_fails"] == 1


def test_load_json_survives_gbk_bytes(tmp_path):
	"""F-PY-18:非 UTF-8 状态文件按默认值处理,不抛 UnicodeDecodeError。"""
	bad = tmp_path / "bad.json"
	bad.write_bytes(b'{"k":"' + "中文".encode("gbk") + b'"}')
	assert daily.load_json(str(bad), {}) == {}


def test_format_digest_lang_titles():
	"""M14:规则/降级路径的标题语言跟 lang 走。"""
	assert daily.format_digest("Oct 02, 2026", ["a"], "", "en").startswith("Daily Digest")
	assert daily.format_digest("2026年10月02日", ["a"], "", "zh").startswith("每日要闻")
