"""配置读取:全部来自环境变量。"""
import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()  # 本地开发读取 .env;生产环境由容器注入环境变量


@dataclass
class Settings:
    app_password: str
    secret_key: str
    vikunja_url: str
    vikunja_token: str
    llm_base_url: str
    llm_api_key: str
    llm_model: str
    max_context_tasks: int
    app_timezone: str

    @classmethod
    def load(cls) -> "Settings":
        return cls(
            app_password=os.getenv("APP_PASSWORD", ""),
            secret_key=os.getenv("SECRET_KEY", "dev-insecure-secret-change-me"),
            vikunja_url=os.getenv("VIKUNJA_URL", "").rstrip("/"),
            vikunja_token=os.getenv("VIKUNJA_TOKEN", ""),
            llm_base_url=os.getenv("LLM_BASE_URL", "").rstrip("/"),
            llm_api_key=os.getenv("LLM_API_KEY", ""),
            llm_model=os.getenv("LLM_MODEL", "deepseek-v4-flash"),
            max_context_tasks=int(os.getenv("MAX_CONTEXT_TASKS", "30")),
            app_timezone=os.getenv("APP_TIMEZONE", "Asia/Shanghai"),
        )

    def missing(self) -> list[str]:
        """返回缺失的必需环境变量名。"""
        need = {
            "APP_PASSWORD": self.app_password,
            "VIKUNJA_URL": self.vikunja_url,
            "VIKUNJA_TOKEN": self.vikunja_token,
            "LLM_BASE_URL": self.llm_base_url,
            "LLM_API_KEY": self.llm_api_key,
        }
        return [k for k, v in need.items() if not v]


settings = Settings.load()
