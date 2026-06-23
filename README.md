# AI 任务助手 · for Vikunja

一个轻量的 Web 工具:用一句自然语言描述你要做的事,AI 自动帮你拆解成结构化的 Vikunja 任务(标题、项目、截止日期、优先级、标签、清单),并**流式**展示思考过程。支持**多轮对话**:对草稿不满意,直接提修改意见,AI 基于完整对话迭代,满意后再一键创建到 Vikunja。

> 后端 FastAPI + SSE 流式,前端原生 JS(零构建),兼容任何 OpenAI 接口格式的 LLM。

---

## ✨ 功能特性

- **自然语言建任务** —— "下周三前整理报销材料,放到杂活里" → 自动填好项目、日期、优先级。
- **流式输出** —— 边生成边显示,实时看到 AI 的推理文字(SSE,不是等几十秒黑屏)。
- **多轮对话优化** —— "截止日期推迟一周 / 加一个联系财务的步骤 / 标签换成报销",AI 只改你提到的部分,保留其余。
- **全字段可编辑** —— 草稿出来后所有字段都能直接改:标题、项目、截止日期、优先级、标签(chip)、描述、清单。
- **上下文感知** —— 自动读取你 Vikunja 里已有的项目、标签、近期未完成任务,AI 只会用真实存在的项目 ID 和已有标签,不会编造。
- **指令历史** —— 最近 6 条指令本地缓存,点击复用。
- **登录保护** —— 单密码 + Session,防止公网裸奔。
- **移动端友好** —— 响应式布局,手机上也能顺手用。
- **Docker 一键部署** —— 附带 `Dockerfile` + `docker-compose.yml`。

---

## 🧱 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Python 3.12 · FastAPI · Uvicorn · httpx |
| 模板 | Jinja2(服务端渲染) |
| 前端 | 原生 HTML/CSS/JS(无框架、无构建步骤) |
| 通信 | Server-Sent Events(SSE)流式 |
| LLM | 任意 OpenAI 兼容 `/v1/chat/completions` 接口 |
| 任务系统 | Vikunja REST API v1 |
| 部署 | Docker / docker-compose |

---

## 📂 项目结构

```
Vikunja-ai/
├── app/
│   ├── main.py              # FastAPI 入口:页面路由 + /api/suggest(流式) + /api/create-task
│   ├── llm_client.py        # LLM 客户端:流式调用 + JSON 解析 + TaskDraft 规整
│   ├── vikunja_client.py    # Vikunja REST 封装:读上下文、建任务、补标签
│   ├── prompt.py            # SYSTEM_PROMPT + build_context(注入项目/标签/近期任务/今天日期)
│   ├── schemas.py           # Pydantic 模型:TaskDraft / ChatMessage / SuggestRequest / CreateTaskRequest
│   ├── auth.py              # Session 登录 + require_api 依赖
│   ├── config.py            # 从环境变量读取配置(.env)
│   ├── templates/
│   │   ├── index.html       # 主界面(输入框 / 流式区 / 草稿卡 / 优化卡)
│   │   └── login.html       # 登录页
│   └── static/
│       ├── app.css          # 全部样式(含响应式)
│       └── app.js           # 全部前端逻辑(流式解析 / 多轮对话 / 标签&清单编辑)
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
├── .env.example             # 配置模板
└── README.md
```

---

## 🔧 前置准备

### 1. Vikunja API Token
在 Vikunja 网页端:`设置 → API Tokens → 新建`,勾选读/写权限,复制 `tk_xxx` 开头的 token。

### 2. LLM 服务
任意提供 **OpenAI 兼容 `/v1/chat/completions`** 流式接口的服务,例如:
- DeepSeek 官方 API
- OpenAI / Azure OpenAI
- 本地部署的 vLLM / Ollama(开 OpenAI 兼容端点)
- 各类聚合网关

你只需要拿到:**base_url**(到 `/v1`)、**api_key**、**model 名**。

---

## 🚀 快速开始(本地)

```bash
# 1. 克隆 / 进入目录
cd Vikunja-ai

# 2. 装依赖(建议用虚拟环境)
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS / Linux
pip install -r requirements.txt

# 3. 配置环境变量
copy .env.example .env          # Windows
# cp .env.example .env          # macOS / Linux
# 然后编辑 .env,填入下面 5 个必填项
```

`.env` 必填项:

```ini
APP_PASSWORD=你的登录密码
SECRET_KEY=随便一串很长的随机字符
VIKUNJA_URL=http://127.0.0.1:3456
VIKUNJA_TOKEN=tk_xxxxxxxxxxxxxxxx
LLM_BASE_URL=http://你的LLM地址/v1
LLM_API_KEY=你的LLM密钥
LLM_MODEL=deepseek-v4-flash
```

```bash
# 4. 启动
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# 5. 打开浏览器
# http://127.0.0.1:8000  → 输入 APP_PASSWORD 登录
```

启动时控制台会打印 `✅ 配置检查通过` 或列出缺失的变量。

---

## 🐳 Docker 部署

最快的方式 —— 用自带的 compose:

```bash
# 1. 准备好 .env(同上)
# 2. 一键起
docker compose up -d --build
```

默认映射到宿主机 `18080` 端口(在 `docker-compose.yml` 里改)。访问 `http://服务器IP:18080`。

查看日志 / 停止:

```bash
docker compose logs -f
docker compose down
```

---

## ⚙️ 配置项说明

| 变量 | 必填 | 说明 | 示例 |
|---|:--:|---|---|
| `APP_PASSWORD` | ✅ | 访问本工具的登录密码 | `my-strong-pwd` |
| `SECRET_KEY` | ✅ | Session 加密密钥,务必设成随机长串 | `a8f3...` |
| `VIKUNJA_URL` | ✅ | Vikunja 地址(**末尾不要加 `/`**) | `http://127.0.0.1:3456` |
| `VIKUNJA_TOKEN` | ✅ | Vikunja API Token(`tk_` 开头) | `tk_xxxxxxxxxxxx` |
| `LLM_BASE_URL` | ✅ | LLM 的 OpenAI 兼容地址(到 `/v1`) | `http://your-llm-host/v1` |
| `LLM_API_KEY` | ✅ | LLM 密钥 | `sk-...` / `csk_...` |
| `LLM_MODEL` | — | 模型名,默认 `deepseek-v4-flash` | `gpt-4o-mini` |
| `MAX_CONTEXT_TASKS` | — | 发给 LLM 的近期任务条数,默认 30 | `30` |

---

## 🔄 工作原理

### 整体流程

```
用户输入 ──► /api/suggest (SSE)
                │
                ├─ 1. 读取 Vikunja 上下文(项目 / 标签 / 近期任务)
                ├─ 2. 拼 system prompt + 上下文 JSON + 对话历史
                ├─ 3. 流式调用 LLM ──► 逐字 yield delta 给前端
                └─ 4. 全部收完 → 解析成 TaskDraft ──► yield done
                                              │
        前端渲染草稿卡(全字段可编辑)◄──────┘
                │
        ├── 不满意? 在"继续优化"里提意见 → 重新走 /api/suggest(带完整对话)
        └── 满意? 点"确认创建"
                    │
                    ▼
              /api/create-task
                    │
        ┌───────────┴───────────┐
        │ ensure_labels(复用/新建)│
        │ build_description      │  ← checklist 拼成 markdown 复选框
        │   (并入 checklist)     │
        │ PUT /projects/{id}/tasks│
        │ PUT /tasks/{id}/labels │  ← 逐个补标签(Vikunja 建任务时不持久化 labels)
        └───────────────────────┘
                    │
                    ▼
        返回 Vikunja 任务链接 → 用户点开查看
```

### 多轮对话的状态管理

对话历史**只存在前端 `conversation` 数组里**(后端无状态):

```js
conversation = [
  { role: "user",      content: "下周三前整理报销" },
  { role: "assistant", content: "{...上一版草稿JSON...}" },
  { role: "user",      content: "截止日期推迟一周" },
];
```

每次请求把整个数组 POST 给 `/api/suggest`,后端只负责拼上 system + 上下文。这样后端不需要存任何会话状态,水平扩展也无所谓。`确认创建` / `取消` / `重新编辑` 都会把 `conversation` 清空。

### SSE 事件协议

`/api/suggest` 依次发送:

| event | data | 含义 |
|---|---|---|
| `status` | `{msg}` | 进度提示("正在读取上下文…") |
| `delta` | `{text}` | LLM 输出的一个文本片段(可多次) |
| `done` | `{draft, projects, labels, recent_tasks}` | 最终结构化草稿 |
| `error` | `{detail}` | 出错 |

前端按顺序消费:`status` 更新状态条 → `delta` 追加到流式输出区 → `done` 渲染表单 → `error` 报错。

---

## 📡 API 参考

> 除 `/login` 外,所有接口都需先登录(未登录返回 `401`,前端会自动跳转登录页)。

### `POST /api/suggest` —— 流式生成任务建议
**请求体**
```json
{
  "messages": [
    {"role": "user", "content": "下周三前整理报销材料,放到杂活里"}
  ]
}
```
**响应**:`text/event-stream`,事件见上表。

### `POST /api/create-task` —— 创建任务到 Vikunja
**请求体**
```json
{
  "title": "整理报销材料",
  "description": "把近一个月的发票归类整理",
  "project_id": 12,
  "due_date": "2026-07-01",
  "priority": 2,
  "labels": ["报销", "财务"],
  "checklist": ["收集所有发票", "按类别分类", "填报销单"]
}
```
**响应**
```json
{ "ok": true, "task_url": "http://vikunja.example.com/tasks/1234" }
```

### `GET /api/context` —— 获取项目 & 标签列表
**响应**
```json
{
  "projects": [{"id": 12, "title": "杂活"}],
  "labels": ["报销", "财务"]
}
```

### `POST /logout` —— 登出,清空 session

---

## 🔐 安全说明

- **登录密码** 用 `hmac.compare_digest` 常时比较,防时序攻击。
- **Session** 由 Starlette `SessionMiddleware` 签名加密,密钥即 `SECRET_KEY` —— 生产环境**务必**换成随机长串。
- **Vikunja Token / LLM Key** 只存在后端环境变量里,绝不下发到前端。
- 本工具自身**不存任何用户数据**(除 localStorage 里的指令历史),所有任务数据都在你的 Vikunja 里。
- 如果要暴露到公网,强烈建议前置 nginx + HTTPS,别直接裸跑 8000 端口。

---

## 🛠️ 常见问题

**Q: 启动后访问一直跳登录页 / 登录后立刻又被踢出?**
A: `SECRET_KEY` 没设或太短。设一个长随机串重启即可。

**Q: 生成时卡在 "正在读取 Vikunja 上下文…" 然后报错?**
A: 检查 `VIKUNJA_URL`(末尾别带 `/`)和 `VIKUNJA_TOKEN` 是否有效,且 Vikunja 服务能从本机访问到。

**Q: 流式区一直转圈不出字?**
A: 三种可能:① `LLM_BASE_URL` 没到 `/v1` 这一级;② 模型名 `LLM_MODEL` 写错;③ LLM 服务不支持 `stream: true`。看后端日志里的具体错误。

**Q: 创建任务成功,但标签没带上?**
A: 已修复 —— Vikunja 建任务时不会持久化 `labels`,本工具会在建任务后用 `/tasks/{id}/labels` 端点逐个补加。若仍丢失,确认 token 有写标签的权限。

**Q: LLM 返回的不是合法 JSON,解析失败?**
A: 换个指令式更强的大模型,或在 `prompt.py` 里加强约束。当前 prompt 已要求"只返回一个合法 JSON 对象,不要 markdown 代码块"。

**Q: 想改默认优先级 / 截止时间推算逻辑?**
A: 改 `app/prompt.py` 里的 `SYSTEM_PROMPT`。所有生成规则都在提示词里。

**Q: 手机上能用吗?**
A: 能。布局是响应式的,窄屏自动单列。建议加到主屏幕当 PWA 用(暂未配 manifest,可自行扩展)。

---

## 🧩 自定义扩展点

想加点功能?改动集中在以下几个文件:

| 想做的事 | 改哪里 |
|---|---|
| 调整 AI 生成规则(优先级、日期推断等) | `app/prompt.py` `SYSTEM_PROMPT` |
| 增加任务字段(如重复提醒、指派人) | `app/schemas.py` + `vikunja_client.py` + `prompt.py` + 前端表单 |
| 换登录方式(OAuth 等) | `app/auth.py` |
| 美化界面 | `app/static/app.css` + `templates/index.html` |
| 加历史会话持久化 | 改 `app.js` 的 `conversation` 为后端存储 + 新增 API |

---

## 📄 License

MIT —— 随便用,欢迎 PR。
