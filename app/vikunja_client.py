"""Vikunja REST API 封装(异步)。"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import httpx

from .schemas import CreateTaskRequest

logger = logging.getLogger(__name__)

API_PREFIX = "/api/v1"
_TIMEOUT = httpx.Timeout(15.0, connect=10.0)


class VikunjaError(Exception):
    pass


class VikunjaClient:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api = self.base_url + API_PREFIX
        self.headers = {"Authorization": f"Bearer {token}"}

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        url = self.api + path
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.request(method, url, headers=self.headers, **kwargs)
        except httpx.RequestError as e:
            raise VikunjaError(f"无法连接 Vikunja: {e}") from e
        if resp.status_code >= 400:
            detail = resp.text[:300]
            raise VikunjaError(f"Vikunja {method} {path} -> {resp.status_code}: {detail}")
        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()

    # ---- 读取上下文 ----
    async def get_projects(self) -> list[dict]:
        data = await self._request("GET", "/projects")
        return data or []

    async def get_labels(self) -> list[dict]:
        data = await self._request("GET", "/labels")
        return data or []

    async def get_tasks(self, limit: int = 30) -> list[dict]:
        """获取近期未完成任务,用于给 LLM 提供上下文。"""
        params = {
            "sort": "-created",
            "filter_by": "done",
            "filter_value": "false",
            "filter_comparator": "equals",
            "per_page": str(limit),
        }
        data = await self._request("GET", "/tasks", params=params)
        return data or []

    # ---- 标签 ----
    async def create_label(self, title: str) -> dict:
        return await self._request("PUT", "/labels", json={"title": title})

    async def ensure_labels(self, titles: list[str]) -> list[dict]:
        """确保给定标题的标签都存在,返回 label 对象列表(含 id)。"""
        titles = [t.strip() for t in titles if t and t.strip()]
        if not titles:
            return []
        existing = {l["title"]: l for l in await self.get_labels()}
        result: list[dict] = []
        for t in titles:
            if t in existing:
                result.append(existing[t])
            else:
                created = await self.create_label(t)
                existing[t] = created
                result.append(created)
        return result

    # ---- 创建任务 ----
    async def create_task(self, req: CreateTaskRequest) -> dict:
        """创建任务。checklist 写入 description(markdown 复选框)。"""
        # 1. 处理标签 -> 拿到带 id 的 label 对象
        labels = await self.ensure_labels(req.labels)

        # 2. 组装 description(并入 checklist)
        description = _build_description(req.description, req.checklist)

        # 3. 组装 task body(创建时不传 labels:Vikunja 不会持久化该字段)
        body: dict[str, Any] = {
            "title": req.title,
            "description": description,
            "project_id": req.project_id,
            "priority": req.priority,
        }
        if req.due_date:
            body["due_date"] = _to_rfc3339(req.due_date)

        created = await self._request(
            "PUT", f"/projects/{req.project_id}/tasks", json=body
        )
        if not isinstance(created, dict) or "id" not in created:
            raise VikunjaError(f"创建任务返回异常: {created}")

        task_id = created["id"]

        # 4. 用单独端点逐个关联标签(Vikunja 创建任务时不会持久化 labels)
        for l in labels:
            try:
                await self._request(
                    "PUT", f"/tasks/{task_id}/labels", json={"label_id": l["id"]}
                )
            except VikunjaError as e:
                # code 8001 = 标签已存在于任务,属正常情况
                msg = str(e)
                if "8001" not in msg and "already exists" not in msg:
                    logger.warning("补加标签 %s 失败: %s", l.get("title"), e)

        return created

    def task_url(self, task_id: int) -> str:
        return f"{self.base_url}/tasks/{task_id}"


def _build_description(description: str, checklist: list[str]) -> str:
    parts: list[str] = []
    if description and description.strip():
        parts.append(description.strip())
    items = [c.strip() for c in checklist if c and c.strip()]
    if items:
        parts.append("\n".join(f"- [ ] {it}" for it in items))
    return "\n\n".join(parts)


def _to_rfc3339(date_str: str) -> str:
    """把 YYYY-MM-DD 转成本地时区 09:00 的 RFC3339 字符串。"""
    try:
        dt = datetime.strptime(date_str.strip(), "%Y-%m-%d").replace(hour=9)
    except ValueError:
        # 已经是别的格式,原样返回
        return date_str
    # 带上本地时区
    local = dt.astimezone()
    return local.isoformat()
