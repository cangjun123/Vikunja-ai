"""LLM 客户端:流式调用 OpenAI 兼容的 chat completions 接口。"""
from __future__ import annotations

import json
import logging
import re
from typing import AsyncGenerator

import httpx

from .schemas import ActionPlan, TaskDraft

logger = logging.getLogger(__name__)

_STREAM_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=30.0)


class LLMError(Exception):
    pass


class LLMClient:
    def __init__(self, base_url: str, api_key: str, model: str) -> None:
        self.endpoint = base_url.rstrip("/") + "/chat/completions"
        self.api_key = api_key
        self.model = model

    async def stream_chat(
        self, messages: list[dict]
    ) -> AsyncGenerator[str, None]:
        """流式调用模型,逐个 yield content 文本片段。messages 需含 system 轮。"""
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.3,
            "stream": True,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        try:
            async with httpx.AsyncClient(timeout=_STREAM_TIMEOUT) as client:
                async with client.stream(
                    "POST", self.endpoint, headers=headers, json=payload
                ) as resp:
                    if resp.status_code >= 400:
                        body = await resp.aread()
                        raise LLMError(
                            f"LLM 请求失败 {resp.status_code}: "
                            + body[:300].decode("utf-8", "ignore")
                        )
                    async for line in resp.aiter_lines():
                        data_str = _data_line(line)
                        if data_str is None:
                            continue
                        if data_str == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data_str)
                        except json.JSONDecodeError:
                            continue
                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta") or {}
                        content = delta.get("content")
                        if content:
                            yield content
        except httpx.RequestError as e:
            raise LLMError(f"无法连接 LLM 服务: {e}") from e


def _data_line(line: str) -> str | None:
    line = line.strip()
    if line.startswith("data: "):
        return line[6:].strip()
    if line.startswith("data:"):
        return line[5:].strip()
    return None


def extract_json(content: str) -> dict:
    """从模型回复中提取 JSON 对象,兼容 markdown 代码块包裹。"""
    text = content.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    else:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end != -1 and end > start:
            text = text[start : end + 1]
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as e:
        raise LLMError(
            f"LLM 返回的不是合法 JSON: {e}\n原始内容: {content[:500]}"
        ) from e
    if not isinstance(obj, dict):
        raise LLMError(f"LLM 返回的不是 JSON 对象: {type(obj)}")
    return obj


def coerce_draft(obj: dict) -> TaskDraft:
    """把 LLM 返回的字典规整成 TaskDraft(create 子字段容错)。"""
    title = str(obj.get("title", "")).strip()
    if not title:
        raise LLMError("LLM 没有返回任务标题(title)")

    project_id = obj.get("project_id")
    if project_id in ("", "null", "None"):
        project_id = None
    try:
        project_id = int(project_id) if project_id is not None else None
    except (TypeError, ValueError):
        project_id = None

    due = obj.get("due_date")
    due = None if due in ("", "null", "None") else (str(due).strip() or None)

    try:
        priority = int(obj.get("priority", 1))
        priority = max(0, min(5, priority))
    except (TypeError, ValueError):
        priority = 1

    labels = obj.get("labels") or []
    if isinstance(labels, str):
        labels = [labels]
    labels = [str(x).strip() for x in labels if str(x).strip()]

    checklist = obj.get("checklist") or []
    if isinstance(checklist, str):
        checklist = [checklist]
    checklist = [str(x).strip() for x in checklist if str(x).strip()]

    return TaskDraft(
        title=title[:200],
        description=str(obj.get("description", "") or "").strip(),
        project_id=project_id,
        due_date=due,
        priority=priority,
        labels=labels,
        checklist=checklist,
        reason=str(obj.get("reason", "") or "").strip(),
    )


def parse_draft(content: str) -> TaskDraft:
    """从完整文本解析出 TaskDraft(create 单任务场景仍用)。"""
    return coerce_draft(extract_json(content))


# ---- Phase 4:多动作解析 ----


def _coerce_int(v, default=None):
    if v in (None, "", "null", "None"):
        return default
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _coerce_str_list(v) -> list[str]:
    if not v:
        return []
    if isinstance(v, str):
        v = [v]
    return [str(x).strip() for x in v if str(x).strip()]


def normalize_action(raw: dict) -> dict:
    """把 LLM 输出的单条 action 字典做轻量容错,返回标准化的 dict。

    discriminated union 在 parse_actions 里用 TypeAdapter 校验;
    这里先做基础字段规整,减少 pydantic 拒绝的几率。
    """
    if not isinstance(raw, dict):
        raise LLMError(f"动作必须是对象,收到 {type(raw).__name__}")
    t = str(raw.get("type", "")).strip().lower()
    out = dict(raw)
    out["type"] = t

    if t == "create":
        if not str(out.get("title", "")).strip():
            raise LLMError("create 动作缺少 title")
        out["title"] = str(out["title"]).strip()[:200]
        out["description"] = str(out.get("description", "") or "").strip()
        out["project_id"] = _coerce_int(out.get("project_id"))
        due = out.get("due_date")
        out["due_date"] = None if due in ("", "null", "None") else (str(due).strip() or None if due else None)
        out["priority"] = max(0, min(5, _coerce_int(out.get("priority"), 1) or 1))
        out["labels"] = _coerce_str_list(out.get("labels"))
        out["checklist"] = _coerce_str_list(out.get("checklist"))
        out["repeat_after"] = max(0, _coerce_int(out.get("repeat_after"), 0) or 0)
        out["repeat_mode"] = max(0, min(2, _coerce_int(out.get("repeat_mode"), 0) or 0))

    elif t == "update":
        ref = str(out.get("task_ref", "")).strip()
        if not ref:
            raise LLMError("update 动作缺少 task_ref")
        out["task_ref"] = ref
        hint = out.get("project_hint")
        out["project_hint"] = str(hint).strip() if hint else None
        fields = out.get("fields")
        if not isinstance(fields, dict) or not fields:
            raise LLMError("update 动作 fields 必须是非空对象")
        out["fields"] = fields

    elif t == "complete":
        ref = str(out.get("task_ref", "")).strip()
        if not ref:
            raise LLMError("complete 动作缺少 task_ref")
        out["task_ref"] = ref
        hint = out.get("project_hint")
        out["project_hint"] = str(hint).strip() if hint else None

    elif t == "query":
        filt = out.get("filter")
        out["filter"] = filt if isinstance(filt, dict) else {}
        out["summary"] = str(out.get("summary", "") or "").strip()

    elif t == "create_project":
        if not str(out.get("title", "")).strip():
            raise LLMError("create_project 动作缺少 title")
        out["title"] = str(out["title"]).strip()
        out["parent_project_id"] = _coerce_int(out.get("parent_project_id"))

    elif t == "update_project":
        ref = str(out.get("project_ref", "")).strip()
        if not ref:
            raise LLMError("update_project 动作缺少 project_ref")
        out["project_ref"] = ref
        fields = out.get("fields")
        if not isinstance(fields, dict) or not fields:
            raise LLMError("update_project 动作 fields 必须是非空对象")
        out["fields"] = fields

    else:
        raise LLMError(f"未知的动作类型: {t!r}")

    return out


def parse_actions(content: str) -> ActionPlan:
    """把 LLM 完整输出解析成 ActionPlan。

    兼容老格式:如果 JSON 里没有 `actions` 但有 `title`,wrap 成单条 create。
    """
    obj = extract_json(content)

    # 老格式兼容:单任务 {draft}
    if "actions" not in obj:
        if "title" in obj:
            draft = coerce_draft(obj)
            return ActionPlan(
                reason=draft.reason,
                actions=[
                    {
                        "type": "create",
                        "title": draft.title,
                        "description": draft.description,
                        "project_id": draft.project_id,
                        "due_date": draft.due_date,
                        "priority": draft.priority,
                        "labels": list(draft.labels),
                        "checklist": list(draft.checklist),
                    }
                ],
            )
        raise LLMError("LLM 输出缺少 actions 数组")

    raw_actions = obj.get("actions") or []
    if not isinstance(raw_actions, list):
        raise LLMError("actions 必须是数组")

    normalized: list[dict] = []
    for i, raw in enumerate(raw_actions):
        try:
            normalized.append(normalize_action(raw))
        except LLMError as e:
            raise LLMError(f"第 {i + 1} 个动作无效:{e}") from e

    # ActionPlan 构造时 pydantic 会按 discriminator="type" 校验每条 action
    try:
        plan = ActionPlan(
            reason=str(obj.get("reason", "") or "").strip(),
            summary=str(obj.get("summary", "") or "").strip(),
            actions=normalized,  # type: ignore[arg-type]
        )
    except Exception as e:
        raise LLMError(f"动作计划校验失败:{e}") from e
    return plan
