#!/usr/bin/env python3
"""
rss-daily MCP server (2026-08-31)

把 py/daily.py 分阶段管线暴露为 MCP 工具,供 Claude Code / Codex / opencode
等任何 MCP 客户端调用。架构同 dsh 插件:领域逻辑全在 daily.py,
本文件只做传输,不复制任何编辑规则/词表。

工具流(宿主 agent 就是编辑 LLM,也是投递渠道):
  rss_fetch    抓源出编辑提示词(分钟级长任务,内联等待超时后转后台,轮询 rss_status)
  rss_finalize 把编辑回复落稿为日报文本
  rss_confirm  用户看过后确认当日已送达(写幂等门)
  rss_status   纯读文件查状态+运行检测,不碰 daily.py 的锁

状态目录默认 ~/.dsh/rss-daily(与 dsh 插件共享:幂等门互认、.rss.lock 互斥),
RSS_DAILY_STATE_DIR 可重定位(隔离测试用)。时区与插件配置对齐:插件配了非
UTC+8 时区的话,给本 server 也设 RSS_DAILY_TZ=<同值>,否则两边的"今天"
不是同一天、幂等门互不认账(audit M16)。依赖: pip install mcp feedparser
(mcp 1.x 与 2.x 均可,import 层已自动适配)
"""
import ctypes
import ctypes.wintypes
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta

try:
    import msvcrt
except ImportError:  # POSIX
    msvcrt = None
    import fcntl

# mcp 1.x 的 FastMCP 在 2.x 改名为 MCPServer;不带版本约束的
# `pip install mcp` 现在拿到 2.x,直接 import 会让 server 起不来(audit B1)
try:
    from mcp.server.fastmcp import FastMCP
except ModuleNotFoundError:
    from mcp.server.mcpserver import MCPServer as FastMCP

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DAILY = os.path.join(BASE, "py", "daily.py")
STATE_DIR = os.environ.get("RSS_DAILY_STATE_DIR") or os.path.join(
    os.path.expanduser("~"), ".dsh", "rss-daily")
OUTBOX = os.path.join(STATE_DIR, "rss-outbox.json")
SENT = os.path.join(STATE_DIR, "rss-sent.json")
LOCK = os.path.join(STATE_DIR, ".rss.lock")
BEIJING = timezone(timedelta(hours=8))


def _active_tz():
    """与 dsh 插件的 --tz 同一个"今天":RSS_DAILY_TZ 配置后两边幂等门互认(audit M16)"""
    spec = (os.environ.get("RSS_DAILY_TZ") or "").strip()
    m = re.fullmatch(r"UTC([+-])(\d{1,2})(?::(\d{2}))?", spec.upper()) if spec else None
    if not m:
        return BEIJING
    sign = -1 if m.group(1) == "-" else 1
    return timezone(sign * timedelta(hours=int(m.group(2)), minutes=int(m.group(3) or 0)))


ACTIVE_TZ = _active_tz()


def _tz_args():
    tz = (os.environ.get("RSS_DAILY_TZ") or "").strip() or "UTC+8"
    return [] if tz.upper() == "UTC+8" else ["--tz", tz]

FETCH_WAIT_S = 20   # rss_fetch 内联等待窗口(客户端默认工具超时 30s 内留余量)
STAGE_TIMEOUT_S = 30

_proc = None        # 本进程发起的 fetch 句柄(超时后跨工具调用追踪)

try:
    mcp = FastMCP("rss-daily", instructions=(
        "RSS 每日新闻日报管线。典型流程:rss_status 查状态 → rss_fetch 抓取(长任务,"
        "RUNNING 时轮询 rss_status,完成后它会带出 prompt)→ 按 prompt 要求亲自完成编辑,"
        "结果传 rss_finalize → 把日报展示给用户 → 用户认可后 rss_confirm 确认送达。"
        "状态目录与 dsh 插件共享,确认后 dsh 今晨不再补发。"))
except TypeError:  # mcp 2.x 构造参数差异:instructions 不被接受就去掉
    mcp = FastMCP("rss-daily")


def _env():
    e = dict(os.environ)
    # Windows 管道默认 GBK,中文会碎(与 dsh 插件同款坑)
    e["PYTHONUTF8"] = "1"
    e["PYTHONIOENCODING"] = "utf-8"
    return e


def _stage(stage, extra=(), stdin_text=None, timeout=STAGE_TIMEOUT_S):
    """跑 daily.py 一个阶段,取 stdout 末行 JSON;诊断 stderr 附带回传。

    stdin 必须显式 DEVNULL:子进程若继承本 server 的 stdin(MCP 管道),
    Windows 上进程退出会被拖住数秒,把秒级阶段变成超时(实测踩坑)。
    """
    cmd = [sys.executable, DAILY, "--stage", stage, "--state-dir", STATE_DIR, *_tz_args(), *extra]
    try:
        if stdin_text is None:
            r = subprocess.run(cmd, capture_output=True, text=True,
                               encoding="utf-8", errors="replace",
                               timeout=timeout, env=_env(),
                               stdin=subprocess.DEVNULL)
        else:
            r = subprocess.run(cmd, input=stdin_text, capture_output=True, text=True,
                               encoding="utf-8", errors="replace",
                               timeout=timeout, env=_env())
    except subprocess.TimeoutExpired:
        return {"status": "TIMEOUT", "hint": f"{stage} 超过 {timeout}s,稍后重试"}
    for line in reversed((r.stdout or "").splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if (r.stderr or "").strip():
                obj.setdefault("stderr", r.stderr.strip()[-1500:])
            return obj
    return {"status": "ERROR", "stdout_tail": (r.stdout or "")[-500:],
            "stderr": (r.stderr or "")[-1500:]}


def _read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {} if default is None else default


def _pid_alive(pid):
    if not pid:
        return False
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    try:
        if os.name == "nt":
            kernel32 = ctypes.windll.kernel32
            # restype 不显式声明时 64 位 HANDLE 会被截成 32 位 c_int(UB)
            kernel32.OpenProcess.restype = ctypes.wintypes.HANDLE
            h = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                return False
            try:
                code = ctypes.c_ulong()
                kernel32.GetExitCodeProcess(h, ctypes.byref(code))
                return code.value == 259  # STILL_ACTIVE
            finally:
                kernel32.CloseHandle(h)
        # POSIX 分支:Windows 的 os.kill(pid,0) 是 TerminateProcess,不可达(nt 分支已 return)
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def _lock_held():
    """试锁探测 .rss.lock 是否被持有:失败=有抓取在跑。
    不依赖锁文件可读——Windows 的 LockFile 会阻止其他句柄读被锁字节区间,
    读 PID 的老路在插件/cron 抓取期间恒 PermissionError(audit H6)。"""
    if not os.path.exists(LOCK):
        return False
    try:
        f = open(LOCK, "a+")
    except OSError:
        return True  # 打不开按"在跑"保守处理
    try:
        if msvcrt is not None:
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(f, fcntl.LOCK_UN)
        return False
    except OSError:
        return True
    finally:
        f.close()


def _running():
    """三路运行检测:本进程 fetch 句柄 → 锁文件 PID → 试锁。
    残留死锁文件(进程已崩)不算运行——daily.py 的 acquire_lock 能自行重新抢锁。"""
    global _proc
    if _proc is not None:
        if _proc.poll() is None:
            return True, "mcp-server(之前发起的 rss_fetch 仍在跑)"
        try:
            _proc.communicate(timeout=1)  # 收尸,输出丢弃(状态已落盘 outbox)
        except Exception:
            pass
        _proc = None
    pid = ""
    try:
        with open(LOCK, encoding="utf-8", errors="replace") as f:
            pid = f.read().strip()
    except OSError:
        pid = ""
    if pid and _pid_alive(pid):
        return True, f"外部进程 pid={pid}(dsh 插件或系统 cron)"
    if _lock_held():
        return True, "外部进程持有抓取锁(dsh 插件或系统 cron)"
    return False, None


def _J(obj):
    return json.dumps(obj, ensure_ascii=False)


@mcp.tool()
def rss_status() -> str:
    """查询今日日报管线状态(只读,随时可调,不受抓取锁影响)。

    返回:today / last_sent_date / outbox_detail(是否已出编辑提示词、已定稿、已确认、
    条数)/ digest_preview / running(是否有抓取在跑,dsh 插件发起的也能看到)。
    若当日候选已抓取但还没编辑,会一并返回 prompt(编辑任务说明+候选清单),
    宿主 agent 按其要求编辑后调 rss_finalize。"""
    today = datetime.now(ACTIVE_TZ).strftime("%Y-%m-%d")
    ob = _read_json(OUTBOX)
    today_ob = ob if ob.get("date") == today else {}
    run, run_by = _running()
    payload = {
        "today": today,
        "last_sent_date": _read_json(SENT).get("last_sent_date"),
        "running": run,
        "outbox_detail": {
            "has_prompt": bool(today_ob.get("prompt")),
            "digest_ready": bool(today_ob.get("digest_text")),
            "confirmed": bool(today_ob.get("confirmed")),
            "used_llm": today_ob.get("used_llm", False),
            "items": len(today_ob.get("items") or []),
        },
    }
    if run:
        payload["running_by"] = run_by
    digest = today_ob.get("digest_text") or today_ob.get("rule_digest") or ""
    if digest:
        payload["digest_preview"] = digest[:600] + ("…" if len(digest) > 600 else "")
    if today_ob.get("prompt") and not today_ob.get("digest_text") \
            and not today_ob.get("confirmed"):
        payload["prompt"] = today_ob["prompt"]
        payload["hint"] = ("候选已就绪:按 prompt 要求编辑,结果传 rss_finalize(reply=...);"
                           "或 rss_finalize(rule=True) 直接落规则版")
    return _J(payload)


@mcp.tool()
def rss_fetch(force: bool = False, per_day: int = 0,
              wait_seconds: int = FETCH_WAIT_S) -> str:
    """抓取今天的 RSS 候选并产出编辑提示词(分钟级长任务)。

    最多内联等待 wait_seconds 秒;没跑完返回 RUNNING → 之后用 rss_status 轮询
    (完成后 status 会带出 prompt,别再调本工具,会全量重抓)。返回 status:
      READY         完成,prompt 一并返回(你接下来就是编辑)
      PENDING_SEND  今日已有定稿未确认,digest 一并返回,无需重抓
      SKIPPED_TODAY 今日已确认送达;要重做得 force=True(随后 finalize 需 redo=True)
      LOCKED        别的进程(dsh 插件/cron)正持有管线,轮询 rss_status 即可
      RUNNING       仍在抓取,稍后 rss_status
    force: 无视当日幂等门重选重投。per_day: 今日抓取源数(默认 10,测试可调小)。"""
    run, run_by = _running()
    if run:
        return _J({"status": "RUNNING", "running_by": run_by,
                   "hint": "已有抓取在跑,轮询 rss_status,完成后会带出 prompt"})
    extra = []
    if force:
        extra.append("--force")
    if per_day and per_day > 0:
        extra += ["--per-day", str(per_day)]
    cmd = [sys.executable, DAILY, "--stage", "fetch", "--state-dir", STATE_DIR, *_tz_args(), *extra]
    try:
        p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE,
                             text=True, encoding="utf-8", errors="replace", env=_env())
    except OSError as e:
        return _J({"status": "ERROR", "stderr": str(e)})
    try:
        out, err = p.communicate(timeout=max(5, wait_seconds))
    except subprocess.TimeoutExpired:
        global _proc
        _proc = p
        return _J({"status": "RUNNING", "child_pid": p.pid,
                   "hint": (
                       f"抓取超过 {wait_seconds}s 仍在跑;轮询 rss_status,"
                       "完成后会带出 prompt,别重复调本工具")})
    for line in reversed((out or "").splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if (err or "").strip():
                obj.setdefault("stderr", err.strip()[-1500:])
            if obj.get("status") == "READY":
                ob = _read_json(OUTBOX)
                if ob.get("prompt"):
                    obj["prompt"] = ob["prompt"]
                else:  # need_llm=False:池空,只有规则版兜底
                    obj["hint"] = "候选池为空,可 rss_finalize(rule=True) 落规则版"
            return _J(obj)
    return _J({"status": "ERROR", "stdout_tail": (out or "")[-500:],
               "stderr": (err or "")[-1500:]})


@mcp.tool()
def rss_finalize(reply: str = "", rule: bool = False, redo: bool = False,
                 footer: str = "", digest_items: int = 0) -> str:
    """把编辑结果落稿(生成/更新当日日报文本)。

    你(宿主 agent)就是编辑:按 rss_fetch / rss_status 返回的 prompt 要求挑选改写,
    把最终回复原文放进 reply——格式以 prompt 内说明为准(逐条编号行;
    解析失败或留空会自动降级规则版)。rule=True 直接用规则版定稿。

    redo=True: 无视已有定稿重新生成(force 重抓后必带)。
    返回 OK + digest 全文;之后展示给用户,用户认可再 rss_confirm。"""
    extra = []
    if rule:
        extra.append("--rule")
    if redo:
        extra.append("--redo")
    if footer:
        extra += ["--footer", footer]
    if digest_items and digest_items > 0:
        extra += ["--digest-items", str(digest_items)]
    stdin_text = None
    if reply and not rule:
        stdin_text = reply
        extra += ["--llm-reply", "-"]
    return _J(_stage("finalize", extra, stdin_text=stdin_text))


@mcp.tool()
def rss_confirm(date: str = "") -> str:
    """确认当日日报已送达(写幂等门;状态目录与 dsh 插件共享,确认后今日不再重发)。

    语义:你本身就是投递渠道——把定稿展示给用户、获得认可后才调用本工具,
    别在用户没看过的情况下确认。date 一般留空(当日)。"""
    extra = ["--date", date] if date else []
    return _J(_stage("confirm", extra, timeout=15))


if __name__ == "__main__":
    mcp.run()  # stdio
