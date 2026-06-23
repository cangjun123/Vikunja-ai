const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let lastCommand = "";
let conversation = []; // 多轮对话历史 [{role, content}]
let currentLabels = [];
let currentChecklist = [];

/* ============ 命令历史 ============ */
function loadHistory() {
  try { return JSON.parse(localStorage.getItem("vka_history") || "[]"); } catch { return []; }
}
function saveHistory(h) {
  try { localStorage.setItem("vka_history", JSON.stringify(h)); } catch {}
}
function addHistory(cmd) {
  let h = loadHistory().filter((c) => c !== cmd);
  h.unshift(cmd);
  saveHistory(h.slice(0, 6));
  renderHistory();
}
function renderHistory() {
  const h = loadHistory();
  const sec = $("history-section");
  const list = $("history-list");
  if (!h.length) { sec.hidden = true; return; }
  sec.hidden = false;
  list.innerHTML = "";
  for (const cmd of h) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "history-item";
    el.textContent = cmd;
    el.addEventListener("click", () => {
      $("desc").value = cmd;
      $("desc").focus();
    });
    list.appendChild(el);
  }
}

/* ============ 错误格式化 ============ */
function fmtApiError(status, data) {
  // FastAPI 校验错误返回 detail 为数组 [{loc, msg, type}…];其它是字符串。
  const d = data && data.detail;
  if (Array.isArray(d) && d.length) {
    return d.map((x) => x.msg || JSON.stringify(x)).join("; ");
  }
  if (typeof d === "string" && d) return d;
  return `请求失败 (${status})`;
}

/* ============ 状态提示 ============ */
function setStatus(msg, type, html) {
  const el = $("status");
  if (!msg && !html) { el.hidden = true; el.textContent = ""; el.className = "status"; return; }
  el.hidden = false;
  el.className = "status " + type;
  el.innerHTML = html || esc(msg);
}

/* ============ 标签 chip 编辑 ============ */
function renderTags() {
  const d = $("tags-display");
  d.innerHTML = "";
  for (const t of currentLabels) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    const lbl = document.createElement("span");
    lbl.textContent = t;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "tag-x";
    x.textContent = "×";
    x.setAttribute("aria-label", "删除标签");
    x.addEventListener("click", () => {
      currentLabels = currentLabels.filter((v) => v !== t);
      renderTags();
    });
    chip.appendChild(lbl);
    chip.appendChild(x);
    d.appendChild(chip);
  }
}
function setupTagInput() {
  const inp = $("f-labels-input");
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const v = inp.value.trim().replace(/,+$/, "");
      if (v && !currentLabels.includes(v)) { currentLabels.push(v); renderTags(); }
      inp.value = "";
    } else if (e.key === "Backspace" && !inp.value && currentLabels.length) {
      currentLabels.pop();
      renderTags();
    }
  });
}

/* ============ 清单编辑 ============ */
function renderChecklist() {
  const d = $("checklist-display");
  d.innerHTML = "";
  for (const item of currentChecklist) {
    const row = document.createElement("div");
    row.className = "check-item";
    const dot = document.createElement("span");
    dot.className = "check-dot";
    const txt = document.createElement("span");
    txt.className = "check-text";
    txt.textContent = item;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "check-del";
    del.textContent = "×";
    del.setAttribute("aria-label", "删除步骤");
    del.addEventListener("click", () => {
      currentChecklist = currentChecklist.filter((v) => v !== item);
      renderChecklist();
    });
    row.appendChild(dot);
    row.appendChild(txt);
    row.appendChild(del);
    d.appendChild(row);
  }
}
function setupChecklistInput() {
  const inp = $("f-checklist-input");
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = inp.value.trim();
      if (v && !currentChecklist.includes(v)) { currentChecklist.push(v); renderChecklist(); }
      inp.value = "";
    }
  });
}

/* ============ SSE 解析 ============ */
function parseSSEBlock(block) {
  const lines = block.split("\n");
  let event = "message";
  let dataStr = "";
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
  }
  if (!dataStr) return null;
  try { return { event, data: JSON.parse(dataStr) }; } catch { return null; }
}

function renderDraft(data) {
  const d = data.draft;
  $("f-title").value = d.title || "";

  const sel = $("f-project");
  sel.innerHTML = '<option value="">(未选择)</option>';
  const projMap = {};
  for (const p of data.projects || []) {
    projMap[p.id] = p.title;
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.title;
    if (d.project_id === p.id) opt.selected = true;
    sel.appendChild(opt);
  }

  $("f-priority").value = String(d.priority ?? 1);
  $("f-due").value = (d.due_date || "").slice(0, 10);
  $("f-desc").value = d.description || "";

  currentLabels = Array.isArray(d.labels) ? [...d.labels] : [];
  currentChecklist = Array.isArray(d.checklist) ? [...d.checklist] : [];
  renderTags();
  renderChecklist();

  const rc = $("reason-card");
  if (d.reason) { rc.hidden = false; $("reason").textContent = d.reason; }
  else { rc.hidden = true; }

  const ctxCard = $("context-card");
  const ctxList = $("context-tasks");
  const tasks = data.recent_tasks || [];
  if (tasks.length) {
    ctxCard.hidden = false;
    ctxList.innerHTML = "";
    for (const t of tasks) {
      const row = document.createElement("div");
      row.className = "ctx-item";
      const b = document.createElement("span");
      b.className = "ctx-bullet";
      const ti = document.createElement("span");
      ti.className = "ctx-title";
      ti.textContent = t.title;
      const pj = document.createElement("span");
      pj.className = "ctx-proj";
      pj.textContent = projMap[t.project_id] || "—";
      row.appendChild(b);
      row.appendChild(ti);
      row.appendChild(pj);
      ctxList.appendChild(row);
    }
  } else {
    ctxCard.hidden = true;
  }

  $("draft-section").hidden = false;
  $("draft-section").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ============ 多轮:首次生成 / 继续优化 ============ */
async function suggest() {
  const text = $("desc").value.trim();
  if (!text) { setStatus("请先描述要新建的任务", "error"); $("desc").focus(); return; }
  lastCommand = text;
  conversation = [{ role: "user", content: text }];
  await runSuggest(true);
}

async function refine() {
  const text = $("refine-input").value.trim();
  if (!text) { setStatus("请输入修改意见", "error"); $("refine-input").focus(); return; }
  $("refine-input").value = "";
  conversation.push({ role: "user", content: text });
  await runSuggest(false);
}

async function runSuggest(isFirst) {
  $("btn-suggest").disabled = true;
  $("btn-refine").disabled = true;
  $("draft-section").hidden = true;
  $("stream-output").textContent = "";
  $("stream-section").hidden = false;
  setStatus(isFirst ? "正在生成…" : "正在根据你的意见优化…", "info");
  try {
    const resp = await fetch("/api/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: conversation }),
    });
    if (resp.status === 401) { window.location.href = "/login"; return; }
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(fmtApiError(resp.status, e));
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let doneData = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const evt = parseSSEBlock(block);
        if (!evt) continue;
        if (evt.event === "status") {
          setStatus(evt.data.msg || "处理中…", "info");
          $("stream-title").textContent = evt.data.msg || "处理中…";
        } else if (evt.event === "delta") {
          $("stream-output").textContent += evt.data.text || "";
        } else if (evt.event === "done") {
          doneData = evt.data;
        } else if (evt.event === "error") {
          throw new Error(evt.data.detail || "生成失败");
        }
      }
    }
    if (doneData) {
      $("stream-section").hidden = true;
      renderDraft(doneData);
      // 把本版草稿作为 assistant 消息存入对话,支持后续继续迭代
      conversation.push({ role: "assistant", content: JSON.stringify(doneData.draft) });
      setStatus("已生成建议,可直接确认,或继续提出修改意见", "info");
      if (isFirst) addHistory(lastCommand);
    } else {
      throw new Error("未收到生成结果");
    }
  } catch (e) {
    setStatus("生成失败:" + e.message, "error");
    $("stream-section").hidden = true;
  } finally {
    $("btn-suggest").disabled = false;
    $("btn-refine").disabled = false;
  }
}

/* ============ 创建任务 ============ */
async function createTask() {
  const projId = parseInt($("f-project").value, 10);
  const body = {
    title: $("f-title").value.trim(),
    description: $("f-desc").value.trim(),
    project_id: isNaN(projId) ? 0 : projId,
    due_date: $("f-due").value || null,
    priority: parseInt($("f-priority").value, 10) || 0,
    labels: [...currentLabels],
    checklist: [...currentChecklist],
  };
  if (!body.title) { setStatus("标题不能为空", "error"); return; }
  if (!body.project_id) { setStatus("请选择项目", "error"); return; }
  $("btn-create").disabled = true;
  setStatus("正在创建…", "info");
  try {
    const resp = await fetch("/api/create-task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (resp.status === 401) { window.location.href = "/login"; return; }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(fmtApiError(resp.status, data));
    const link = data.task_url
      ? ` <a href="${esc(data.task_url)}" target="_blank">在 Vikunja 查看 →</a>`
      : "";
    setStatus("", "success", "✅ 任务已创建" + link);
    $("draft-section").hidden = true;
    conversation = [];
    $("desc").value = "";
    $("desc").focus();
  } catch (e) {
    setStatus("创建失败:" + e.message, "error");
  } finally {
    $("btn-create").disabled = false;
  }
}

/* ============ 取消 / 重新编辑 ============ */
function cancelDraft() {
  conversation = [];
  $("draft-section").hidden = true;
  setStatus("", "");
}
function reeditCommand() {
  conversation = [];
  $("draft-section").hidden = true;
  $("desc").value = lastCommand;
  $("desc").focus();
  $("desc").scrollIntoView({ behavior: "smooth", block: "center" });
}

document.addEventListener("DOMContentLoaded", () => {
  renderHistory();
  setupTagInput();
  setupChecklistInput();
  $("btn-suggest").addEventListener("click", suggest);
  $("btn-create").addEventListener("click", createTask);
  $("btn-cancel").addEventListener("click", cancelDraft);
  $("btn-edit").addEventListener("click", reeditCommand);
  $("btn-refine").addEventListener("click", refine);
  $("desc").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") suggest();
  });
  $("refine-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") refine();
  });
});
