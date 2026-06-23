"""数据模型。"""
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field


class TaskDraft(BaseModel):
    """LLM 生成 / 用户可编辑的任务草稿(create action 的子集,保持向后兼容)。"""

    title: str = ""
    description: str = ""
    project_id: Optional[int] = None
    due_date: Optional[str] = None  # YYYY-MM-DD 或空
    priority: int = Field(default=1, ge=0, le=5)
    labels: list[str] = Field(default_factory=list)
    checklist: list[str] = Field(default_factory=list)
    reason: str = ""  # AI 给出的理由,仅展示用,不写入 Vikunja


class ChatMessage(BaseModel):
    role: str
    content: str


class SuggestRequest(BaseModel):
    messages: list[ChatMessage]


class CreateTaskRequest(BaseModel):
    title: str
    description: str = ""
    project_id: int
    due_date: Optional[str] = None
    priority: int = Field(default=1, ge=0, le=5)
    labels: list[str] = Field(default_factory=list)
    checklist: list[str] = Field(default_factory=list)
    repeat_after: int = Field(default=0, ge=0)
    repeat_mode: int = Field(default=0, ge=0, le=2)


class OkResponse(BaseModel):
    ok: bool = True
    message: str = ""
    task_url: Optional[str] = None


# ============ Phase 4: 多动作架构 ============


class ActionCreate(BaseModel):
    """新建任务。"""

    type: Literal["create"] = "create"
    title: str
    description: str = ""
    project_id: Optional[int] = None
    due_date: Optional[str] = None
    priority: int = Field(default=1, ge=0, le=5)
    labels: list[str] = Field(default_factory=list)
    checklist: list[str] = Field(default_factory=list)
    repeat_after: int = Field(default=0, ge=0)
    repeat_mode: int = Field(default=0, ge=0, le=2)


class ActionUpdate(BaseModel):
    """更新已存在任务的字段。task_ref 是自然语言引用,前端 fuzzy 匹配出 task_id。"""

    type: Literal["update"] = "update"
    task_ref: str
    project_hint: Optional[str] = None
    fields: dict


class ActionComplete(BaseModel):
    """把任务标记完成。"""

    type: Literal["complete"] = "complete"
    task_ref: str
    project_hint: Optional[str] = None


class ActionQuery(BaseModel):
    """查询任务。filter 在前端本地应用到 tasks_index,不调用 Vikunja。"""

    type: Literal["query"] = "query"
    filter: dict = Field(default_factory=dict)
    summary: str = ""


class ActionCreateProject(BaseModel):
    """创建项目(支持 parent_project_id 建子项目)。"""

    type: Literal["create_project"] = "create_project"
    title: str
    parent_project_id: Optional[int] = None
    hex_color: Optional[str] = None
    identifier: Optional[str] = None
    is_favorite: Optional[bool] = None
    is_archived: Optional[bool] = None


class ActionUpdateProject(BaseModel):
    """更新项目字段。project_ref 自然语言引用,前端匹配 project_id。"""

    type: Literal["update_project"] = "update_project"
    project_ref: str
    fields: dict


Action = Annotated[
    Union[
        ActionCreate,
        ActionUpdate,
        ActionComplete,
        ActionQuery,
        ActionCreateProject,
        ActionUpdateProject,
    ],
    Field(discriminator="type"),
]


class ActionPlan(BaseModel):
    """LLM 输出的完整动作计划。"""

    reason: str = ""
    summary: str = ""
    actions: list[Action] = Field(default_factory=list)


class ExecuteActionsRequest(BaseModel):
    """前端批量执行动作的请求体。actions 是解析后的字典列表(task_id/project_id 已填)。"""

    actions: list[dict]
