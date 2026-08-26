"""纯函数单测:清洗/去重/类目限额/截断逻辑,不触网不落盘。"""
import hashlib
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
	assert daily.cut_line(s, 30) == s


def test_cut_line_punctuates():
	s = "字" * 25 + "。后面的内容全都超出了限制范围"
	assert daily.cut_line(s, 30) == "字" * 25 + "。"


def test_cut_line_hard_cut_without_punct():
	assert daily.cut_line("a" * 40, 30) == "a" * 30
