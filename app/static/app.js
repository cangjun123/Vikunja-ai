const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let lastCommand = "";
let conversation = []; // 多轮对话历史 [{role, content}]
let currentPlan = null; // 最近一次的动作计划(供 execute / refine 用)
let projectsCache = []; // [{id,title,identifier,hex_color}]
let labelsCache = []; // [{id,title}]
let tasksIndexCache = []; // slim 任务列表(本地 fuzzy match / query filter 用)

const TYPE_LABEL = {
  create: "新建任务",
  update: "修改",
  complete: "完成",
  query: "查询",
  create_project: "建项目",
  update_project: "改项目",
};

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

/* ============ 标签 chip 编辑(per-card 独立 state)============ */
function renderTags(container, labels, knownSet = null) {
  const d = container;
  d.innerHTML = "";
  for (const t of labels) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    if (knownSet && !knownSet.has(t)) chip.classList.add("tag-chip--new");
    const lbl = document.createElement("span");
    lbl.textContent = t;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "tag-x";
    x.textContent = "×";
    x.setAttribute("aria-label", "删除标签");
    x.addEventListener("click", () => {
      const idx = labels.indexOf(t);
      if (idx >= 0) labels.splice(idx, 1);
      renderTags(container, labels, knownSet);
    });
    chip.appendChild(lbl);
    chip.appendChild(x);
    d.appendChild(chip);
  }
}
function setupTagInput(inp, labels, display, knownSet = null) {
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const v = inp.value.trim().replace(/,+$/, "");
      if (v && !labels.includes(v)) { labels.push(v); renderTags(display, labels, knownSet); }
      inp.value = "";
    } else if (e.key === "Backspace" && !inp.value && labels.length) {
      labels.pop();
      renderTags(display, labels, knownSet);
    }
  });
}

/* ============ 清单编辑(per-card 独立 state)============ */
function renderChecklist(container, items) {
  container.innerHTML = "";
  for (const item of items) {
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
      const idx = items.indexOf(item);
      if (idx >= 0) items.splice(idx, 1);
      renderChecklist(container, items);
    });
    row.appendChild(dot);
    row.appendChild(txt);
    row.appendChild(del);
    container.appendChild(row);
  }
}
function setupChecklistInput(inp, items, display) {
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = inp.value.trim();
      if (v && !items.includes(v)) { items.push(v); renderChecklist(display, items); }
      inp.value = "";
    }
  });
}

/* ============ task_ref fuzzy match ============ */
/**
 * 把字符串拆成 token 集合(中文按 bigram,英文按单词)。
 */
function tokenize(s) {
  if (!s) return new Set();
  const t = String(s).toLowerCase().trim();
  const tokens = new Set();
  // 中文 bigram
  const cjk = t.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const seg of cjk) {
    for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2));
  }
  // 英文 / 数字单词
  const words = t.match(/[a-z0-9]+/g) || [];
  for (const w of words) tokens.add(w);
  // 整串也作为一个 token
  if (t) tokens.add(t);
  return tokens;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * 给一个 task_ref + project_hint 在 tasks_index 里打分,返回 top-K 候选。
 * 评分规则见 plan 文档。
 */
function resolveTaskRef(ref, projectHint, tasksIndex, k = 3) {
  const refTok = tokenize(ref);
  const hintTok = projectHint ? tokenize(projectHint) : null;
  const scored = [];
  for (const t of tasksIndex) {
    const titleTok = tokenize(t.title);
    const proj = projectsCache.find((p) => p.id === t.project_id);
    let score = 0;
    // project_hint 匹配
    if (hintTok && proj) {
      const projTok = tokenize(proj.title);
      let inter = 0;
      for (const x of hintTok) if (projTok.has(x)) inter++;
      if (inter > 0) score += 100;
    }
    // title 完全等于 ref
    if (t.title === ref) score += 50;
    // 包含关系
    if (t.title.includes(ref) || ref.includes(t.title)) score += 30;
    // 共享 token
    score += Math.round(10 * jaccard(refTok, titleTok));
    if (score > 0) scored.push({ task: t, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * 项目引用 fuzzy match(用 title 做 contains 即可,项目数量少)。
 */
function resolveProjectRef(ref) {
  if (!ref) return [];
  const r = ref.toLowerCase().trim();
  const scored = [];
  for (const p of projectsCache) {
    const title = (p.title || "").toLowerCase();
    let score = 0;
    if (title === r) score = 100;
    else if (title.includes(r) || r.includes(title)) score = 50;
    if (score > 0) scored.push({ project: p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3);
}

/* ============ create 卡片字段 ============ */
/**
 * 从 template 克隆一份 create 字段 DOM,绑定 state,返回 { root, collect }。
 * collect() 把当前 DOM state 收集成标准化的 create action dict(供执行)。
 */
function buildCreateFields(action) {
  const tpl = $("tpl-create-fields");
  // 注意:DocumentFragment 被 appendChild 后子节点会被"领养"走,fragment 自己变空。
  // 所以必须先把所有元素引用存下来,collet 时用引用而不是再 querySelector。
  const frag = tpl.content.cloneNode(true);

  const titleInp = frag.querySelector('[data-k="title"]');
  const descInp = frag.querySelector('[data-k="description"]');
  const dueInp = frag.querySelector('[data-k="due_date"]');
  const prioSel = frag.querySelector('[data-k="priority"]');
  const repeatSel = frag.querySelector('[data-k="repeat"]');
  const projSel = frag.querySelector('[data-k="project_id"]');

  projSel.innerHTML = '<option value="">(未选择)</option>';
  for (const p of projectsCache) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.title;
    if (action.project_id === p.id) opt.selected = true;
    projSel.appendChild(opt);
  }

  titleInp.value = action.title || "";
  dueInp.value = (action.due_date || "").slice(0, 10);
  prioSel.value = String(action.priority ?? 1);
  repeatSel.value = repeatToSelectValue(action.repeat_after, action.repeat_mode);
  descInp.value = action.description || "";

  const labels = Array.isArray(action.labels) ? [...action.labels] : [];
  const checklist = Array.isArray(action.checklist) ? [...action.checklist] : [];
  const labelsDisplay = frag.querySelector('[data-k="labels-display"]');
  const labelsInput = frag.querySelector('[data-k="labels-input"]');
  const checklistDisplay = frag.querySelector('[data-k="checklist-display"]');
  const checklistInput = frag.querySelector('[data-k="checklist-input"]');
  const labelsKnownSet = new Set(labelsCache.map((l) => l.title));
  renderTags(labelsDisplay, labels, labelsKnownSet);
  setupTagInput(labelsInput, labels, labelsDisplay, labelsKnownSet);
  renderChecklist(checklistDisplay, checklist);
  setupChecklistInput(checklistInput, checklist, checklistDisplay);

  const collect = () => {
    const projId = parseInt(projSel.value, 10);
    const rep = repeatFromSelect(repeatSel.value);
    return {
      type: "create",
      title: titleInp.value.trim(),
      description: descInp.value.trim(),
      project_id: isNaN(projId) ? null : projId,
      due_date: dueInp.value || null,
      priority: parseInt(prioSel.value, 10) || 0,
      repeat_after: rep.repeat_after,
      repeat_mode: rep.repeat_mode,
      labels: [...labels],
      checklist: [...checklist],
    };
  };

  return { root: frag, collect };
}

/* ============ 重复任务:select ↔ repeat_after/mode ============ */
function repeatFromSelect(v) {
  switch (v) {
    case "daily":   return { repeat_after: 86400, repeat_mode: 0 };
    case "weekly":  return { repeat_after: 604800, repeat_mode: 0 };
    case "monthly": return { repeat_after: 2592000, repeat_mode: 1 };
    case "yearly":  return { repeat_after: 31536000, repeat_mode: 0 };
    default:        return { repeat_after: 0, repeat_mode: 0 };
  }
}
function repeatToSelectValue(after, mode) {
  if (mode === 1) return "monthly";
  if (!after) return "none";
  if (after === 86400) return "daily";
  if (after === 604800) return "weekly";
  if (after === 31536000) return "yearly";
  return "none"; // 自定义秒数回退到 none(后端原值不变更)
}

/* ============ 单条动作卡片渲染 ============ */
/**
 * 把一条 action 渲染成 .action-card 元素。
 * card state 包含:
 *   - cancelled: 是否被用户勾选取消
 *   - collect(): 返回执行时用的 dict(含已解析的 task_id/project_id)
 *   - status: "pending" | "ok" | "error" | "warn"
 */
function renderActionCard(action, index) {
  const card = document.createElement("div");
  card.className = "action-card";
  card.dataset.type = action.type;
  card.dataset.index = String(index);

  const state = { cancelled: false, status: "pending", collect: null };

  // ---- 头部 ----
  const head = document.createElement("div");
  head.className = "action-head";

  const badge = document.createElement("span");
  badge.className = "action-badge";
  badge.dataset.type = action.type;
  badge.textContent = TYPE_LABEL[action.type] || action.type;
  head.appendChild(badge);

  const summary = document.createElement("span");
  summary.className = "action-summary";
  summary.textContent = summarizeAction(action);
  head.appendChild(summary);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "action-toggle";
  toggle.textContent = "▾";
  head.appendChild(toggle);

  const cancelLbl = document.createElement("label");
  cancelLbl.className = "action-cancel";
  const cancelChk = document.createElement("input");
  cancelChk.type = "checkbox";
  cancelLbl.appendChild(cancelChk);
  cancelLbl.appendChild(document.createTextNode("取消"));
  head.appendChild(cancelLbl);

  card.appendChild(head);

  // ---- body ----
  const body = document.createElement("div");
  body.className = "action-body";
  card.appendChild(body);

  // 默认折叠状态:create 默认折叠(update/complete/query/project 默认展开)
  let collapsedByDefault = action.type === "create";
  if (collapsedByDefault) card.classList.add("action-card--collapsed");

  toggle.addEventListener("click", () => {
    card.classList.toggle("action-card--collapsed");
  });

  cancelChk.addEventListener("change", () => {
    state.cancelled = cancelChk.checked;
    card.classList.toggle("action-card--cancelled", state.cancelled);
    updateExecuteCount();
    savePlanSnapshot();
  });

  // 按 type 分派具体 body 渲染
  if (action.type === "create") {
    renderCreateBody(body, action, state, summary);
  } else if (action.type === "update") {
    renderUpdateBody(body, action, state, summary);
  } else if (action.type === "complete") {
    renderCompleteBody(body, action, state, summary);
  } else if (action.type === "query") {
    renderQueryBody(body, action, state);
  } else if (action.type === "create_project") {
    renderCreateProjectBody(body, action, state, summary);
  } else if (action.type === "update_project") {
    renderUpdateProjectBody(body, action, state, summary);
  }

  card._state = state;
  return card;
}

function summarizeAction(action) {
  if (action.type === "create") return action.title || "(未命名任务)";
  if (action.type === "create_project") return action.title || "(未命名项目)";
  if (action.type === "update") return `${action.task_ref} · 改 ${Object.keys(action.fields || {}).join("/")}`;
  if (action.type === "complete") return action.task_ref;
  if (action.type === "query") return action.summary || "查询结果";
  if (action.type === "update_project") return `${action.project_ref} · 改 ${Object.keys(action.fields || {}).join("/")}`;
  return action.type;
}

/* ---- create body ---- */
function renderCreateBody(body, action, state, summaryEl) {
  const { root, collect } = buildCreateFields(action);
  body.appendChild(root);
  state.collect = () => {
    const c = collect();
    // 同步 summary 显示
    summaryEl.textContent = c.title || "(未命名任务)";
    return c;
  };
}

/* ---- update body:显示 task_ref 候选 + 可编辑字段表单 ---- */
const FIELD_LABELS = {
  due_date: "截止日期",
  priority: "优先级",
  title: "标题",
  description: "描述",
  labels: "标签",
  project_id: "项目",
  done: "完成",
};

/** 把候选 task 格式成 select option 文本(含截止/优先级/状态,便于区分重名) */
function taskRefOptionText(task, score) {
  const proj = projectsCache.find((p) => p.id === task.project_id);
  const projName = proj ? proj.title : "—";
  const due = task.due_date ? `截止 ${String(task.due_date).slice(0, 10)}` : "无截止";
  const prio = `P${task.priority ?? 0}`;
  const doneTag = task.done ? " · 已完成" : "";
  return `${task.title} · ${projName} · ${due} · ${prio}${doneTag} (匹配 ${score})`;
}

/** 为单个字段构造可编辑 row;read() 返回 { key: value } */
function makeFieldEditor(key, value) {
  const row = document.createElement("div");
  row.className = "field-edit-row";
  const lbl = document.createElement("label");
  lbl.textContent = FIELD_LABELS[key] || key;
  row.appendChild(lbl);

  let inputEl;
  const isObj = typeof value === "object" && value !== null && !Array.isArray(value);

  switch (key) {
    case "due_date":
      inputEl = document.createElement("input");
      inputEl.type = "date";
      inputEl.className = "input";
      inputEl.value = (value || "").slice(0, 10);
      break;
    case "priority": {
      inputEl = document.createElement("select");
      inputEl.className = "input";
      for (const [pv, pl] of [["0","0 无"],["1","1 低"],["2","2 较低"],["3","3 中"],["4","4 较高"],["5","5 紧急"]]) {
        const o = document.createElement("option");
        o.value = pv; o.textContent = pl;
        if (Number(pv) === (value ?? 0)) o.selected = true;
        inputEl.appendChild(o);
      }
      break;
    }
    case "title":
      inputEl = document.createElement("input");
      inputEl.type = "text";
      inputEl.className = "input";
      inputEl.value = value || "";
      break;
    case "description":
      inputEl = document.createElement("textarea");
      inputEl.className = "input";
      inputEl.value = value || "";
      inputEl.rows = 2;
      break;
    case "labels":
      inputEl = document.createElement("input");
      inputEl.type = "text";
      inputEl.className = "input";
      inputEl.value = Array.isArray(value) ? value.join(", ") : (value || "");
      inputEl.placeholder = "逗号分隔";
      break;
    case "project_id": {
      inputEl = document.createElement("select");
      inputEl.className = "input";
      for (const p of projectsCache) {
        const o = document.createElement("option");
        o.value = p.id; o.textContent = p.title;
        if (p.id === value) o.selected = true;
        inputEl.appendChild(o);
      }
      break;
    }
    case "done":
      inputEl = document.createElement("input");
      inputEl.type = "checkbox";
      inputEl.checked = !!value;
      inputEl.style.width = "18px";
      inputEl.style.height = "18px";
      break;
    default:
      // 复杂类型(dict)用 textarea + JSON,其他用 text
      if (isObj) {
        inputEl = document.createElement("textarea");
        inputEl.className = "input";
        inputEl.value = JSON.stringify(value, null, 2);
        inputEl.placeholder = "JSON 格式";
        inputEl.rows = 2;
      } else {
        inputEl = document.createElement("input");
        inputEl.type = "text";
        inputEl.className = "input";
        inputEl.value = String(value ?? "");
      }
      break;
  }

  row.appendChild(inputEl);

  return {
    row,
    read: () => {
      let out;
      if (key === "due_date") {
        out = inputEl.value || null;
      } else if (key === "priority") {
        out = parseInt(inputEl.value, 10) || 0;
      } else if (key === "project_id") {
        out = parseInt(inputEl.value, 10) || null;
      } else if (key === "labels") {
        out = inputEl.value.split(",").map((s) => s.trim()).filter(Boolean);
      } else if (key === "done") {
        out = inputEl.checked;
      } else if (isObj) {
        try { out = JSON.parse(inputEl.value); } catch { out = inputEl.value; }
      } else {
        out = inputEl.value;
      }
      return { [key]: out };
    },
  };
}

/** repeat_after + repeat_mode 共用一个 select,read() 返回两个键 */
function makeRepeatEditor(after, mode) {
  const row = document.createElement("div");
  row.className = "field-edit-row";
  const lbl = document.createElement("label");
  lbl.textContent = "重复";
  row.appendChild(lbl);

  const sel = document.createElement("select");
  sel.className = "input";
  for (const [rv, rl] of [["none","不重复"],["daily","每天"],["weekly","每周"],["monthly","每月"],["yearly","每年"]]) {
    const o = document.createElement("option");
    o.value = rv; o.textContent = rl;
    sel.appendChild(o);
  }
  sel.value = repeatToSelectValue(after, mode);
  row.appendChild(sel);

  return {
    row,
    read: () => {
      const r = repeatFromSelect(sel.value);
      return { repeat_after: r.repeat_after, repeat_mode: r.repeat_mode };
    },
  };
}

function renderUpdateBody(body, action, state, summaryEl) {
  const candidates = resolveTaskRef(action.task_ref, action.project_hint, tasksIndexCache);
  const picker = document.createElement("div");
  picker.className = "taskref-picker";
  const lbl = document.createElement("div");
  lbl.className = "taskref-label";
  lbl.textContent = "目标任务";
  picker.appendChild(lbl);

  let selectedTaskId = candidates[0]?.task.id || null;

  if (candidates.length === 0) {
    const warn = document.createElement("div");
    warn.className = "taskref-warn";
    warn.textContent = `⚠ 没有在现有任务中找到「${action.task_ref}」,此动作将被排除出执行。可在任务看板里确认后再来。`;
    picker.appendChild(warn);
    state.status = "warn";
  } else {
    const sel = document.createElement("select");
    sel.className = "taskref-select";
    for (const c of candidates) {
      const opt = document.createElement("option");
      opt.value = c.task.id;
      opt.textContent = taskRefOptionText(c.task, c.score);
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      selectedTaskId = parseInt(sel.value, 10);
    });
    picker.appendChild(sel);

    // top-1 ≥ 50 且 ≥ 2× runner-up 时自动选,否则提示用户复核
    const top = candidates[0];
    const runner = candidates[1];
    if (top.score < 50 || (runner && top.score < runner.score * 2)) {
      const note = document.createElement("div");
      note.className = "taskref-warn";
      note.textContent = "多个候选接近,请确认目标任务是否正确。";
      picker.appendChild(note);
    }
  }
  body.appendChild(picker);

  // 可编辑字段表单(替代旧的只读 diff-list)
  const fields = { ...(action.fields || {}) };
  const editors = [];
  const wrap = document.createElement("div");
  wrap.className = "field-edit-list";

  for (const [k, v] of Object.entries(fields)) {
    if (k === "repeat_mode") continue; // 与 repeat_after 共用 select
    if (k === "repeat_after") {
      const ed = makeRepeatEditor(fields.repeat_after ?? 0, fields.repeat_mode ?? 0);
      editors.push(ed);
      wrap.appendChild(ed.row);
      continue;
    }
    const ed = makeFieldEditor(k, v);
    editors.push(ed);
    wrap.appendChild(ed.row);
  }
  body.appendChild(wrap);

  state.collect = () => {
    const outFields = {};
    for (const ed of editors) Object.assign(outFields, ed.read());
    return {
      type: "update",
      task_id: selectedTaskId,
      fields: outFields,
    };
  };
}

/* ---- complete body ---- */
function renderCompleteBody(body, action, state, summaryEl) {
  const candidates = resolveTaskRef(action.task_ref, action.project_hint, tasksIndexCache);
  const picker = document.createElement("div");
  picker.className = "taskref-picker";
  const lbl = document.createElement("div");
  lbl.className = "taskref-label";
  lbl.textContent = "目标任务";
  picker.appendChild(lbl);

  let selectedTaskId = candidates[0]?.task.id || null;

  if (candidates.length === 0) {
    const warn = document.createElement("div");
    warn.className = "taskref-warn";
    warn.textContent = `⚠ 没有在现有任务中找到「${action.task_ref}」,此动作将被排除出执行。`;
    picker.appendChild(warn);
    state.status = "warn";
  } else {
    const sel = document.createElement("select");
    sel.className = "taskref-select";
    for (const c of candidates) {
      const opt = document.createElement("option");
      opt.value = c.task.id;
      opt.textContent = taskRefOptionText(c.task, c.score);
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      selectedTaskId = parseInt(sel.value, 10);
    });
    picker.appendChild(sel);
  }
  body.appendChild(picker);

  state.collect = () => ({
    type: "complete",
    task_id: selectedTaskId,
  });
}

/* ---- query body:内联渲染 filter 结果 ---- */
function renderQueryBody(body, action, state) {
  // summary 自然语言答案(如果有)
  if (action.summary) {
    const s = document.createElement("p");
    s.className = "action-hint";
    s.textContent = action.summary;
    body.appendChild(s);
  }

  // filter 描述
  const filterDesc = document.createElement("div");
  filterDesc.className = "action-hint";
  filterDesc.textContent = "筛选条件:" + describeFilter(action.filter);
  body.appendChild(filterDesc);

  // 应用 filter 到 tasksIndexCache
  const results = applyFilter(action.filter || {}, tasksIndexCache);

  const list = document.createElement("div");
  list.className = "query-results";
  if (results.length === 0) {
    const empty = document.createElement("div");
    empty.className = "query-empty";
    empty.textContent = "没有匹配的任务";
    list.appendChild(empty);
  } else {
    for (const t of results) {
      const proj = projectsCache.find((p) => p.id === t.project_id);
      const row = document.createElement("a");
      row.className = "ctx-item";
      row.href = `/tasks#task-${t.id}`;
      const b = document.createElement("span");
      b.className = "ctx-bullet";
      const ti = document.createElement("span");
      ti.className = "ctx-title";
      ti.textContent = t.title;
      const pj = document.createElement("span");
      pj.className = "ctx-proj";
      pj.textContent = proj ? proj.title : "—";
      const due = document.createElement("span");
      due.className = "ctx-proj";
      due.textContent = t.due_date || "无截止";
      row.appendChild(b);
      row.appendChild(ti);
      row.appendChild(due);
      row.appendChild(pj);
      list.appendChild(row);
    }
  }
  body.appendChild(list);

  const count = document.createElement("div");
  count.className = "action-hint";
  count.textContent = `共 ${results.length} 条匹配`;
  body.appendChild(count);

  // query 永远 ok(no-op on backend),collect 返回 type=query 即可
  state.collect = () => ({ type: "query", filter: action.filter || {}, summary: action.summary || "" });
}

/* ---- create_project body:字段表单 ---- */
function renderCreateProjectBody(body, action, state, summaryEl) {
  const wrap = document.createElement("div");
  wrap.className = "proj-fields";

  const fields = {
    title: action.title || "",
    parent_project_id: action.parent_project_id ?? "",
    hex_color: action.hex_color || "",
    identifier: action.identifier || "",
    is_favorite: !!action.is_favorite,
  };

  // 标题
  wrap.appendChild(projField("名称", buildText(fields.title, (v) => fields.title = v)));
  // 父项目
  const parentSel = document.createElement("select");
  parentSel.className = "input";
  parentSel.innerHTML = '<option value="">(无)</option>';
  for (const p of projectsCache) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.title;
    if (fields.parent_project_id === p.id) opt.selected = true;
    parentSel.appendChild(opt);
  }
  parentSel.addEventListener("change", () => {
    const v = parseInt(parentSel.value, 10);
    fields.parent_project_id = isNaN(v) ? null : v;
  });
  wrap.appendChild(projField("父项目", parentSel));
  // 颜色
  const colorInp = document.createElement("input");
  colorInp.type = "text";
  colorInp.className = "input";
  colorInp.value = fields.hex_color;
  colorInp.placeholder = "#3b82f6";
  colorInp.addEventListener("input", () => fields.hex_color = colorInp.value.trim() || null);
  wrap.appendChild(projField("颜色", colorInp));
  // identifier
  const idInp = document.createElement("input");
  idInp.type = "text";
  idInp.className = "input";
  idInp.value = fields.identifier;
  idInp.placeholder = "WORK";
  idInp.addEventListener("input", () => fields.identifier = idInp.value.trim() || null);
  wrap.appendChild(projField("标识", idInp));
  // is_favorite
  wrap.appendChild(projField("标星", buildCheckbox(fields.is_favorite, (v) => fields.is_favorite = v)));

  body.appendChild(wrap);

  state.collect = () => {
    const out = { type: "create_project", title: fields.title.trim() };
    if (fields.parent_project_id) out.parent_project_id = fields.parent_project_id;
    if (fields.hex_color) out.hex_color = fields.hex_color;
    if (fields.identifier) out.identifier = fields.identifier;
    if (fields.is_favorite) out.is_favorite = true;
    summaryEl.textContent = out.title || "(未命名项目)";
    return out;
  };
}

/* ---- update_project body ---- */
function renderUpdateProjectBody(body, action, state, summaryEl) {
  // 候选项目
  const candidates = resolveProjectRef(action.project_ref);
  const picker = document.createElement("div");
  picker.className = "taskref-picker";
  const lbl = document.createElement("div");
  lbl.className = "taskref-label";
  lbl.textContent = "目标项目";
  picker.appendChild(lbl);

  let selectedProjectId = candidates[0]?.project.id || null;

  if (candidates.length === 0) {
    const warn = document.createElement("div");
    warn.className = "taskref-warn";
    warn.textContent = `⚠ 没有找到项目「${action.project_ref}」,此动作将被排除出执行。`;
    picker.appendChild(warn);
    state.status = "warn";
  } else {
    const sel = document.createElement("select");
    sel.className = "taskref-select";
    for (const c of candidates) {
      const opt = document.createElement("option");
      opt.value = c.project.id;
      opt.textContent = `${c.project.title} (匹配度 ${c.score})`;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      selectedProjectId = parseInt(sel.value, 10);
    });
    picker.appendChild(sel);
  }
  body.appendChild(picker);

  // diff
  const diff = document.createElement("div");
  diff.className = "diff-list";
  const fields = action.fields || {};
  for (const [k, v] of Object.entries(fields)) {
    const row = document.createElement("div");
    row.className = "diff-row";
    const kEl = document.createElement("span");
    kEl.className = "diff-k";
    kEl.textContent = k;
    const vEl = document.createElement("span");
    vEl.className = "diff-v";
    vEl.textContent = formatVal(v);
    row.appendChild(kEl);
    row.appendChild(vEl);
    diff.appendChild(row);
  }
  body.appendChild(diff);

  state.collect = () => ({
    type: "update_project",
    project_id: selectedProjectId,
    fields: { ...fields },
  });
}

/* ============ 小工具:filter 应用 + 字段构造 ============ */
function applyFilter(filter, tasksIndex) {
  const f = filter || {};
  return tasksIndex.filter((t) => {
    if (f.project_id && t.project_id !== f.project_id) return false;
    if (f.due_after && (!t.due_date || t.due_date < f.due_after)) return false;
    if (f.due_before && (!t.due_date || t.due_date > f.due_before)) return false;
    if (f.priority_min && (t.priority ?? 0) < f.priority_min) return false;
    if (f.q && !(t.title || "").includes(f.q)) return false;
    if (f.done !== undefined && f.done !== null && !!t.done !== !!f.done) return false;
    return true;
  });
}

function describeFilter(f) {
  if (!f || Object.keys(f).length === 0) return "全部未完成任务";
  const parts = [];
  if (f.project_id) {
    const p = projectsCache.find((x) => x.id === f.project_id);
    parts.push(`项目=${p ? p.title : f.project_id}`);
  }
  if (f.due_after) parts.push(`不早于 ${f.due_after}`);
  if (f.due_before) parts.push(`不晚于 ${f.due_before}`);
  if (f.priority_min) parts.push(`优先级≥${f.priority_min}`);
  if (f.q) parts.push(`含"${f.q}"`);
  if (f.done !== undefined && f.done !== null) parts.push(f.done ? "已完成" : "未完成");
  return parts.join(" · ") || "全部未完成任务";
}

function formatVal(v) {
  if (v === null || v === undefined) return "(空)";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "是" : "否";
  return String(v);
}

function projField(labelText, el) {
  const row = document.createElement("div");
  row.className = "proj-field-row";
  const lbl = document.createElement("label");
  lbl.textContent = labelText;
  row.appendChild(lbl);
  row.appendChild(el);
  return row;
}
function buildText(initial, onChange) {
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "input";
  inp.value = initial;
  inp.addEventListener("input", () => onChange(inp.value));
  return inp;
}
function buildCheckbox(initial, onChange) {
  const lbl = document.createElement("label");
  lbl.className = "proj-bool";
  const inp = document.createElement("input");
  inp.type = "checkbox";
  inp.checked = !!initial;
  lbl.appendChild(inp);
  lbl.appendChild(document.createTextNode("是"));
  inp.addEventListener("change", () => onChange(inp.checked));
  return lbl;
}

/* ============ 渲染整个动作计划 ============ */
function renderActionPlan(data) {
  projectsCache = data.projects || [];
  labelsCache = data.labels || [];
  tasksIndexCache = data.tasks_index || [];

  // reason
  const rc = $("reason-card");
  if (data.reason) { rc.hidden = false; $("reason").textContent = data.reason; }
  else { rc.hidden = true; }

  // summary(查询回答,如果有)
  // summary 由 query 卡片自己渲染,顶层 summary 仅在没有任何 query action 时也单独显示一次
  // 这里简单处理:只在有 summary 且无 query action 时显示为顶部 banner(避免重复)
  const hasQuery = (data.actions || []).some((a) => a.type === "query");
  if (data.summary && !hasQuery) {
    // 复用 reason-card 区域下方加一个 summary 行
    rc.hidden = false;
    $("reason").textContent = data.reason
      ? `${data.reason}\n\n${data.summary}`
      : data.summary;
  }

  // actions
  const list = $("actions-list");
  list.innerHTML = "";
  currentPlan = { actions: data.actions || [], reason: data.reason || "", summary: data.summary || "" };

  if (!currentPlan.actions.length) {
    const empty = document.createElement("div");
    empty.className = "card empty";
    empty.textContent = "AI 没有给出任何动作,试着换一种说法?";
    list.appendChild(empty);
  } else {
    currentPlan.actions.forEach((action, i) => {
      const card = renderActionCard(action, i);
      list.appendChild(card);
    });
  }

  $("actions-section").hidden = false;
  updateExecuteCount();
  $("actions-section").scrollIntoView({ behavior: "smooth", block: "start" });
  if (!_restoring) savePlanSnapshot();
}

function updateExecuteCount() {
  const cards = document.querySelectorAll("#actions-list .action-card");
  let active = 0;
  cards.forEach((c) => {
    if (!c._state.cancelled && c._state.status !== "warn" && c._state.status !== "ok") active++;
  });
  $("execute-label").textContent = active > 0 ? `全部执行(${active} 条)` : "全部执行";
}

/* ============ 计划快照(跨页面持久化)============
 * AI 建任务页与任务看板页是两个独立页面,顶部导航切换 = 浏览器整页刷新,
 * 内存里的 currentPlan / 卡片状态会全部丢失。这里把当前计划 + 每张卡的
 * 状态/编辑值序列化进 sessionStorage,回到本页时自动重建,让执行结果与
 * 字段编辑在切页后仍得以保留。sessionStorage 随标签关闭自动清理。
 */
const PLAN_SNAPSHOT_KEY = "vka_plan_snapshot";
let _restoring = false;

/** 把已执行(ok/error)的视觉状态打到卡片上;executeAll 与恢复共用。 */
function markCardExecuted(card, type, ok, errorMsg) {
  const badge = card.querySelector(".action-badge");
  const label = TYPE_LABEL[type] || type;
  if (ok) {
    card._state.status = "ok";
    card.classList.add("action-card--ok", "action-card--collapsed");
    badge.classList.add("action-badge--ok");
    badge.textContent = "✓ " + label;
    card.querySelector(".action-cancel")?.classList.add("is-hidden");
  } else {
    card._state.status = "error"; // 失败仍可重试(未被 executeAll 过滤排除)
    card.classList.add("action-card--error");
    badge.classList.add("action-badge--error");
    badge.textContent = "✗ " + label;
    if (errorMsg) {
      const body = card.querySelector(".action-body");
      const old = body && body.querySelector(".action-error-msg");
      if (old) old.remove(); // 重试时去掉旧错误条,避免叠加
      if (body) {
        const errEl = document.createElement("div");
        errEl.className = "taskref-warn action-error-msg";
        errEl.textContent = "失败:" + errorMsg;
        body.appendChild(errEl);
      }
    }
  }
}

/** 把保存的 payload(用户编辑后的值)写回 action,使重新渲染时表单初始即为编辑值。 */
function mergePayloadIntoAction(action, payload) {
  if (!payload) return;
  switch (payload.type) {
    case "create":
    case "create_project":
      Object.assign(action, payload);
      break;
    case "update":
    case "update_project":
      action.fields = payload.fields;
      break;
    // complete / query 无表单值需回填
  }
}

/** 把单卡快照(状态/取消/目标选择)回放到已渲染的卡片上。 */
function applyCardSnapshot(card, snap) {
  if (!snap) return;
  const s = card._state;
  if (snap.cancelled) {
    s.cancelled = true;
    card.classList.add("action-card--cancelled");
    const chk = card.querySelector(".action-cancel input[type='checkbox']");
    if (chk) chk.checked = true;
  }
  const ptype = snap.payload && snap.payload.type;
  if (snap.status === "ok") {
    markCardExecuted(card, ptype, true);
  } else if (snap.status === "error") {
    markCardExecuted(card, ptype, false, snap.errorMsg);
  } else if (snap.status === "warn") {
    s.status = "warn";
  }
  // 回放 update/complete/update_project 的目标选择
  const selVal =
    snap.payload && (snap.payload.task_id || snap.payload.project_id);
  if (
    selVal &&
    (ptype === "update" || ptype === "complete" || ptype === "update_project")
  ) {
    const sel = card.querySelector(".taskref-select");
    if (sel) sel.value = String(selVal);
  }
}

/** 把当前计划 + 所有卡片状态(含 collect() 出的编辑值)写进 sessionStorage。 */
function savePlanSnapshot() {
  if (!currentPlan || !currentPlan.actions || !currentPlan.actions.length) return;
  const cards = document.querySelectorAll("#actions-list .action-card");
  const snaps = [];
  cards.forEach((c) => {
    const s = c._state || {};
    let errorMsg = null;
    if (s.status === "error") {
      const e = c.querySelector(".action-body .action-error-msg");
      if (e) errorMsg = e.textContent.replace(/^失败:/, "").trim();
    }
    snaps.push({
      status: s.status || "pending",
      cancelled: !!s.cancelled,
      payload: s.collect ? s.collect() : null,
      errorMsg,
    });
  });
  try {
    sessionStorage.setItem(
      PLAN_SNAPSHOT_KEY,
      JSON.stringify({
        plan: currentPlan,
        conversation,
        projectsCache,
        labelsCache,
        tasksIndexCache,
        cards: snaps,
      })
    );
  } catch {}
}

function clearPlanSnapshot() {
  try {
    sessionStorage.removeItem(PLAN_SNAPSHOT_KEY);
  } catch {}
}

/** 页面加载时若有快照,重建计划并回放每张卡的状态。返回是否恢复成功。 */
function restorePlanSnapshot() {
  let raw;
  try {
    raw = sessionStorage.getItem(PLAN_SNAPSHOT_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  let snap;
  try {
    snap = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!snap || !snap.plan || !Array.isArray(snap.plan.actions) || !snap.plan.actions.length) {
    return false;
  }
  const snaps = Array.isArray(snap.cards) ? snap.cards : [];
  // 先把编辑值写回 action,再渲染,表单初始即显示编辑后的值
  snap.plan.actions.forEach((a, i) => {
    if (snaps[i] && snaps[i].payload) mergePayloadIntoAction(a, snaps[i].payload);
  });
  _restoring = true;
  try {
    renderActionPlan({
      reason: snap.plan.reason || "",
      summary: snap.plan.summary || "",
      actions: snap.plan.actions,
      projects: snap.projectsCache || [],
      labels: snap.labelsCache || [],
      tasks_index: snap.tasksIndexCache || [],
    });
    conversation = Array.isArray(snap.conversation) ? snap.conversation : [];
    const cards = document.querySelectorAll("#actions-list .action-card");
    cards.forEach((c, i) => applyCardSnapshot(c, snaps[i]));
    updateExecuteCount();
  } finally {
    _restoring = false;
  }
  savePlanSnapshot(); // 用回放后的真实状态覆盖(渲染期间跳过了保存)
  setStatus("已恢复上次的计划(切换页面期间已保留)", "info");
  return true;
}

/* ============ 多轮:首次生成 / 继续优化 ============ */
async function suggest() {
  const text = $("desc").value.trim();
  if (!text) { setStatus("请先描述你想做什么", "error"); $("desc").focus(); return; }
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
  $("actions-section").hidden = true;
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
      renderActionPlan(doneData);
      // 把本版计划作为 assistant 消息存入对话,支持后续继续迭代
      conversation.push({
        role: "assistant",
        content: JSON.stringify({
          reason: doneData.reason,
          summary: doneData.summary,
          actions: doneData.actions,
        }),
      });
      setStatus("已生成计划,可全部执行或继续提出修改意见", "info");
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

/* ============ 全部执行 ============ */
/**
 * fetch 封装:仅对网络错误(TypeError)或 5xx 重试,4xx/401 不重试。
 * 注意:不应用于 /api/suggest(SSE 流,重试会重启整个生成)。
 */
async function fetchWithRetry(url, opts, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, opts);
      if (resp.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      return resp;
    } catch (e) {
      if (e instanceof TypeError && attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

async function executeAll() {
  if (!currentPlan || !currentPlan.actions.length) return;
  // 收集所有可执行的动作(排除被取消 / warn 状态 / 已成功 ok)
  const cards = document.querySelectorAll("#actions-list .action-card");
  const toExecute = [];
  cards.forEach((c, i) => {
    if (c._state.cancelled) return;
    if (c._state.status === "warn") return;
    if (c._state.status === "ok") return; // 已成功,不重跑
    const payload = c._state.collect ? c._state.collect() : null;
    if (!payload) return;
    toExecute.push({ index: i, card: c, payload });
  });

  if (toExecute.length === 0) {
    setStatus("没有可执行的动作(可能全部被取消、匹配失败或已成功)", "error");
    return;
  }

  $("btn-execute").disabled = true;
  setStatus("正在执行…", "info");
  try {
    const resp = await fetchWithRetry("/api/execute-actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actions: toExecute.map((x) => x.payload) }),
    }, 1);
    if (resp.status === 401) { window.location.href = "/login"; return; }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(fmtApiError(resp.status, data));

    // 按 index 对齐结果
    const results = data.results || [];
    let okCount = 0, failCount = 0;
    for (const item of toExecute) {
      const r = results.find((x) => x.index === item.index);
      const card = item.card;
      if (r && r.ok) {
        markCardExecuted(card, item.payload.type, true);
        okCount++;
      } else {
        markCardExecuted(card, item.payload.type, false, (r && r.error) || "未知错误");
        failCount++;
      }
    }

    if (failCount === 0) {
      const links = results
        .map((r) => r.task_url)
        .filter(Boolean)
        .map((u) => `<a href="${esc(u)}" target="_blank">在 Vikunja 查看 →</a>`);
      const linkHtml = links.length ? " " + links.join(" · ") : "";
      setStatus("", "success", "✅ 全部执行成功(" + okCount + " 条)" + linkHtml);
      // 执行成功后清空对话(对齐旧行为)
      conversation = [];
      $("desc").value = "";
      $("desc").focus();
    } else {
      setStatus(`执行完成:成功 ${okCount} 条,失败 ${failCount} 条。失败的可展开查看错误,修正后再试。`, "error");
    }
    updateExecuteCount();
    savePlanSnapshot(); // 持久化执行结果,切页后仍可见
  } catch (e) {
    setStatus("执行失败:" + e.message, "error");
  } finally {
    $("btn-execute").disabled = false;
  }
}

/* ============ 取消全部 ============ */
function cancelAll() {
  conversation = [];
  currentPlan = null;
  $("actions-section").hidden = true;
  setStatus("", "");
  clearPlanSnapshot();
}

document.addEventListener("DOMContentLoaded", () => {
  renderHistory();
  $("btn-suggest").addEventListener("click", suggest);
  $("btn-execute").addEventListener("click", executeAll);
  $("btn-cancel").addEventListener("click", cancelAll);
  $("btn-refine").addEventListener("click", refine);
  $("desc").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") suggest();
  });
  $("refine-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") refine();
  });

  // 表单编辑时防抖保存快照(捕获字段修改,切页不丢)
  let _saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(savePlanSnapshot, 400);
  };
  $("actions-list").addEventListener("input", scheduleSave);
  $("actions-list").addEventListener("change", scheduleSave);

  // 恢复上次未完成的计划(跨页面持久化)
  restorePlanSnapshot();
});
