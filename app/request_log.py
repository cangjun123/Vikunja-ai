"""把每次 AI 建任务的完整输入/输出落盘,便于事后排查。

每个请求写成一个可读块:时间戳、发给 LLM 的完整 messages(含拼接后的
系统提示 + 上下文 + 对话历史)、模型原始返回、解析结果。纯追加写,
日志失败绝不影响业务请求。
"""
from __future__ import annotations

import os
import threading
from datetime import datetime
from zoneinfo import ZoneInfo

_lock = threading.Lock()
_SEP = "=" * 60


def _fmt_messages(messages: list[dict]) -> str:
    """把 messages 列表格式化成可读文本,标注角色与长度。"""
    parts: list[str] = []
    for i, m in enumerate(messages):
        role = m.get("role", "?") if isinstance(m, dict) else "?"
        content = m.get("content", "") if isinstance(m, dict) else ""
        if not isinstance(content, str):
            content = repr(content)
        parts.append(f"[msg {i} · {role} · {len(content)} chars]\n{content}")
    return "\n\n".join(parts)


def log_request(
    log_file: str,
    messages: list[dict],
    output: str | None,
    status: str,
    error: str | None = None,
    timezone: str = "Asia/Shanghai",
) -> None:
    """追加一条请求记录。

    messages: 发给 LLM 的完整 messages(system + 对话历史)
    output:   LLM 的完整文本输出(None 表示未拿到,如流式中断)
    status:   "ok" / "parse_failed" / "stream_failed"
    error:    失败时的异常信息
    """
    try:
        tz = ZoneInfo(timezone)
    except (KeyError, ValueError):
        tz = ZoneInfo("UTC")
    ts = datetime.now(tz).strftime("%Y-%m-%d %H:%M:%S %z")

    output_len = len(output) if output else 0
    lines = [
        _SEP,
        f"[{ts}]  status={status}  input={len(messages)} msgs  output={output_len} chars",
    ]
    if error:
        lines.append(f"[ERROR] {error}")
    lines.append("--- INPUT (发给 LLM 的完整 messages) ---")
    lines.append(_fmt_messages(messages) or "(空)")
    lines.append("--- MODEL OUTPUT (模型原始返回) ---")
    lines.append(output if output is not None else "(无输出)")
    lines.append(_SEP)
    block = "\n".join(lines) + "\n\n"

    try:
        d = os.path.dirname(log_file)
        if d:
            os.makedirs(d, exist_ok=True)
        with _lock:
            with open(log_file, "a", encoding="utf-8") as f:
                f.write(block)
    except OSError:
        # 日志写入失败不能影响主流程
        pass
