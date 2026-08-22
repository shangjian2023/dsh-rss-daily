#!/usr/bin/env python3
"""
dsh-rss-daily 核心管线 v1 (2026-08-22, 自 openclaw rss-fetch.py v9 移植)

移植自生产环境跑了 3 个月、9 个版本的日报管线(46 源、LLM 编辑、newsflash
多源佐证、健康度自适应超时、乱码修复、幂等门),领域逻辑原样保留。

相对 openclaw 版的改造:
  1. 分阶段 CLI:fetch → (LLM 编辑,由插件经 dsh harness 完成后回写) →
     finalize → confirm。prompt 构建与解析留在本文件,插件只做传输管道,
     避免 EDITOR_PROMPT/TAG_VOCAB 双份维护。
  2. 跨平台:fcntl→msvcrt 回退(Windows);SIGALRM 仅 POSIX 存在时启用,
     Windows 依赖 socket timeout + remaining() 预算检查。
  3. --state-dir/--sources 重定位:包目录保持只读,状态集中一个目录,
     首次运行自动从 sources.default.json 播种用户源配置。
  4. LLM 直连改为 env 驱动(RSS_LLM_ENDPOINT/KEY/MODEL),供无 dsh 场景
     (系统 cron)使用;dsh 插件默认走 harness,不碰这些 env。
  5. rss-confirm.py 并入 --stage confirm。

阶段协议(stdout 单行 JSON):
  --stage fetch     {"status": "READY|PENDING_SEND|SKIPPED_TODAY|EMPTY|LOCKED",
                     "date", "prompt"?, "digest"?, "stats"?}
  --stage finalize  输入 --llm-reply FILE|-(LLM 原始回复)或 --rule;
                     {"status": "OK|EMPTY", "digest"}
  --stage confirm   {"status": "CONFIRMED|ALREADY_CONFIRMED|NO_OUTBOX"}
  --stage status    {"today", "last_sent_date", "outbox": {...}}
  (无 --stage: 兼容模式,单进程跑完直接打印日报文本,LLM 走 env endpoint)

依赖: python3.9+, pip install feedparser
"""
import argparse
import hashlib
import json
import os
import re
import signal
import ssl
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None
    import msvcrt

import feedparser

# ── 路径与常量 ──
BASE = os.path.dirname(os.path.abspath(__file__))

SOURCES_PER_DAY = 10
DIGEST_ITEMS = 8             # 宁缺毋滥
MAX_PER_SOURCE = 2
CANDIDATE_POOL = 20          # 送 LLM 编辑的候选数
FETCH_WORKERS = 4
ENRICH_WORKERS = 4
FETCH_TIMEOUT_MIN = 8
FETCH_TIMEOUT_MAX = 15
FETCH_TIMEOUT_DEFAULT = 10
PAGE_TIMEOUT = 8
PAGE_MAX_BYTES = 100_000
TOTAL_BUDGET_S = 420          # 总硬超时(质量优先)
LLM_TIMEOUT_S = 120
DEADLINE = None               # main 里设为 time.monotonic() + TOTAL_BUDGET_S


def remaining():
    return DEADLINE - time.monotonic() if DEADLINE else TOTAL_BUDGET_S

RSS_MAX_BYTES = 300_000
PUSHED_KEEP_DAYS = 14
PUSHED_KEEP_ITEMS = 200
ONE_LINER_MAX = 50
DEDUP_JACCARD = 0.65
MIN_TEXT_LEN = 150           # 低于此长度抓原文页补全

BEIJING = timezone(timedelta(hours=8))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

TIER_SCORE = {1: 10, 2: 7, 3: 4}
SIGNAL_WORDS = {
    3: ["发布", "推出", "开源", "上线", "GA", "正式版", "降价", "免费", "融资", "收购", "突破", "首发", "证实", "发现", "首次", "宣布", "警告", "创", "纪录"],
    2: ["模型", "AI", "智能", "大模型", "Agent", "芯片", "算法", "机器人", "自动驾驶", "benchmark", "开源", "GPT", "Gemini", "Claude", "DeepSeek", "Qwen", "GLM", "研究", "试验", "观测", "论文", "报告", "上调", "下调", "上涨", "下跌", "判决", "通过", "当选", "协议", "计划"],
    1: ["日报", "周报", "周刊", "盘点", "汇总", "一览"],
}
# 排除信号:周刊合集/征文/PR通稿/纯开发者细节
EXCLUDE_PATTERNS = re.compile(
    r"周刊|周报|合集|盘点|汇总|一览|征文|招聘|报名|招募|训练营|上新|促销|优惠|gadget\s*chain|POC|exploit\s*writeup|CVE-\d",
    re.I)


def die(msg):
    print(json.dumps({"error": msg}, ensure_ascii=False))
    sys.exit(1)


def load_json(path, default=None):
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError, OSError):
            pass
    return {} if default is None else default


def save_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def today_str():
    return datetime.now(BEIJING).strftime("%Y-%m-%d")


def acquire_lock(lock_file):
    f = open(lock_file, "w")
    try:
        if fcntl is not None:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
    except (BlockingIOError, OSError):
        print(json.dumps({"status": "LOCKED"}), file=sys.stdout)
        sys.exit(0)
    f.write(str(os.getpid()))
    f.flush()
    return f


# ── 文本处理 ──

def strip_html(text):
    return re.sub(r"<[^>]+>", "", text or "").strip()


MOJIBAKE_RE = re.compile(r"[ĺčďľťä˝ďźžćä]")

def fix_mojibake(text):
    """修复 feed 编码声明错误(cp1250/cp1252/latin 包装 utf8,极客公园等)。
    严格 roundtrip:能完整还原成含中文的合法 utf8 才算修复成功。"""
    if not text or not MOJIBAKE_RE.search(text):
        return text
    for enc in ("cp1252", "cp1250", "latin2", "latin1"):
        try:
            fixed = text.encode(enc, errors="strict").decode("utf-8", errors="strict")
            if re.search(r"[一-鿿]", fixed):
                return fixed
        except Exception:
            continue
    return text


def tokenize(text):
    text = re.sub(r"[^一-鿿\w]", " ", (text or "").lower())
    tokens = set(t for t in text.split() if len(t) > 1)
    cn = re.findall(r"[一-鿿]", text)
    for i in range(len(cn) - 1):
        tokens.add(cn[i] + cn[i + 1])
    return tokens


def jaccard(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def title_hash(title):
    return hashlib.md5(re.sub(r"\s+", "", (title or "").lower()).encode()).hexdigest()[:16]


# ── 源健康 ──

def load_health(health_file):
    health = load_json(health_file, {})
    cutoff = time.time() - 14 * 86400
    for k in [k for k, v in health.items() if v.get("last_seen", 0) < cutoff]:
        del health[k]
    return health


def is_available(health, name):
    h = health.get(name, {})
    if not h.get("is_degraded"):
        return True
    return time.time() >= h.get("degraded_until", 0)


def adaptive_timeout(health, name):
    samples = health.get(name, {}).get("response_samples", [])
    if not samples:
        return FETCH_TIMEOUT_DEFAULT
    s = sorted(samples)
    p95 = s[min(int(len(s) * 0.95), len(s) - 1)]
    return round(max(FETCH_TIMEOUT_MIN, min(FETCH_TIMEOUT_MAX, p95 * 1.5 / 1000)), 1)


def record(health, name, ok, ms):
    h = health.setdefault(name, {"consecutive_fails": 0, "consecutive_successes": 0,
                                 "total_fails": 0, "total_successes": 0,
                                 "response_samples": [], "last_seen": 0,
                                 "degraded_until": 0, "is_degraded": False})
    h["last_seen"] = time.time()
    if ok:
        h["consecutive_fails"] = 0
        h["consecutive_successes"] += 1
        h["total_successes"] += 1
        if ms > 0:
            h["response_samples"] = (h["response_samples"] + [ms])[-10:]
        if h.get("is_degraded") and h["consecutive_successes"] >= 2:
            h["is_degraded"] = False
            h["degraded_until"] = 0
    else:
        h["consecutive_successes"] = 0
        h["consecutive_fails"] += 1
        h["total_fails"] += 1
        if h["consecutive_fails"] >= 3 and not h.get("is_degraded"):
            h["is_degraded"] = True
            h["degraded_until"] = time.time() + 24 * 3600


# ── 选源 ──

def pick_sources(all_sources, health, state_file, per_day):
    by_cat = {}
    for s in all_sources:
        if s.get("method") == "reader" or s.get("disabled"):
            continue
        by_cat.setdefault(s["category"], []).append(s)

    def sort_key(src):
        h = health.get(src["name"], {})
        total = h.get("total_successes", 0) + h.get("total_fails", 0)
        rate = h.get("total_successes", 0) / total if total else 1.0
        samples = h.get("response_samples", [])
        avg = sum(samples) / len(samples) if samples else 5000
        speed = max(0.0, 1 - avg / (FETCH_TIMEOUT_MAX * 1000))
        return (0 if is_available(health, src["name"]) else 1,
                -(rate * 0.6 + speed * 0.4), src.get("tier", 3))

    pool = []
    max_len = max(len(v) for v in by_cat.values())
    for i in range(max_len):
        for cat in sorted(by_cat):
            if i < len(by_cat[cat]):
                pool.append(by_cat[cat][i])

    state = load_json(state_file, {})
    if state.get("pool_date") != today_str():
        state["pool_idx"] = 0
    idx = state.get("pool_idx", 0)

    selected, tries = [], 0
    while len(selected) < per_day and tries < len(pool) * 2:
        src = pool[(idx + tries) % len(pool)]
        if is_available(health, src["name"]) and src not in selected:
            selected.append(src)
        tries += 1
    state["pool_idx"] = (idx + tries) % len(pool)
    state["pool_date"] = today_str()
    save_json(state_file, state)
    return selected


# ── 抓取(feed 全文优先) ──

def fetch_one(src, timeout):
    req = urllib.request.Request(src["url"], headers={"User-Agent": UA})
    t0 = time.monotonic()
    resp = urllib.request.urlopen(req, timeout=timeout, context=CTX)
    try:
        raw = resp.read(RSS_MAX_BYTES)
    finally:
        resp.close()
    ms = (time.monotonic() - t0) * 1000
    parsed = feedparser.parse(raw)
    # 编码修复:feed 声明错 charset → feedparser 用错码页解码 → 标题乱码。
    # 检测到乱码标记就用 UTF-8 强制重解(治本),字符级修复只做兜底。
    if any(MOJIBAKE_RE.search((e.get("title") or "")) for e in parsed.entries[:5]):
        try:
            reparsed = feedparser.parse(raw.decode("utf-8", errors="replace"))
            if reparsed.entries and not any(
                    MOJIBAKE_RE.search((e.get("title") or "")) for e in reparsed.entries[:5]):
                parsed = reparsed
        except Exception:
            pass
    items = []
    for e in parsed.entries[:8]:
        title = fix_mojibake(strip_html(e.get("title") or ""))
        link = (e.get("link") or "").strip()
        # 全文优先:content:encoded > 长summary
        content = ""
        for c in (e.get("content") or []):
            content += strip_html(c.get("value") or "")
        content = fix_mojibake(content)
        summary = fix_mojibake(strip_html(e.get("summary") or e.get("description") or ""))
        text = content if len(content) > len(summary) else summary
        pub = None
        st = e.get("published_parsed") or e.get("updated_parsed")
        if st:
            pub = time.mktime(st)
        if title and link:
            items.append({"title": title, "link": link, "text": text[:2500],
                          "published": pub})
    return items, ms


def fetch_all(selected, health):
    results = {}
    ex = ThreadPoolExecutor(max_workers=FETCH_WORKERS)
    futs = {ex.submit(fetch_one, src, adaptive_timeout(health, src["name"])): src
            for src in selected}
    deadline = time.monotonic() + 35
    try:
        for fut in as_completed(futs, timeout=max(5, deadline - time.monotonic())):
            src = futs[fut]
            try:
                items, ms = fut.result(timeout=1)
                record(health, src["name"], True, ms)
                results[src["name"]] = {"src": src, "items": items}
            except Exception as e:
                record(health, src["name"], False, 0)
                results[src["name"]] = {"src": src, "error": str(e)[:80]}
    except TimeoutError:
        for fut, src in futs.items():
            if not fut.done():
                fut.cancel()
                record(health, src["name"], False, 0)
                results[src["name"]] = {"src": src, "error": "fetch deadline"}
    finally:
        ex.shutdown(wait=False, cancel_futures=True)
    return results


# ── newsflash 事件图谱:多源交叉验证热点作为额外候选 ──

NEWSFLASH_CATS = {"tech": "科技", "science": "科学", "world": "国际", "business": "财经"}
NEWSFLASH_MIN_CORROB = 3
NEWSFLASH_PER_CAT = 3
NEWSFLASH_MAX_AGE_H = 26

def fetch_newsflash():
    """newsflash.sh 多源验证事件(>=3家独立媒体,近26h),失败静默降级为纯RSS"""
    out = []
    try:
        cutoff = time.time() - NEWSFLASH_MAX_AGE_H * 3600
        for cat, cat_cn in NEWSFLASH_CATS.items():
            req = urllib.request.Request(
                f"https://newsflash.sh/api/events?category={cat}&limit=40",
                headers={"User-Agent": UA})
            resp = urllib.request.urlopen(req, timeout=10, context=CTX)
            data = json.loads(resp.read().decode("utf-8"))
            resp.close()
            evs = []
            for e in data.get("events", []):
                fs = e.get("first_seen_at") or ""
                cor = e.get("corroboration") or 0
                if cor < NEWSFLASH_MIN_CORROB or not fs:
                    continue
                try:
                    ts = datetime.fromisoformat(fs.replace("Z", "+00:00")).timestamp()
                except Exception:
                    continue
                if ts >= cutoff:
                    evs.append((cor, ts, e))
            evs.sort(key=lambda x: x[0], reverse=True)
            for cor, ts, e in evs[:NEWSFLASH_PER_CAT]:
                title = strip_html(e.get("canonical_title") or "").strip()
                if not title:
                    continue
                out.append({
                    "title": title, "link": f"https://newsflash.sh/e/{e['id']}",
                    "text": (e.get("summary") or title)[:400], "published": ts,
                    "source": f"newsflash·{cat_cn}", "tier": 2, "category": cat_cn,
                    "corroboration": cor, "nf": True,
                    "nf_sources": ", ".join((e.get("sources") or [])[:4]),
                })
    except Exception as e:
        print(f"[newsflash] 降级为纯RSS: {type(e).__name__}: {str(e)[:120]}", file=sys.stderr)
    return out


# ── 正文增强:短摘要条目抓原文页(仅入围候选) ──

def fetch_page_text(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    resp = urllib.request.urlopen(req, timeout=PAGE_TIMEOUT, context=CTX)
    try:
        html = resp.read(PAGE_MAX_BYTES).decode("utf-8", errors="replace")
    finally:
        resp.close()
    am = re.search(r"<article[^>]*>(.*?)</article>", html, flags=re.S | re.I)
    if am:
        text = strip_html(am.group(1))
        if len(text) > 150:
            return text[:2000]
    ps = re.findall(r"<p[^>]*>(.*?)</p>", html, flags=re.S | re.I)[:25]
    text = "\n".join(strip_html(p) for p in ps if len(strip_html(p)) > 20)
    return text[:2000] if len(text) > 150 else None


def enrich(cands):
    need = [c for c in cands if not c.get("nf") and len(c.get("text") or "") < MIN_TEXT_LEN]
    if not need:
        return
    ex = ThreadPoolExecutor(max_workers=ENRICH_WORKERS)

    def _one(c):
        try:
            t = fetch_page_text(c["link"])
        except Exception:
            t = None
        return c, t

    # 给 LLM 编辑至少留 150s
    budget = max(5, min(30, remaining() - 150))
    try:
        for fut in as_completed([ex.submit(_one, c) for c in need], timeout=budget):
            try:
                c, t = fut.result(timeout=1)
                if t:
                    c["text"] = t
                    c["enriched"] = True
            except Exception:
                pass
    except TimeoutError:
        pass
    finally:
        ex.shutdown(wait=False, cancel_futures=True)


# ── 打分(仅用于候选池排序,选题交给 LLM 编辑) ──

def score_item(item, tier):
    ts = TIER_SCORE.get(tier, 4)
    now = time.time()
    if item.get("published"):
        hours = max(0, (now - item["published"]) / 3600)
        rec = 10 if hours < 6 else 8 if hours < 24 else 5 if hours < 48 else 2
    else:
        rec = 5
    title = item["title"].lower()
    sig = 0
    for weight, words in SIGNAL_WORDS.items():
        if any(w.lower() in title for w in words):
            sig += weight
    sig = min(10, sig)
    return round(ts * 0.5 + rec * 0.35 + sig * 0.15, 2)


# ── LLM 编辑(prompt 构建/解析在此,harness 与 endpoint 两种传输共用) ──

EDITOR_PROMPT = """你是「每日要闻」的主编,面向一位高素养读者的每日新闻精选。下面是今天的候选新闻(编号|来源|类目|标题|正文摘录)。

任务:
1. **合并同一事件**:多条报道同一件事时只留一条,选信息最完整的
2. **剔除低价值**:周刊/周报/合集/盘点/征文/招聘/训练营/PR通稿/纯开发者向细节(某漏洞利用链等)/纯学术摘要堆砌
3. **选题平衡**:科技、科学、国际时政、财经、人文、健康、环境、开发均可入选;按信息价值与影响力选,不偏向任何单一话题;同一类目最多选2条;若某类目候选都很弱就跳过
4. 选 {n} 条,宁缺毋滥,凑不够就少选
5. **每条写一句话(≤45字)**:必须基于所给正文,包含具体事实(数字/版本/价格/能力变化/结论),禁止空话和脑补;英文新闻用中文表述,关键专名保留英文
6. **每条给类目标签 tag**:按文章内容本身归类(不是按来源栏目),只能从这些词里选一个:AI/科技/科学/国际/财经/人文/开发/健康/环境/社会/商业/产品/研究

7. **newsflash条目**:来源以newsflash·开头的来自多源交叉验证事件图谱,标题多为外文,一句话末尾标注「✚N家」(N=佐证数);与RSS条目报道同一事件时保留更可信的一条

候选:
{cands}

只输出JSON: {{"items":[{{"n":编号, "tag":"类目", "line":"一句话"}}, ...], "merged":被合并丢弃的编号列表, "dropped":剔除的编号列表}}"""

TAG_VOCAB = {"AI", "科技", "科学", "国际", "财经", "人文", "开发",
             "健康", "环境", "社会", "商业", "产品", "研究"}


def build_prompt(pool, digest_items):
    lines = []
    for i, c in enumerate(pool, 1):
        text = (c.get("text") or c.get("title", ""))[:400].replace("\n", " ")
        nf = f"(✚{c['corroboration']}家)" if c.get("corroboration") else ""
        lines.append(f"[{i}] {c['source']} | {c.get('category', '')} | {c['title'][:70]}{nf} | {text}")
    return EDITOR_PROMPT.format(n=digest_items, cands="\n".join(lines))


def parse_reply(text, pool):
    """解析 LLM 回复 → picked 列表;垃圾输出返回 None"""
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except Exception:
        return None
    out, used_n = [], set()
    for it in data.get("items", []):
        try:
            n = int(it["n"])
            line = str(it["line"]).strip()
            tag = str(it.get("tag") or "").strip()
            if 1 <= n <= len(pool) and len(line) >= 8 and n not in used_n:
                used_n.add(n)
                if tag not in TAG_VOCAB:
                    tag = pool[n - 1].get("category", "新闻")
                out.append({"cand": pool[n - 1], "line": cut_line(line), "tag": tag})
        except Exception:
            continue
    return out or None


def llm_call_endpoint(prompt):
    """OpenAI 兼容直连(env 配置),供系统 cron 等无 dsh 场景"""
    endpoint = os.environ.get("RSS_LLM_ENDPOINT", "")
    key = os.environ.get("RSS_LLM_KEY", "")
    model = os.environ.get("RSS_LLM_MODEL", "")
    if not (endpoint and key and model):
        return None

    def _post(payload):
        req = urllib.request.Request(
            endpoint.rstrip("/") + "/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
            method="POST")
        resp = urllib.request.urlopen(req, timeout=min(LLM_TIMEOUT_S, max(5, remaining() - 10)),
                                      context=CTX)
        try:
            return json.loads(resp.read().decode("utf-8"))["choices"][0]["message"]["content"].strip()
        finally:
            resp.close()

    try:
        text = _post({"model": model, "messages": [{"role": "user", "content": prompt}],
                      "temperature": 0.2, "max_tokens": 900})
        return parse_reply(text, pool_ref[0])
    except Exception as e:
        print(f"[llm_call_endpoint] failed: {type(e).__name__}: {str(e)[:200]}", file=sys.stderr)
        return None


pool_ref = [None]  # llm_call_endpoint 需要 pool 解析;由调用方设置


def rule_edit(cands):
    """降级:cands 已按分排序;剔排除词+同事件去重+同类目≤2条"""
    out, picked_tokens, per_cat = [], [], {}
    for c in cands:
        title = c["title"]
        if EXCLUDE_PATTERNS.search(title):
            continue
        tk = tokenize(title)
        if any(jaccard(tk, old) >= 0.4 for old in picked_tokens):
            continue
        cat = c.get("category", "")
        if per_cat.get(cat, 0) >= 2:
            continue
        picked_tokens.append(tk)
        per_cat[cat] = per_cat.get(cat, 0) + 1
        t = re.sub(r"[|｜#*]+$", "", title).strip()
        out.append({"cand": c, "line": cut_line(t)})
        if len(out) >= DIGEST_ITEMS:
            break
    return out


# ── 格式 ──

DIGEST_TITLE = "每日要闻"
FOOTER = ""  # 可用 --footer 自定义,如 openclaw 版的「回复深搜 N」联动

def item_tag(p):
    return p.get("tag") or p["cand"].get("category") or "新闻"


def cap_per_tag(picked, cap=2):
    """同一类目标签最多保留 cap 条(LLM 对软约束遵守不严,代码层兜底)"""
    out, per = [], {}
    for p in picked:
        t = item_tag(p)
        if per.get(t, 0) >= cap:
            continue
        per[t] = per.get(t, 0) + 1
        out.append(p)
    return out


def cut_line(s, n=ONE_LINER_MAX):
    """超长一句话在最后一个标点收尾,避免硬截断产生悬句"""
    if len(s) <= n:
        return s
    for i in range(n, 10, -1):
        if s[i - 1] in "。！？；，、":
            return s[:i].rstrip("，、；")
    return s[:n]


def format_digest(date_cn, lines, footer=""):
    body = "\n\n".join(f"{i+1}. {l}" for i, l in enumerate(lines))
    text = f"{DIGEST_TITLE} {date_cn}\n\n{body}"
    if footer:
        text += f"\n\n{footer}"
    return text


def picked_to_items(picked):
    return [{"n": i + 1, "title": p["cand"]["title"], "link": p["cand"]["link"],
             "source": p["cand"]["source"], "category": p["cand"]["category"],
             "tag": item_tag(p),
             "one_liner": p["line"], "score": p["cand"].get("score", 0)}
            for i, p in enumerate(picked)]


# ── 阶段实现 ──

class Paths:
    def __init__(self, args):
        self.state_dir = args.state_dir or BASE
        os.makedirs(self.state_dir, exist_ok=True)
        self.sources = args.sources or os.path.join(self.state_dir, "sources.json")
        self.state = os.path.join(self.state_dir, "rss-state.json")
        self.pushed = os.path.join(self.state_dir, "rss-pushed.json")
        self.health = os.path.join(self.state_dir, "rss-health.json")
        self.outbox = os.path.join(self.state_dir, "rss-outbox.json")
        self.sent = os.path.join(self.state_dir, "rss-sent.json")
        self.lock = os.path.join(self.state_dir, ".rss.lock")
        # 首次运行:从包内默认源播种
        if not os.path.exists(self.sources):
            default = os.path.join(BASE, "sources.default.json")
            if os.path.exists(default):
                import shutil
                shutil.copyfile(default, self.sources)
                print(f"[seed] sources -> {self.sources}", file=sys.stderr)


def emit(obj):
    """阶段模式:stdout 只输出单行 JSON,诊断走 stderr"""
    print(json.dumps(obj, ensure_ascii=False))


def stage_fetch(p, args):
    sent = load_json(p.sent, {})
    if not args.force and sent.get("last_sent_date") == today_str():
        emit({"status": "SKIPPED_TODAY", "date": today_str()})
        return

    outbox = load_json(p.outbox, {})
    if outbox.get("date") == today_str() and not outbox.get("confirmed") \
            and outbox.get("digest_text"):
        emit({"status": "PENDING_SEND", "date": today_str(), "digest": outbox["digest_text"],
              "items": outbox.get("items", [])})
        return

    cfg = load_json(p.sources)
    all_sources = cfg.get("sources", [])
    if not all_sources:
        die("没有配置RSS源")

    health = load_health(p.health)
    selected = pick_sources(all_sources, health, p.state, args.per_day)
    fetched = fetch_all(selected, health)
    save_json(p.health, health)

    pushed = load_json(p.pushed, {"hashes": [], "titles": []})
    if args.force:
        # redo:今日确认过的条目从去重表中剔除(保留历史),重新参与候选
        dated = [x for x in pushed.get("dated", []) if x.get("d") != today_str()]
        pushed = {"hashes": [x["h"] for x in dated], "titles": [x["t"] for x in dated], "dated": dated}
    seen_hashes = set(pushed.get("hashes", []))
    seen_tokens = [tokenize(t) for t in pushed.get("titles", [])[-PUSHED_KEEP_ITEMS:]]

    candidates, dup_in_day = [], 0
    day_tokens = []
    for name, r in fetched.items():
        if "error" in r:
            continue
        src = r["src"]
        for it in r["items"]:
            h = title_hash(it["title"])
            tk = tokenize(it["title"])
            if h in seen_hashes:
                continue
            if any(jaccard(tk, old) >= DEDUP_JACCARD for old in seen_tokens):
                continue
            if any(jaccard(tk, old) >= DEDUP_JACCARD for old in day_tokens):
                dup_in_day += 1
                continue
            it["source"] = src["name"]
            it["tier"] = src.get("tier", 3)
            it["category"] = src["category"]
            it["score"] = score_item(it, it["tier"])
            candidates.append(it)
            day_tokens.append(tk)

    # newsflash 多源验证热点注入(独立预算,失败降级)
    nf_added = 0
    for it in fetch_newsflash():
        h = title_hash(it["title"])
        tk = tokenize(it["title"])
        if h in seen_hashes:
            continue
        if any(jaccard(tk, old) >= DEDUP_JACCARD for old in seen_tokens):
            continue
        if any(jaccard(tk, old) >= DEDUP_JACCARD for old in day_tokens):
            continue
        it["score"] = score_item(it, it["tier"]) + it.get("corroboration", 0) * 0.25
        candidates.append(it)
        day_tokens.append(tk)
        nf_added += 1

    stats = {
        "sources_ok": sum(1 for r in fetched.values() if "error" not in r),
        "sources_fail": sum(1 for r in fetched.values() if "error" in r),
        "failed_sources": [n for n, r in fetched.items() if "error" in r],
        "candidates": len(candidates),
        "dup_folded_in_day": dup_in_day,
        "newsflash_added": nf_added,
    }

    if not candidates:
        save_json(p.outbox, {"date": today_str(), "confirmed": False,
                             "digest_text": "", "items": [], "empty": True})
        emit({"status": "EMPTY", "date": today_str(), "stats": stats})
        return

    candidates.sort(key=lambda x: x["score"], reverse=True)

    # 单源最多2条进入候选池(多样性),预排除明显垃圾
    pool, per_src = [], {}
    for it in candidates:
        if EXCLUDE_PATTERNS.search(it["title"]):
            continue
        c = per_src.get(it["source"], 0)
        if c >= MAX_PER_SOURCE:
            continue
        pool.append(it)
        per_src[it["source"]] = c + 1
        if len(pool) >= CANDIDATE_POOL:
            break
    stats["pool"] = len(pool)

    # 正文增强(短摘要抓原文页)
    enrich(pool)
    stats["enriched"] = sum(1 for c in pool if c.get("enriched"))

    # 规则版先行(fallback + rule 模式产物)
    rule_picked = cap_per_tag(rule_edit(pool)) if pool else []
    rule_digest, rule_items = None, []
    if rule_picked:
        date_cn = datetime.now(BEIJING).strftime("%Y年%m月%d日")
        rule_digest = format_digest(date_cn,
                                    [f"【{item_tag(x)}】{x['line']}" for x in rule_picked],
                                    args.footer)
        rule_items = picked_to_items(rule_picked)

    # 池瘦身:finalize 阶段只需要映射字段
    pool_lite = [{"title": c["title"], "link": c["link"], "source": c["source"],
                  "category": c.get("category", ""), "tier": c.get("tier", 3),
                  "score": c.get("score", 0), "corroboration": c.get("corroboration", 0)}
                 for c in pool]

    save_json(p.outbox, {
        "date": today_str(),
        "generated_at": datetime.now(BEIJING).isoformat(),
        "confirmed": False,
        "prompt": build_prompt(pool, args.digest_items) if pool else "",
        "pool": pool_lite,
        "rule_digest": rule_digest or "",
        "rule_items": rule_items,
        "digest_text": "",
        "items": [],
        "stats": stats,
    })
    emit({"status": "READY", "date": today_str(), "need_llm": bool(pool), "stats": stats})


def stage_finalize(p, args):
    outbox = load_json(p.outbox, {})
    if not outbox or outbox.get("date") != today_str():
        emit({"status": "NO_OUTBOX", "date": today_str()})
        return

    # 已有当日未确认文本且未显式要求重做 → 直接复用
    if outbox.get("digest_text") and not args.redo:
        emit({"status": "OK", "digest": outbox["digest_text"]})
        return

    used_llm, picked = False, None
    if not args.rule and outbox.get("prompt") and outbox.get("pool"):
        reply_text = ""
        if args.llm_reply:
            if args.llm_reply == "-":
                reply_text = sys.stdin.read()
            else:
                reply_text = open(args.llm_reply, encoding="utf-8").read()
        if reply_text:
            picked = parse_reply(reply_text, outbox["pool"])
            if picked:
                used_llm = True
            else:
                print("[finalize] LLM 回复解析失败,降级规则模式", file=sys.stderr)
        else:
            print("[finalize] 未提供 LLM 回复,使用规则模式", file=sys.stderr)

    if not picked:
        # 规则产物已在 fetch 阶段生成
        outbox["digest_text"] = outbox.get("rule_digest", "")
        outbox["items"] = outbox.get("rule_items", [])
        outbox["used_llm"] = False
        if not outbox["digest_text"]:
            emit({"status": "EMPTY", "date": today_str()})
            return
    else:
        picked = cap_per_tag(picked)
        date_cn = datetime.now(BEIJING).strftime("%Y年%m月%d日")
        outbox["digest_text"] = format_digest(
            date_cn, [f"【{item_tag(x)}】{x['line']}" for x in picked], args.footer)
        outbox["items"] = picked_to_items(picked)
        outbox["used_llm"] = used_llm
    save_json(p.outbox, outbox)
    emit({"status": "OK", "digest": outbox["digest_text"],
          "used_llm": outbox["used_llm"], "items": len(outbox["items"])})


def stage_confirm(p, args):
    outbox = load_json(p.outbox, {})
    if not outbox or not outbox.get("items"):
        emit({"status": "NO_OUTBOX"})
        return
    if args.date and outbox.get("date") != args.date:
        emit({"status": "DATE_MISMATCH", "outbox": outbox.get("date"), "want": args.date})
        sys.exit(1)
    if outbox.get("confirmed"):
        emit({"status": "ALREADY_CONFIRMED", "date": outbox.get("date")})
        return

    # 并入 pushed(带日期,按天裁剪)
    pushed = load_json(p.pushed, {"hashes": [], "titles": [], "dated": []})
    dated = pushed.get("dated", [])
    for it in outbox["items"]:
        dated.append({"d": outbox["date"], "h": title_hash(it["title"]), "t": it["title"]})
    cutoff = (datetime.now(BEIJING) - timedelta(days=PUSHED_KEEP_DAYS)).strftime("%Y-%m-%d")
    dated = [x for x in dated if x["d"] >= cutoff][-PUSHED_KEEP_ITEMS:]
    save_json(p.pushed, {"hashes": [x["h"] for x in dated], "titles": [x["t"] for x in dated],
                         "dated": dated})

    outbox["confirmed"] = True
    outbox["confirmed_at"] = datetime.now(BEIJING).isoformat()
    save_json(p.outbox, outbox)
    save_json(p.sent, {"last_sent_date": outbox["date"],
                       "confirmed_at": datetime.now(BEIJING).isoformat(),
                       "items_count": len(outbox["items"])})
    emit({"status": "CONFIRMED", "date": outbox["date"], "items": len(outbox["items"])})


def stage_status(p, _args):
    outbox = load_json(p.outbox, {})
    sent = load_json(p.sent, {})
    emit({"today": today_str(), "last_sent_date": sent.get("last_sent_date"),
          "digest": outbox.get("digest_text") or "",
          "outbox": {"date": outbox.get("date"),
                     "confirmed": outbox.get("confirmed", False),
                     "empty": outbox.get("empty", False),
                     "has_digest": bool(outbox.get("digest_text")),
                     "used_llm": outbox.get("used_llm", False),
                     "items": len(outbox.get("items", []))}})


def run_legacy(p, args):
    """兼容模式:单进程跑完(系统 cron 场景),LLM 走 env endpoint"""
    sent = load_json(p.sent, {})
    if sent.get("last_sent_date") == today_str():
        print("SKIPPED_TODAY")
        return
    stage_fetch(p, args)
    outbox = load_json(p.outbox, {})
    if not outbox.get("pool"):
        return  # EMPTY/SKIPPED 已在 fetch 输出
    if outbox.get("prompt"):
        pool_ref[0] = outbox["pool"]
        picked = llm_call_endpoint(outbox["prompt"])
        if picked:
            picked = cap_per_tag(picked)
            date_cn = datetime.now(BEIJING).strftime("%Y年%m月%d日")
            outbox["digest_text"] = format_digest(
                date_cn, [f"【{item_tag(x)}】{x['line']}" for x in picked], args.footer)
            outbox["items"] = picked_to_items(picked)
            outbox["used_llm"] = True
            save_json(p.outbox, outbox)
    # finalize 不带 redo:LLM 成功则直接复用文本,失败/未配置则落规则版
    stage_finalize(p, args)
    outbox = load_json(p.outbox, {})
    print("---DIGEST-BEGIN---")
    print(outbox.get("digest_text", ""))
    print("---DIGEST-END---")
    print("送达后执行确认: python daily.py --stage confirm --state-dir <dir>")


def main():
    ap = argparse.ArgumentParser(description="dsh-rss-daily pipeline")
    ap.add_argument("--stage", choices=["fetch", "finalize", "confirm", "status"])
    ap.add_argument("--state-dir", default="", help="状态目录(源/去重/outbox 等)")
    ap.add_argument("--sources", default="", help="RSS 源配置 JSON 路径")
    ap.add_argument("--llm-reply", default="", help="finalize: LLM 回复文件路径('-'=stdin)")
    ap.add_argument("--rule", action="store_true", help="finalize: 强制规则模式")
    ap.add_argument("--redo", action="store_true", help="finalize: 忽略已有文本重新生成")
    ap.add_argument("--date", default="", help="confirm: 指定确认日期 YYYY-MM-DD")
    ap.add_argument("--footer", default=FOOTER, help="日报尾注(可空)")
    ap.add_argument("--digest-items", type=int, default=DIGEST_ITEMS)
    ap.add_argument("--per-day", type=int, default=SOURCES_PER_DAY,
                    help="每日抓取源数(测试用)")
    ap.add_argument("--force", action="store_true",
                    help="fetch:无视当日已送幂等门,重选重投(redo)")
    args = ap.parse_args()

    p = Paths(args)
    lock = acquire_lock(p.lock)

    global DEADLINE
    DEADLINE = time.monotonic() + TOTAL_BUDGET_S

    if hasattr(signal, "SIGALRM"):
        def on_alarm(signum, frame):
            print("TIMEOUT_BUDGET: total budget exceeded, partial abort", file=sys.stderr)
            sys.exit(1)
        signal.signal(signal.SIGALRM, on_alarm)
        signal.alarm(TOTAL_BUDGET_S)

    try:
        if args.stage == "fetch":
            stage_fetch(p, args)
        elif args.stage == "finalize":
            stage_finalize(p, args)
        elif args.stage == "confirm":
            stage_confirm(p, args)
        elif args.stage == "status":
            stage_status(p, args)
        else:
            run_legacy(p, args)
    finally:
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)
        try:
            lock.close()
            os.remove(p.lock)
        except Exception:
            pass


if __name__ == "__main__":
    main()
