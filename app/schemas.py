"""数据模型。"""
from typing import Optional

from pydantic import BaseModel, Field


class TaskDraft(BaseModel):
    """LLM 生成 / 用户可编辑的任务草稿。"""

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
