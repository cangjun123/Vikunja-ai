"""简单 session 登录。"""
import hmac

from fastapi import HTTPException, Request, status


def verify_password(input_pwd: str, expected: str) -> bool:
    return bool(input_pwd and expected) and hmac.compare_digest(input_pwd, expected)


def is_logged_in(request: Request) -> bool:
    return bool(request.session.get("user"))


def require_api(request: Request) -> None:
    """API 接口的登录依赖,未登录返回 401。"""
    if not is_logged_in(request):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="未登录或会话已过期",
        )
