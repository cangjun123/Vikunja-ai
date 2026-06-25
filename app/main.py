"""AI Task Assistant —— FastAPI 应用入口。

启动:
    uvicorn app.main:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import json
import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

from .auth import is_logged_in, require_api, verify_password
from .config import settings
from .llm_client import LLMClient, LLMError, parse_actions
from .prompt import SYSTEM_PROMPT, build_context
from .request_log import log_request
from .schemas import CreateTaskRequest, ExecuteActionsRequest, SuggestRequest
from .vikunja_client import VikunjaClient, VikunjaError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("ai-task-assistant")

vikunja = VikunjaClient(settings.vikunja_url, settings.vikunja_token, settings.app_timezone)
llm = LLMClient(settings.llm_base_url, settings.llm_api_key, settings.llm_model)

APP_DIR = os.path.dirname(__file__)
templates = Jinja2Templates(directory=os.path.join(APP_DIR, "templates"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    missing = settings.missing()
    if missing:
        logger.warning("⚠️  缺少环境变量: %s —— 请在 .env 里补全", ", ".join(missing))
    else:
        logger.info("✅ 配置检查通过")
    yield


app = FastAPI(title="AI Task Assistant", lifespan=lifespan)
app.add_middleware(SessionMiddleware, secret_key=settings.secret_key, same_site="lax")
app.mount(
    "/static", StaticFiles(directory=os.path.join(APP_DIR, "static")), name="static"
)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# ============ 页面路由 ============

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    if not is_logged_in(request):
        return RedirectResponse(url="/login", status_code=303)
    return templates.TemplateResponse(
        request, "index.html", {"model": settings.llm_model}
    )


@app.get("/tasks", response_class=HTMLResponse)
async def tasks_page(request: Request):
    """任务可视化看板页:列表 / 看板 / 日历 / 树(Phase 1 只读)。"""
    if not is_logged_in(request):
        return RedirectResponse(url="/login", status_code=303)
    return templates.TemplateResponse(request, "tasks.html", {})


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    return templates.TemplateResponse(request, "login.html", {"error": ""})


@app.post("/login")
async def login_submit(request: Request, password: str = Form(...)):
    if verify_password(password, settings.app_password):
        request.session["user"] = True
        return RedirectResponse(url="/", status_code=303)
    return templates.TemplateResponse(
        request, "login.html", {"error": "密码错误"}, status_code=401
    )


@app.post("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse(url="/login", status_code=303)


# ============ API ============

@app.get("/api/context")
async def api_context(_: None = Depends(require_api)):
    """返回项目与标签列表,供前端渲染下拉框。"""
    try:
        # AI 建议页不展示归档项目(避免选错)
        projects = await vikunja.get_projects(include_archived=False)
        labels = await vikunja.get_labels()
    except VikunjaError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {
        "projects": [{"id": p.get("id"), "title": p.get("title", "")} for p in projects],
        "labels": [l.get("title", "") for l in labels],
    }


@app.get("/api/tasks")
async def api_tasks(_: None = Depends(require_api)):
    """一次性返回 {tasks, projects, labels},供看板页四个视图共用。"""
    try:
        projects = await vikunja.get_projects()
        labels = await vikunja.get_labels()
        tasks = await vikunja.get_all_tasks()
    except VikunjaError as e:
        raise HTTPException(status_code=502, detail=str(e))
    # 只透出前端需要的字段(projects 保留层级/颜色信息)
    slim_projects = [
        {
            "id": p.get("id"),
            "title": p.get("title", ""),
            "parent_project_id": p.get("parent_project_id", 0) or 0,
            "hex_color": p.get("hex_color", "") or "",
            "identifier": p.get("identifier", "") or "",
            "position": p.get("position", 0) or 0,
            "is_favorite": bool(p.get("is_favorite", False)),
            "is_archived": bool(p.get("is_archived", False)),
        }
        for p in projects
    ]
    slim_labels = [
        {"id": l.get("id"), "title": l.get("title", ""), "hex_color": l.get("hex_color", "") or ""}
        for l in labels
    ]
    return {"tasks": tasks, "projects": slim_projects, "labels": slim_labels}


@app.post("/api/suggest")
async def api_suggest(req: SuggestRequest, _: None = Depends(require_api)):
    """流式生成任务建议(支持多轮对话,SSE):status -> delta* -> done|error。"""
    if not req.messages:
        raise HTTPException(status_code=400, detail="消息不能为空")

    async def event_stream():
        # 1. 读取 Vikunja 上下文
        try:
            yield _sse("status", {"msg": "正在读取 Vikunja 上下文…"})
            # 给 LLM 的项目列表也排除归档项目
            projects = await vikunja.get_projects(include_archived=False)
            labels = await vikunja.get_labels()
            tasks = await vikunja.get_tasks(limit=settings.max_context_tasks)
            # tasks_index 用于前端本地解析 task_ref + 应用 query filter
            tasks_index = await vikunja.get_tasks_slim(limit=200)
        except VikunjaError as e:
            yield _sse("error", {"detail": str(e)})
            return

        # 2. 组装多轮消息(system+上下文 + 对话历史)并流式调用 LLM
        yield _sse(
            "status",
            {"msg": f"已加载 {len(projects)} 个项目 / {len(labels)} 个标签,开始生成…"},
        )
        context = build_context(projects, labels, tasks)
        system_content = SYSTEM_PROMPT + "\n\n以下是上下文(JSON):\n" + context
        messages = [{"role": "system", "content": system_content}] + [
            m.model_dump() for m in req.messages
        ]
        collected: list[str] = []
        try:
            async for delta in llm.stream_chat(messages):
                collected.append(delta)
                yield _sse("delta", {"text": delta})
        except LLMError as e:
            log_request(
                settings.log_file, messages, "".join(collected) or None,
                "stream_failed", str(e), settings.app_timezone,
            )
            yield _sse("error", {"detail": str(e)})
            return

        # 3. 解析完整输出为动作计划
        output_text = "".join(collected)
        try:
            plan = parse_actions(output_text)
        except LLMError as e:
            log_request(
                settings.log_file, messages, output_text,
                "parse_failed", str(e), settings.app_timezone,
            )
            yield _sse("error", {"detail": str(e)})
            return

        log_request(
            settings.log_file, messages, output_text,
            "ok", None, settings.app_timezone,
        )
        yield _sse(
            "done",
            {
                "reason": plan.reason,
                "summary": plan.summary,
                "actions": [a.model_dump(mode="json") for a in plan.actions],
                "projects": [
                    {
                        "id": p.get("id"),
                        "title": p.get("title", ""),
                        "identifier": p.get("identifier", "") or "",
                        "hex_color": p.get("hex_color", "") or "",
                    }
                    for p in projects
                ],
                "labels": [
                    {"id": l.get("id"), "title": l.get("title", "")} for l in labels
                ],
                "tasks_index": tasks_index,
            },
        )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/create-task")
async def api_create_task(req: CreateTaskRequest, _: None = Depends(require_api)):
    """确认后创建任务到 Vikunja。"""
    if not req.title.strip():
        raise HTTPException(status_code=400, detail="标题不能为空")
    try:
        created = await vikunja.create_task(req)
    except VikunjaError as e:
        raise HTTPException(status_code=502, detail=str(e))
    task_id = created.get("id")
    return {"ok": True, "task_url": vikunja.task_url(task_id) if task_id else None}


@app.post("/api/tasks/{task_id}")
async def api_update_task(task_id: int, fields: dict, _: None = Depends(require_api)):
    """部分更新任务(标题/截止/优先级/项目/完成状态等)。

    body 是任意字段字典,原样转给 Vikunja 的 POST /tasks/{id}。
    返回 Vikunja 更新后的完整 task 对象,供前端刷新本地状态。
    """
    if not isinstance(fields, dict) or not fields:
        raise HTTPException(status_code=400, detail="请求体必须是字段字典")
    try:
        updated = await vikunja.update_task(task_id, fields)
    except VikunjaError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, "task": updated}


@app.delete("/api/tasks/{task_id}")
async def api_delete_task(task_id: int, _: None = Depends(require_api)):
    """删除任务。"""
    try:
        await vikunja.delete_task(task_id)
    except VikunjaError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


# ============ 批量动作执行(Phase 4)============


@app.post("/api/execute-actions")
async def api_execute_actions(
    req: ExecuteActionsRequest, _: None = Depends(require_api)
):
    """批量执行动作列表,按 type 分发,返 per-action 结果。

    前端已经解析完 task_ref/project_ref 成 task_id/project_id,这里只做执行。
    每条动作独立 try/except,失败不影响其他动作;前端按 index 对齐结果。
    """
    results: list[dict] = []
    for i, action in enumerate(req.actions):
        t = action.get("type")
        try:
            if t == "create":
                # 透传 create 子字段给 CreateTaskRequest
                payload = {
                    "title": str(action.get("title", "")).strip(),
                    "description": str(action.get("description", "") or ""),
                    "project_id": int(action.get("project_id") or 0),
                    "due_date": action.get("due_date"),
                    "priority": int(action.get("priority", 1)),
                    "labels": list(action.get("labels") or []),
                    "checklist": list(action.get("checklist") or []),
                    "repeat_after": int(action.get("repeat_after", 0) or 0),
                    "repeat_mode": int(action.get("repeat_mode", 0) or 0),
                }
                if not payload["title"]:
                    raise ValueError("标题不能为空")
                if not payload["project_id"]:
                    raise ValueError("请选择项目")
                req_obj = CreateTaskRequest(**payload)
                created = await vikunja.create_task(req_obj)
                results.append(
                    {
                        "index": i,
                        "ok": True,
                        "task_url": vikunja.task_url(created.get("id"))
                        if created.get("id")
                        else None,
                    }
                )
            elif t == "update":
                task_id = int(action.get("task_id") or 0)
                if not task_id:
                    raise ValueError("缺少 task_id(前端未匹配到任务)")
                fields = action.get("fields") or {}
                if not isinstance(fields, dict) or not fields:
                    raise ValueError("fields 不能为空")
                await vikunja.update_task(task_id, fields)
                results.append({"index": i, "ok": True})
            elif t == "complete":
                task_id = int(action.get("task_id") or 0)
                if not task_id:
                    raise ValueError("缺少 task_id(前端未匹配到任务)")
                await vikunja.set_done(task_id, True)
                results.append({"index": i, "ok": True})
            elif t == "create_project":
                body = {
                    k: v
                    for k, v in action.items()
                    if k != "type" and v is not None
                }
                if not body.get("title"):
                    raise ValueError("项目名称不能为空")
                await vikunja.create_project(body)
                results.append({"index": i, "ok": True})
            elif t == "update_project":
                pid = int(action.get("project_id") or 0)
                if not pid:
                    raise ValueError("缺少 project_id(前端未匹配到项目)")
                fields = action.get("fields") or {}
                if not isinstance(fields, dict) or not fields:
                    raise ValueError("fields 不能为空")
                await vikunja.update_project(pid, fields)
                results.append({"index": i, "ok": True})
            elif t == "query":
                # query 动作前端已经内联渲染,这里 no-op
                results.append({"index": i, "ok": True})
            else:
                raise ValueError(f"未知的动作类型: {t!r}")
        except (VikunjaError, ValueError, KeyError, TypeError) as e:
            results.append({"index": i, "ok": False, "error": str(e)})
    return {"ok": all(r["ok"] for r in results), "results": results}


# ============ 项目管理 ============

@app.put("/api/projects")
async def api_create_project(fields: dict, _: None = Depends(require_api)):
    """创建项目(支持 parent_project_id 建子项目)。body 字段透传。"""
    if not isinstance(fields, dict) or not fields:
        raise HTTPException(status_code=400, detail="请求体必须是字段字典")
    try:
        created = await vikunja.create_project(fields)
    except VikunjaError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, "project": created}


@app.post("/api/projects/{pid}")
async def api_update_project(pid: int, fields: dict, _: None = Depends(require_api)):
    """更新项目字段。body 字段透传。"""
    if not isinstance(fields, dict) or not fields:
        raise HTTPException(status_code=400, detail="请求体必须是字段字典")
    try:
        updated = await vikunja.update_project(pid, fields)
    except VikunjaError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, "project": updated}


@app.delete("/api/projects/{pid}")
async def api_delete_project(pid: int, _: None = Depends(require_api)):
    """删除项目。Vikunja 对非空项目的处理(级联/拒绝)实施时实测。"""
    try:
        await vikunja.delete_project(pid)
    except VikunjaError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}
