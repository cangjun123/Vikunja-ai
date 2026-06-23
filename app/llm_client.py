"""LLM 客户端:流式调用 OpenAI 兼容的 chat completions 接口。"""
from __future__ import annotations

import json
import logging
import re
from typing import AsyncGenerator

import httpx

from .schemas import TaskDraft

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
    """把 LLM 返回的字典规整成 TaskDraft。"""
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
    """从完整文本解析出 TaskDraft。"""
    return coerce_draft(extract_json(content))
