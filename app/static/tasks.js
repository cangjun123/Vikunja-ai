/* ===== 任务看板 —— 4 视图(Phase 1 只读)=====
 * 数据:`fetch('/api/tasks')` 一次拉完,内存共享,视图切换不重复请求。
 * 路由:hash(#list/#board/#calendar/#tree)切换视图,支持刷新保位置、后退。
 */
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const VIEWS = ["list", "board", "calendar", "tree"];

let dataset = null; // { tasks, projects, labels }
let projectMap = new Map(); // id -> project
let childrenMap = new Map(); // parentId -> [子 project]
let labelMap = new Map(); // id -> label
let currentView = null;
let boardGroupMode = "status"; // status | project
let calCursor = null; // Date,当前月份

/* ============ 工具函数 ============ */
function normDate(iso) {
  // Vikunja 未设时间返回 "0001-01-01T00:00:00Z"(Go 零值),视为 null
  if (!iso || typeof iso !== "string") return null;
  if (iso.startsWith("0001-01-01")) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return iso;
}
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function fmtRelative(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((target - today) / 86400000);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === -1) return "昨天";
  if (diff > 1 && diff <= 7) return `${diff} 天后`;
  if (diff < -1 && diff >= -7) return `${-diff} 天前`;
  return fmtDate(iso);
}
function priorityClass(p) {
  // 0 无; 1-2 低; 3 中; 4-5 高
  if (p >= 5) return "prio-urgent";
  if (p >= 4) return "prio-high";
  if (p >= 3) return "prio-mid";
  if (p >= 1) return "prio-low";
  return "prio-none";
}
function priorityLabel(p) {
  return ["无", "低", "较低", "中", "较高", "紧急"][p] || "无";
}
function safeColor(hex) {
  // Vikunja hex_color 形如 "" 或 "#abcdef"
  if (!hex) return "var(--muted)";
  if (hex.startsWith("#")) return hex;
  return "#" + hex;
}
function getProject(id) {
  return projectMap.get(id) || null;
}
function projectTitle(id) {
  const p = getProject(id);
  return p ? p.title : "(未知项目)";
}
function projectColor(id) {
  const p = getProject(id);
  return p && p.hex_color ? safeColor(p.hex_color) : "var(--muted)";
}
function taskLabels(task) {
  if (!task.labels) return [];
  return task.labels.map((l) => (typeof l === "object" ? l : labelMap.get(l) || { title: String(l) }));
}

/* ============ 筛选 / 排序 ============ */
function collectFilters() {
  const proj = $("filter-project").value;
  const status = $("filter-status").value;
  const sortBy = $("sort-by").value;
  return { proj: proj ? Number(proj) : null, status, sortBy };
}
function applyFilters(tasks) {
  const { proj, status } = collectFilters();
  return tasks.filter((t) => {
    if (proj && t.project_id !== proj) return false;
    if (status === "open" && t.done) return false;
    if (status === "done" && !t.done) return false;
    return true;
  });
}
function sortTasks(tasks) {
  const { sortBy } = collectFilters();
  const arr = tasks.slice();
  arr.sort((a, b) => {
    if (sortBy === "priority") return (b.priority || 0) - (a.priority || 0);
    if (sortBy === "title") return (a.title || "").localeCompare(b.title || "", "zh");
    if (sortBy === "project") {
      return (projectTitle(a.project_id)).localeCompare(projectTitle(b.project_id), "zh");
    }
    // due:有日期优先,空日期排到最后
    const ad = a.due_date ? new Date(a.due_date).getTime() : Infinity;
    const bd = b.due_date ? new Date(b.due_date).getTime() : Infinity;
    if (ad !== bd) return ad - bd;
    return (b.priority || 0) - (a.priority || 0);
  });
  return arr;
}
function filteredTasks() {
  if (!dataset) return [];
  return sortTasks(applyFilters(dataset.tasks));
}

/* ============ 视图渲染:列表 ============ */
function renderList() {
  const container = $("view-container");
  const tasks = filteredTasks();
  if (!tasks.length) {
    container.innerHTML = '<div class="card empty">没有符合筛选条件的任务</div>';
    return;
  }
  const rows = tasks
    .map((t) => {
      const doneCls = t.done ? "task-done" : "";
      const check = t.done ? "✓" : "";
      const labels = taskLabels(t)
        .map(
          (l) =>
            `<span class="mini-tag">${esc(l.title)}</span>`
        )
        .join("");
      const due = t.due_date
        ? `<span class="cell-due overdue-${isOverdue(t)}">${esc(fmtRelative(t.due_date))}</span>`
        : '<span class="cell-due muted">—</span>';
      const pri = t.priority
        ? `<span class="prio-badge ${priorityClass(t.priority)}">P${t.priority}</span>`
        : '<span class="muted">—</span>';
      return `
        <div class="task-row ${doneCls}">
          <span class="cell-check">${check}</span>
          <span class="cell-dot" style="background:${projectColor(t.project_id)}"></span>
          <span class="cell-title">${esc(t.title)}</span>
          <span class="cell-proj">${esc(projectTitle(t.project_id))}</span>
          <span class="cell-prio">${pri}</span>
          <span class="cell-labels">${labels}</span>
          <span class="cell-due-wrap">${due}</span>
        </div>`;
    })
    .join("");
  container.innerHTML = `
    <div class="card list-card">
      <div class="list-header">
        <span class="cell-check"></span>
        <span class="cell-dot"></span>
        <span class="cell-title">标题</span>
        <span class="cell-proj">项目</span>
        <span class="cell-prio">优先级</span>
        <span class="cell-labels">标签</span>
        <span class="cell-due-wrap">截止</span>
      </div>
      ${rows}
    </div>`;
}
function isOverdue(t) {
  if (!t.due_date || t.done) return "0";
  const d = new Date(t.due_date);
  if (isNaN(d.getTime())) return "0";
  return d.getTime() < Date.now() ? "1" : "0";
}

/* ============ 视图渲染:看板 ============ */
function renderBoard() {
  const container = $("view-container");
  const tasks = filteredTasks();
  let columns;
  if (boardGroupMode === "project") {
    const groups = new Map();
    for (const t of tasks) {
      if (!groups.has(t.project_id)) groups.set(t.project_id, []);
      groups.get(t.project_id).push(t);
    }
    columns = [...groups.entries()].map(([pid, ts]) => ({
      key: "p" + pid,
      title: projectTitle(pid),
      color: projectColor(pid),
      tasks: ts,
    }));
    columns.sort((a, b) => a.title.localeCompare(b.title, "zh"));
  } else {
    const open = tasks.filter((t) => !t.done);
    const done = tasks.filter((t) => t.done);
    columns = [
      { key: "open", title: "待办", color: "var(--primary)", tasks: open },
      { key: "done", title: "已完成", color: "var(--success)", tasks: done },
    ];
  }
  if (!columns.length || !tasks.length) {
    container.innerHTML = '<div class="card empty">没有符合筛选条件的任务</div>';
    return;
  }
  const colsHtml = columns
    .map((col) => {
      const cards = col.tasks.map((t) => renderBoardCard(t)).join("");
      return `
        <div class="board-col">
          <div class="board-col-head">
            <span class="board-dot" style="background:${col.color}"></span>
            <span class="board-col-title">${esc(col.title)}</span>
            <span class="board-count">${col.tasks.length}</span>
          </div>
          <div class="board-col-body">${cards || '<div class="board-empty">空</div>'}</div>
        </div>`;
    })
    .join("");
  const modeLabel = boardGroupMode === "project" ? "按项目分组" : "按状态分组";
  container.innerHTML = `
    <div class="board-meta">
      <button id="board-toggle" class="btn btn-ghost btn-tiny">${modeLabel} · 点击切换</button>
    </div>
    <div class="board-scroll">
      <div class="board">${colsHtml}</div>
    </div>`;
  $("board-toggle").addEventListener("click", () => {
    boardGroupMode = boardGroupMode === "status" ? "project" : "status";
    renderBoard();
  });
}
function renderBoardCard(t) {
  const priBar = t.priority
    ? `<span class="card-prio-bar ${priorityClass(t.priority)}"></span>`
    : "";
  const due = t.due_date
    ? `<span class="card-due overdue-${isOverdue(t)}">⏰ ${esc(fmtRelative(t.due_date))}</span>`
    : "";
  const labels = taskLabels(t)
    .map((l) => `<span class="mini-tag">${esc(l.title)}</span>`)
    .join("");
  return `
    <div class="board-card ${t.done ? "task-done" : ""}">
      ${priBar}
      <div class="card-title">${esc(t.title)}</div>
      <div class="card-meta">
        <span class="card-proj">
          <span class="cell-dot" style="background:${projectColor(t.project_id)}"></span>
          ${esc(projectTitle(t.project_id))}
        </span>
        ${due}
      </div>
      ${labels ? `<div class="card-labels">${labels}</div>` : ""}
    </div>`;
}

/* ============ 视图渲染:日历 ============ */
function renderCalendar() {
  const container = $("view-container");
  const tasks = filteredTasks();
  if (!calCursor) calCursor = new Date();
  const year = calCursor.getFullYear();
  const month = calCursor.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  // 周一为首(0=周一):JS getDay 周日是 0,转一下
  const leadGap = (firstDay.getDay() + 6) % 7;
  const daysInMonth = lastDay.getDate();
  // 把任务按日期归桶
  const byDay = new Map(); // 'YYYY-MM-DD' -> [task]
  const unsched = [];
  for (const t of tasks) {
    if (!t.due_date) {
      unsched.push(t);
      continue;
    }
    const d = new Date(t.due_date);
    if (isNaN(d.getTime())) {
      unsched.push(t);
      continue;
    }
    const key = fmtDate(t.due_date);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(t);
  }
  const todayKey = fmtDate(new Date().toISOString());
  // 渲染日历网格(可能补尾若干天下一行)
  const cells = [];
  for (let i = 0; i < leadGap; i++) cells.push('<div class="cal-cell cal-empty"></div>');
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dayTasks = byDay.get(key) || [];
    const isToday = key === todayKey;
    const dots = dayTasks
      .slice(0, 4)
      .map(
        (t) =>
          `<span class="cal-dot ${t.done ? "done" : ""}" style="background:${projectColor(
            t.project_id
          )}" title="${esc(t.title)}"></span>`
      )
      .join("");
    const more =
      dayTasks.length > 4 ? `<span class="cal-more">+${dayTasks.length - 4}</span>` : "";
    cells.push(`
      <div class="cal-cell${isToday ? " cal-today" : ""}" data-date="${key}">
        <div class="cal-date">${d}</div>
        <div class="cal-dots">${dots}${more}</div>
      </div>`);
  }
  // 补齐到 7 的倍数
  while (cells.length % 7 !== 0) cells.push('<div class="cal-cell cal-empty"></div>');

  const monthLabel = `${year} 年 ${month + 1} 月`;
  const weekdayHtml = ["一", "二", "三", "四", "五", "六", "日"]
    .map((w) => `<div class="cal-weekday">${w}</div>`)
    .join("");
  const unschedHtml = unsched.length
    ? `<div class="card">
         <div class="card-head"><h2>未排期 · ${unsched.length}</h2></div>
         <div class="unsched-list">
           ${unsched
             .map(
               (t) =>
                 `<div class="unsched-item ${t.done ? "task-done" : ""}">
                    <span class="cell-dot" style="background:${projectColor(t.project_id)}"></span>
                    <span class="unsched-title">${esc(t.title)}</span>
                    <span class="unsched-proj">${esc(projectTitle(t.project_id))}</span>
                  </div>`
             )
             .join("")}
         </div>
       </div>`
    : "";
  container.innerHTML = `
    <div class="card cal-card">
      <div class="cal-head">
        <button id="cal-prev" class="btn-icon" aria-label="上个月">‹</button>
        <span class="cal-month">${monthLabel}</span>
        <button id="cal-next" class="btn-icon" aria-label="下个月">›</button>
        <button id="cal-today" class="btn btn-ghost btn-tiny">今天</button>
      </div>
      <div class="cal-weekdays">${weekdayHtml}</div>
      <div class="cal-grid">${cells.join("")}</div>
    </div>
    <div id="cal-day-detail" class="card" hidden>
      <div class="card-head">
        <h2 id="cal-day-title">当日任务</h2>
        <button id="cal-day-close" class="btn-icon" aria-label="关闭">✕</button>
      </div>
      <div id="cal-day-list"></div>
    </div>
    ${unschedHtml}`;
  $("cal-prev").addEventListener("click", () => {
    calCursor = new Date(year, month - 1, 1);
    renderCalendar();
  });
  $("cal-next").addEventListener("click", () => {
    calCursor = new Date(year, month + 1, 1);
    renderCalendar();
  });
  $("cal-today").addEventListener("click", () => {
    calCursor = new Date();
    renderCalendar();
  });
  $("cal-day-close").addEventListener("click", () => {
    $("cal-day-detail").hidden = true;
  });
  container.querySelectorAll(".cal-cell[data-date]").forEach((cell) => {
    cell.addEventListener("click", () => showDay(cell.dataset.date, byDay));
  });
}
function showDay(key, byDay) {
  const list = byDay.get(key) || [];
  const box = $("cal-day-detail");
  $("cal-day-title").textContent = `${key} · ${list.length} 项`;
  $("cal-day-list").innerHTML = list.length
    ? list
        .map(
          (t) =>
            `<div class="day-item ${t.done ? "task-done" : ""}">
               <span class="cell-dot" style="background:${projectColor(t.project_id)}"></span>
               <span class="day-title">${esc(t.title)}</span>
               <span class="day-proj">${esc(projectTitle(t.project_id))}</span>
               ${
                 t.priority
                   ? `<span class="prio-badge ${priorityClass(t.priority)}">P${t.priority}</span>`
                   : ""
               }
             </div>`
        )
        .join("")
    : '<div class="empty">当天无任务</div>';
  box.hidden = false;
}

/* ============ 视图渲染:树 ============ */
function renderTree() {
  const container = $("view-container");
  // 树视图自己处理筛选(但应用 status 筛选;项目筛选在树上意义不大,仍生效:只高亮该分支)
  const { status, proj } = collectFilters();
  // 1. 计算每个项目下的任务
  const tasksByProject = new Map();
  for (const t of dataset.tasks) {
    if (status === "open" && t.done) continue;
    if (status === "done" && !t.done) continue;
    if (!tasksByProject.has(t.project_id)) tasksByProject.set(t.project_id, []);
    tasksByProject.get(t.project_id).push(t);
  }
  // 2. 从顶层项目(parent=0)递归
  const roots = (childrenMap.get(0) || []).slice().sort(sortProjects);
  const html = roots
    .map((p) => renderTreeNode(p, tasksByProject, proj, 0))
    .join("");
  container.innerHTML = `
    <div class="card tree-card">
      ${html || '<div class="empty">暂无项目</div>'}
    </div>`;
}
function sortProjects(a, b) {
  // 收藏置顶,然后按 position,再按 title
  if (a.is_favorite !== b.is_favorite) return a.is_favorite ? -1 : 1;
  if ((a.position || 0) !== (b.position || 0)) return (a.position || 0) - (b.position || 0);
  return a.title.localeCompare(b.title, "zh");
}
function renderTreeNode(project, tasksByProject, filterProj, depth) {
  const children = (childrenMap.get(project.id) || []).slice().sort(sortProjects);
  const tasks = (tasksByProject.get(project.id) || []).slice().sort((a, b) => {
    // 未完成优先;再按截止
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    const ad = a.due_date ? new Date(a.due_date).getTime() : Infinity;
    const bd = b.due_date ? new Date(b.due_date).getTime() : Infinity;
    return ad - bd;
  });
  const totalDone = tasks.filter((t) => t.done).length;
  const badge = `<span class="tree-badge">${totalDone}/${tasks.length}</span>`;
  const favorite = project.is_favorite ? '<span class="tree-star">★</span>' : "";
  const projRow = `
    <div class="tree-row tree-proj" style="--depth:${depth}" data-pid="${project.id}">
      <span class="tree-toggle" data-pid="${project.id}">▾</span>
      <span class="cell-dot" style="background:${safeColor(project.hex_color)}"></span>
      <span class="tree-label">${esc(project.title)}</span>
      ${favorite}
      ${badge}
    </div>`;
  const childrenHtml = children
    .map((c) => renderTreeNode(c, tasksByProject, filterProj, depth + 1))
    .join("");
  const tasksHtml = tasks
    .map((t) => {
      const due = t.due_date ? fmtRelative(t.due_date) : "";
      return `
        <div class="tree-row tree-task ${t.done ? "task-done" : ""}" style="--depth:${depth + 1}">
          <span class="tree-check">${t.done ? "✓" : "○"}</span>
          <span class="tree-task-title">${esc(t.title)}</span>
          ${
            t.priority
              ? `<span class="prio-badge ${priorityClass(t.priority)}">P${t.priority}</span>`
              : ""
          }
          ${due ? `<span class="tree-due">⏰ ${esc(due)}</span>` : ""}
        </div>`;
    })
    .join("");
  // 整个分支可折叠
  return `
    <div class="tree-branch" data-pid="${project.id}">
      ${projRow}
      <div class="tree-children">
        ${childrenHtml}${tasksHtml}
      </div>
    </div>`;
}

/* ============ 路由 ============ */
function renderCurrent() {
  if (!dataset) return;
  const view = currentView;
  $("view-container").innerHTML = "";
  if (view === "list") renderList();
  else if (view === "board") renderBoard();
  else if (view === "calendar") renderCalendar();
  else if (view === "tree") renderTree();
  // tab 高亮
  document.querySelectorAll(".tab").forEach((a) => {
    a.classList.toggle("active", a.dataset.view === view);
  });
}
function routeFromHash() {
  let h = (location.hash || "").replace(/^#/, "");
  if (!VIEWS.includes(h)) h = "list";
  if (currentView !== h) {
    currentView = h;
    if (h === "calendar") calCursor = null; // 切到日历时重置为当月
  }
  renderCurrent();
}

/* ============ 数据加载 ============ */
function showError(msg) {
  $("err-box").hidden = false;
  $("err-box").textContent = msg;
  $("loading").hidden = true;
}
function populateProjectFilter() {
  const sel = $("filter-project");
  const current = sel.value;
  // 按层级缩进展示
  const opts = ['<option value="">所有项目</option>'];
  const walk = (parent, depth) => {
    const children = (childrenMap.get(parent) || []).slice().sort(sortProjects);
    for (const p of children) {
      const indent = "  ".repeat(depth) + (depth ? "└ " : "");
      opts.push(`<option value="${p.id}">${esc(indent + p.title)}</option>`);
      walk(p.id, depth + 1);
    }
  };
  walk(0, 0);
  sel.innerHTML = opts.join("");
  sel.value = current;
}
async function load() {
  try {
    const resp = await fetch("/api/tasks");
    if (resp.status === 401) {
      location.href = "/login";
      return;
    }
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      showError(data.detail || `加载失败 (${resp.status})`);
      return;
    }
    dataset = await resp.json();
    // 规范化日期:Vikunja 对未设字段返回 Go 零值 "0001-01-01T00:00:00Z",
    // new Date() 会把它解析成公元 1 年的有效日期,统一改成 null。
    for (const t of dataset.tasks) {
      t.due_date = normDate(t.due_date);
      t.start_date = normDate(t.start_date);
      if (t.done_at && t.done_at.startsWith("0001-01-01")) t.done_at = null;
    }
    // 构索引
    projectMap = new Map();
    childrenMap = new Map();
    labelMap = new Map();
    for (const p of dataset.projects) {
      projectMap.set(p.id, p);
      const pid = p.parent_project_id || 0;
      if (!childrenMap.has(pid)) childrenMap.set(pid, []);
      childrenMap.get(pid).push(p);
    }
    for (const l of dataset.labels) labelMap.set(l.id, l);
    populateProjectFilter();
    $("loading").hidden = true;
    routeFromHash();
  } catch (e) {
    showError("网络错误:" + e.message);
  }
}

/* ============ 事件绑定 ============ */
window.addEventListener("hashchange", routeFromHash);
window.addEventListener("DOMContentLoaded", () => {
  $("filter-project").addEventListener("change", renderCurrent);
  $("filter-status").addEventListener("change", renderCurrent);
  $("sort-by").addEventListener("change", renderCurrent);
  $("btn-refresh").addEventListener("click", () => {
    dataset = null;
    $("loading").hidden = false;
    $("err-box").hidden = true;
    load();
  });
  // 树形折叠(事件委托)
  document.addEventListener("click", (e) => {
    const tog = e.target.closest(".tree-toggle");
    if (!tog) return;
    const branch = tog.closest(".tree-branch");
    if (!branch) return;
    const collapsed = branch.classList.toggle("collapsed");
    tog.textContent = collapsed ? "▸" : "▾";
  });
  load();
});
