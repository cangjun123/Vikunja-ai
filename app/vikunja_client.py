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
    async def get_projects(self, include_archived: bool = True) -> list[dict]:
        # Vikunja 默认只返非归档项目,要拿到归档项目需显式传 is_archived=true。
        params = {"is_archived": "true"} if include_archived else {}
        data = await self._request("GET", "/projects", params=params)
        return data or []

    # ---- 项目 CRUD ----
    async def create_project(self, fields: dict) -> dict:
        """创建项目(同 endpoint 支持 parent_project_id 建子项目)。"""
        return await self._request("PUT", "/projects", json=fields)

    async def update_project(self, pid: int, fields: dict) -> dict:
        return await self._request("POST", f"/projects/{pid}", json=fields)

    async def delete_project(self, pid: int) -> None:
        await self._request("DELETE", f"/projects/{pid}")

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

    async def get_tasks_slim(self, limit: int = 200) -> list[dict]:
        """获取未完成任务,只保留前端 task_ref fuzzy match 必需的 6 个字段。

        tasks_index 通过 SSE 下发给前端,用来本地解析 task_ref / 应用 query filter,
        避免每个 query action 都 round-trip 调 Vikunja。
        """
        params = {
            "sort": "-created",
            "filter_by": "done",
            "filter_value": "false",
            "filter_comparator": "equals",
            "per_page": str(limit),
        }
        data = await self._request("GET", "/tasks", params=params)
        return [
            {
                "id": t.get("id"),
                "title": t.get("title", ""),
                "project_id": t.get("project_id"),
                "due_date": (t.get("due_date") or "")[:10] or None,
                "priority": t.get("priority", 1),
                "done": bool(t.get("done", False)),
            }
            for t in (data or [])
        ]

    async def get_all_tasks(self, per_page: int = 50) -> list[dict]:
        """分页拉取全部任务(含已完成),供看板/日历/树视图使用。

        Vikunja 的 /tasks 支持分页,响应头 X-Pagination-Total-Pages 给出总页数。
        per_page=50,逐页拼接直到拿完。
        """
        all_tasks: list[dict] = []
        page = 1
        # 先拉第一页,顺便拿总页数(_request 目前只返回 json,这里单独走一次 client
        # 以读取响应头)。
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            url = self.api + "/tasks"
            params = {"per_page": str(per_page), "sort": "due_date"}
            while True:
                params_page = {**params, "page": str(page)}
                try:
                    resp = await client.get(
                        url, headers=self.headers, params=params_page
                    )
                except httpx.RequestError as e:
                    raise VikunjaError(f"无法连接 Vikunja: {e}") from e
                if resp.status_code >= 400:
                    raise VikunjaError(
                        f"Vikunja GET /tasks -> {resp.status_code}: {resp.text[:300]}"
                    )
                batch = resp.json() if resp.content else []
                if not isinstance(batch, list):
                    break
                all_tasks.extend(batch)
                total_pages = int(resp.headers.get("X-Pagination-Total-Pages", "1") or "1")
                if page >= total_pages or len(batch) < per_page:
                    break
                page += 1
        return all_tasks

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
            "repeat_after": req.repeat_after,
            "repeat_mode": req.repeat_mode,
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

    # ---- 编辑(Phase 2)----
    async def update_task(self, task_id: int, fields: dict) -> dict:
        """部分更新任务。Vikunja 用 POST /tasks/{id} 做更新,传啥改啥。

        特殊处理:
        - due_date 空字符串 → Go 零值时间(清空)。
        - labels 为标题字符串列表时,做 add/remove diff 同步
          (Vikunja POST body 里的 labels 字段不会被持久化,跟创建时一样)。
        """
        fields = dict(fields)  # 不修改入参
        # 标签 diff
        if "labels" in fields:
            titles = fields.pop("labels")
            await self._sync_task_labels(task_id, titles or [])

        body = _normalize_task_body(fields)
        updated = await self._request("POST", f"/tasks/{task_id}", json=body)
        # 如果只改了标签,fields 此刻是空的,POST 仍会返回当前完整任务对象,够用。
        return updated

    async def _sync_task_labels(self, task_id: int, titles: list[str]) -> None:
        """把任务的标签同步成给定标题列表(补缺、删多)。"""
        wanted_titles = {t.strip() for t in titles if t and t.strip()}
        wanted = await self.ensure_labels(sorted(wanted_titles))
        wanted_ids = {l["id"] for l in wanted}
        # 现有标签
        current_raw = await self._request("GET", f"/tasks/{task_id}/labels") or []
        current = [
            l["label_id"] if "label_id" in l else l.get("id")
            for l in current_raw
            if isinstance(l, dict)
        ]
        current_ids = {i for i in current if i is not None}
        # 添加缺少的
        for lid in wanted_ids - current_ids:
            try:
                await self._request(
                    "PUT", f"/tasks/{task_id}/labels", json={"label_id": lid}
                )
            except VikunjaError as e:
                if "8001" not in str(e) and "already exists" not in str(e):
                    logger.warning("补加标签 %s 失败: %s", lid, e)
        # 删除多余的
        for lid in current_ids - wanted_ids:
            try:
                await self._request("DELETE", f"/tasks/{task_id}/labels/{lid}")
            except VikunjaError as e:
                logger.warning("删除标签 %s 失败: %s", lid, e)

    async def set_done(self, task_id: int, done: bool) -> dict:
        """切换完成状态(对 update_task 的薄封装,语义更清楚)。"""
        return await self.update_task(task_id, {"done": bool(done)})

    async def delete_task(self, task_id: int) -> None:
        await self._request("DELETE", f"/tasks/{task_id}")

    async def remove_task_label(self, task_id: int, label_id: int) -> None:
        await self._request("DELETE", f"/tasks/{task_id}/labels/{label_id}")


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


# Vikunja 用 Go 零值时间表示"未设置";清理字段时需要传这个值。
_GO_ZERO_TIME = "0001-01-01T00:00:00Z"


def _normalize_task_body(fields: dict) -> dict:
    """把前端传来的字段转成 Vikunja 接受的格式。

    - due_date: "" 或 None → Go 零值(清空);YYYY-MM-DD → RFC3339
    """
    body = dict(fields)
    if "due_date" in body:
        v = body["due_date"]
        if not v:
            body["due_date"] = _GO_ZERO_TIME
        elif isinstance(v, str) and len(v) == 10:
            # YYYY-MM-DD → 带时区的 RFC3339
            body["due_date"] = _to_rfc3339(v)
    return body
