/* ===== 任务看板 —— 4 视图 + 编辑(Phase 2)=====
 * 数据:`fetch('/api/tasks')` 一次拉完,内存共享,视图切换不重复请求。
 * 路由:hash(#list/#board/#calendar/#tree)切换视图,支持刷新保位置、后退。
 * 编辑:勾选完成 / 看板拖拽 / 点卡片改字段 / 新建 / 删除,全部乐观更新。
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
function applyFilters(tasks, opts = {}) {
  const { ignoreStatus = false } = opts;
  const { proj, status } = collectFilters();
  const showArchived = $("filter-archived") && $("filter-archived").checked;
  return tasks.filter((t) => {
    if (proj && t.project_id !== proj) return false;
    if (!ignoreStatus) {
      if (status === "open" && t.done) return false;
      if (status === "done" && !t.done) return false;
    }
    if (!showArchived) {
      const p = getProject(t.project_id);
      if (p && p.is_archived) return false;
    }
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
function filteredTasks(opts = {}) {
  if (!dataset) return [];
  return sortTasks(applyFilters(dataset.tasks, opts));
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
        <div class="task-row ${doneCls}" data-tid="${t.id}">
          <button class="cell-check" data-act="toggle-done" title="切换完成">${check}</button>
          <span class="cell-dot" style="background:${projectColor(t.project_id)}"></span>
          <span class="cell-title">${repeatIcon(t)}${esc(t.title)}</span>
          <span class="cell-proj">${esc(projectTitle(t.project_id))}</span>
          <span class="cell-labels">${labels}</span>
          <span class="cell-right">
            <span class="cell-prio">${pri}</span>
            <span class="cell-due-wrap">${due}</span>
          </span>
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
  // 状态分组模式下,两列本身就是状态,再走状态筛选会把一列筛空 → 忽略它
  const isStatusMode = boardGroupMode === "status";
  const tasks = filteredTasks({ ignoreStatus: isStatusMode });
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
      const intent =
        col.key === "open" ? "open" : col.key === "done" ? "done" : "p:" + col.key.slice(1);
      return `
        <div class="board-col" data-intent="${intent}">
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
  const hint = isStatusMode
    ? "💡 拖卡片切完成状态 · 点卡片编辑 · 此模式下忽略「状态」筛选"
    : "💡 拖卡片换项目 · 点卡片编辑";
  container.innerHTML = `
    <div class="board-meta">
      <button id="board-toggle" class="btn btn-ghost btn-tiny">${modeLabel} · 点击切换</button>
      <span class="board-hint">${hint}</span>
    </div>
    <div class="board-scroll">
      <div class="board">${colsHtml}</div>
    </div>`;
  $("board-toggle").addEventListener("click", () => {
    boardGroupMode = boardGroupMode === "status" ? "project" : "status";
    renderBoard();
  });
  setupBoardDnD();
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
    <div class="board-card ${t.done ? "task-done" : ""}" draggable="true" data-tid="${t.id}">
      ${priBar}
      <div class="card-title">${repeatIcon(t)}${esc(t.title)}</div>
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
                 `<div class="unsched-item ${t.done ? "task-done" : ""}" data-tid="${t.id}">
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
            `<div class="day-item ${t.done ? "task-done" : ""}" data-tid="${t.id}">
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
      <div class="tree-toolbar">
        <button class="btn btn-ghost btn-tiny" data-act="new-project-top">+ 项目</button>
      </div>
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
  const archivedBadge = project.is_archived
    ? '<span class="archived-badge">已归档</span>'
    : "";
  const projRow = `
    <div class="tree-row tree-proj ${project.is_archived ? "is-archived" : ""}" style="--depth:${depth}" data-pid="${project.id}">
      <span class="tree-toggle" data-pid="${project.id}">▾</span>
      <span class="cell-dot" style="background:${safeColor(project.hex_color)}"></span>
      <span class="tree-label">${esc(project.title)}</span>
      ${archivedBadge}
      ${favorite}
      ${badge}
      <button class="tree-edit" data-act="edit-project" data-pid="${project.id}" title="编辑项目">✎</button>
      <button class="tree-add" data-act="new-in-project" data-pid="${project.id}" title="在此项目新建">＋</button>
    </div>`;
  const childrenHtml = children
    .map((c) => renderTreeNode(c, tasksByProject, filterProj, depth + 1))
    .join("");
  const tasksHtml = tasks
    .map((t) => {
      const due = t.due_date ? fmtRelative(t.due_date) : "";
      return `
        <div class="tree-row tree-task ${t.done ? "task-done" : ""}" style="--depth:${depth + 1}" data-tid="${t.id}">
          <button class="tree-check" data-act="toggle-done" title="切换完成">${t.done ? "✓" : "○"}</button>
          <span class="tree-task-title">${repeatIcon(t)}${esc(t.title)}</span>
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
let pendingScrollTid = null; // deep link #task-{id} 待滚动+高亮的任务 id
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
  const taskMatch = h.match(/^task-(\d+)$/);
  if (taskMatch) {
    pendingScrollTid = parseInt(taskMatch[1], 10);
    h = "list"; // 任务定位强制走 list 视图
  }
  if (!VIEWS.includes(h)) h = "list";
  if (currentView !== h) {
    currentView = h;
    if (h === "calendar") calCursor = null; // 切到日历时重置为当月
  }
  renderCurrent();
  // 渲染完成后处理 deep link 滚动 + 高亮
  if (pendingScrollTid !== null) {
    const tid = pendingScrollTid;
    pendingScrollTid = null;
    requestAnimationFrame(() => {
      const row = document.querySelector(`[data-tid="${tid}"]`);
      if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.classList.add("task-highlight");
        setTimeout(() => row.classList.remove("task-highlight"), 2000);
      }
    });
  }
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
      const suffix = p.is_archived ? " (已归档)" : "";
      opts.push(`<option value="${p.id}">${esc(indent + p.title + suffix)}</option>`);
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

/* ============ 编辑:本地状态 + API ============ */
let editingTaskId = null; // 非 null = 编辑此 id;null = 新建
let flashTimer = null;

function getTaskById(id) {
  return dataset.tasks.find((t) => t.id === id) || null;
}
function normalizeTaskDates(t) {
  t.due_date = normDate(t.due_date);
  t.start_date = normDate(t.start_date);
  if (t.done_at && String(t.done_at).startsWith("0001-01-01")) t.done_at = null;
  return t;
}
function flash(msg, type = "error") {
  const box = $("err-box");
  box.textContent = msg;
  box.className = "status " + type;
  box.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    box.hidden = true;
  }, type === "error" ? 5000 : 2000);
}
async function patchTask(taskId, fields) {
  const t = getTaskById(taskId);
  if (!t) return;
  // 乐观更新
  Object.assign(t, fields);
  if ("due_date" in fields) t.due_date = fields.due_date || null;
  if ("labels" in fields) {
    // 后端会同步标签,但本地需立即显示。把字符串标题转成伪 label 对象。
    t.labels = (fields.labels || []).map((title) => ({ title }));
  }
  renderCurrent();
  try {
    const resp = await fetch(`/api/tasks/${taskId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    if (resp.status === 401) { location.href = "/login"; return; }
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(e.detail || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (data.task) {
      // Vikunja 更新端点对未设/未查字段返回 null(比如 labels)。
      // 只用非空字段覆盖,避免把乐观更新抹掉。
      const cleaned = {};
      for (const [k, v] of Object.entries(data.task)) {
        if (v !== null && v !== undefined) cleaned[k] = v;
      }
      Object.assign(t, normalizeTaskDates(cleaned));
      renderCurrent();
    }
  } catch (e) {
    flash(`保存失败:${e.message},正在重新加载`);
    await load();
  }
}
async function deleteTaskById(taskId) {
  if (!confirm("确认删除此任务?此操作不可撤销。")) return;
  dataset.tasks = dataset.tasks.filter((t) => t.id !== taskId);
  renderCurrent();
  closeModal();
  try {
    const resp = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
    if (resp.status === 401) { location.href = "/login"; return; }
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(e.detail || `HTTP ${resp.status}`);
    }
    flash("已删除", "info");
  } catch (e) {
    flash(`删除失败:${e.message},正在重新加载`);
    await load();
  }
}
async function createFromModal(payload) {
  try {
    const resp = await fetch("/api/create-task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (resp.status === 401) { location.href = "/login"; return; }
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(e.detail || `HTTP ${resp.status}`);
    }
    await load();
    flash("已创建", "info");
  } catch (e) {
    flash(`创建失败:${e.message}`);
  }
}

/* ============ 弹窗 ============ */
function populateModalProjectSelect() {
  const sel = $("m-project");
  const opts = [];
  const walk = (parent, depth) => {
    const children = (childrenMap.get(parent) || []).slice().sort(sortProjects);
    for (const p of children) {
      const indent = "  ".repeat(depth) + (depth ? "└ " : "");
      const suffix = p.is_archived ? " (已归档)" : "";
      opts.push(`<option value="${p.id}">${esc(indent + p.title + suffix)}</option>`);
      walk(p.id, depth + 1);
    }
  };
  walk(0, 0);
  sel.innerHTML = opts.join("");
}
function openEditModal(taskId) {
  const t = getTaskById(taskId);
  if (!t) return;
  editingTaskId = taskId;
  $("modal-title").textContent = "编辑任务";
  $("modal-delete").hidden = false;
  populateModalProjectSelect();
  $("m-title").value = t.title || "";
  $("m-project").value = String(t.project_id);
  $("m-due").value = t.due_date ? fmtDate(t.due_date) : "";
  $("m-priority").value = String(t.priority || 0);
  $("m-repeat").value = repeatToSelect(t.repeat_after || 0, t.repeat_mode || 0);
  $("m-labels").value = (t.labels || []).map((l) => l.title).join(", ");
  // description 在 Vikunja 是 HTML(markdown 渲染后的),这里简单去标签显示
  $("m-desc").value = stripHtml(t.description || "");
  showModal(false);
}
function openNewModal(defaultPid) {
  editingTaskId = null;
  $("modal-title").textContent = "新建任务";
  $("modal-delete").hidden = true;
  populateModalProjectSelect();
  $("m-title").value = "";
  const pids = [...projectMap.keys()];
  $("m-project").value = String(defaultPid || (pids.length ? pids[0] : ""));
  $("m-due").value = "";
  $("m-priority").value = "0";
  $("m-repeat").value = "none";
  $("m-labels").value = "";
  $("m-desc").value = "";
  showModal(true);
}
function showModal(autofocus = true) {
  $("modal-mask").hidden = false;
  if (autofocus) setTimeout(() => $("m-title").focus(), 30);
}
// 重复任务:repeat_after(秒) + repeat_mode(0=按秒,1=按月,2=从当前日期) ↔ select value
function repeatToSelect(after, mode) {
  if (mode === 1) return "monthly";
  if (!after) return "none";
  if (after === 86400) return "daily";
  if (after === 604800) return "weekly";
  if (after === 31536000) return "yearly";
  return "none"; // 自定义秒数回退到 none(后端原值不变更)
}
function selectToRepeat(value) {
  switch (value) {
    case "daily":   return { repeat_after: 86400, repeat_mode: 0 };
    case "weekly":  return { repeat_after: 604800, repeat_mode: 0 };
    case "monthly": return { repeat_after: 2592000, repeat_mode: 1 };
    case "yearly":  return { repeat_after: 31536000, repeat_mode: 0 };
    default:        return { repeat_after: 0, repeat_mode: 0 };
  }
}
function isRepeating(t) {
  return (t.repeat_after && t.repeat_after > 0) || (t.repeat_mode && t.repeat_mode !== 0);
}
function repeatIcon(t) {
  return isRepeating(t)
    ? `<span class="repeat-ico" title="重复:${repeatLabel(t)}">↻</span>`
    : "";
}
function repeatLabel(t) {
  const v = repeatToSelect(t.repeat_after || 0, t.repeat_mode || 0);
  return { daily: "每天", weekly: "每周", monthly: "每月", yearly: "每年" }[v] || "自定义";
}
function closeModal() {
  $("modal-mask").hidden = true;
  editingTaskId = null;
}
function stripHtml(s) {
  // 简易:去 <p>/<br> 之类的标签,保留文本
  return String(s || "").replace(/<[^>]+>/g, "").replace(/\s+$/g, "");
}
async function saveModal() {
  const title = $("m-title").value.trim();
  if (!title) { flash("标题不能为空"); $("m-title").focus(); return; }
  const pid = Number($("m-project").value);
  if (!pid) { flash("请选择项目"); return; }
  const due = $("m-due").value || null;
  const priority = Number($("m-priority").value);
  const repeat = selectToRepeat($("m-repeat").value);
  const labels = $("m-labels").value.split(",").map((s) => s.trim()).filter(Boolean);
  const description = $("m-desc").value;
  // 先捕获 id,closeModal() 会把 editingTaskId 清成 null
  const editingId = editingTaskId;
  closeModal();
  if (editingId) {
    await patchTask(editingId, {
      title,
      project_id: pid,
      due_date: due,
      priority,
      labels,
      description,
      ...repeat,
    });
  } else {
    await createFromModal({
      title,
      project_id: pid,
      due_date: due,
      priority,
      labels,
      description,
      checklist: [],
      ...repeat,
    });
  }
}

/* ============ 项目弹窗(Phase 3)============ */
let editingProjectId = null;
let _pmColor = "";

function setCurrentColor(c) {
  _pmColor = c || "";
  document.querySelectorAll("#pm-color-palette .color-swatch").forEach((b) => {
    b.classList.toggle("selected", b.dataset.color === _pmColor);
  });
  // 同步 color input 显示;非预设色也展示出来
  if (_pmColor && /^#[0-9a-fA-F]{6}$/.test(_pmColor)) {
    $("pm-color-custom").value = _pmColor;
  }
}
function getCurrentColor() { return _pmColor; }

function populateProjectParentSelect(excludeSubtreeId) {
  // 排除编辑项目自身及其所有后代,避免循环父子关系
  const sel = $("pm-parent");
  const excludeSet = new Set();
  if (excludeSubtreeId) {
    const collect = (pid) => {
      excludeSet.add(pid);
      for (const c of childrenMap.get(pid) || []) collect(c.id);
    };
    collect(excludeSubtreeId);
  }
  const opts = ['<option value="0">(顶层)</option>'];
  const walk = (parent, depth) => {
    const children = (childrenMap.get(parent) || []).slice().sort(sortProjects);
    for (const p of children) {
      if (excludeSet.has(p.id)) continue;
      const indent = "  ".repeat(depth) + (depth ? "└ " : "");
      const suffix = p.is_archived ? " (已归档)" : "";
      opts.push(`<option value="${p.id}">${esc(indent + p.title + suffix)}</option>`);
      walk(p.id, depth + 1);
    }
  };
  walk(0, 0);
  sel.innerHTML = opts.join("");
}

function openProjectModal(pid) {
  if (pid) {
    const p = getProject(pid);
    if (!p) return;
    editingProjectId = pid;
    $("proj-modal-title").textContent = "编辑项目";
    $("proj-modal-delete").hidden = false;
    $("proj-modal-add-sub").hidden = false;
    populateProjectParentSelect(pid);
    $("pm-title").value = p.title || "";
    $("pm-parent").value = String(p.parent_project_id || 0);
    $("pm-parent").disabled = false;
    $("pm-identifier").value = p.identifier || "";
    $("pm-favorite").checked = !!p.is_favorite;
    $("pm-archived").checked = !!p.is_archived;
    setCurrentColor(p.hex_color || "");
  } else {
    editingProjectId = null;
    $("proj-modal-title").textContent = "新建项目";
    $("proj-modal-delete").hidden = true;
    $("proj-modal-add-sub").hidden = true;
    populateProjectParentSelect(null);
    $("pm-title").value = "";
    $("pm-parent").value = "0";
    $("pm-parent").disabled = false;
    $("pm-identifier").value = "";
    $("pm-favorite").checked = false;
    $("pm-archived").checked = false;
    setCurrentColor("");
  }
  $("proj-modal-mask").hidden = false;
}

function openSubProjectModal(parentPid) {
  editingProjectId = null;
  $("proj-modal-title").textContent = "新建子项目";
  $("proj-modal-delete").hidden = true;
  $("proj-modal-add-sub").hidden = true;
  populateProjectParentSelect(null);
  $("pm-title").value = "";
  $("pm-parent").value = String(parentPid || 0);
  $("pm-parent").disabled = true; // 新建子项目时父项固定
  $("pm-identifier").value = "";
  $("pm-favorite").checked = false;
  $("pm-archived").checked = false;
  setCurrentColor("");
  $("proj-modal-mask").hidden = false;
}

function closeProjectModal() {
  $("proj-modal-mask").hidden = true;
  editingProjectId = null;
  $("pm-parent").disabled = false;
}

async function saveProjectModal() {
  const title = $("pm-title").value.trim();
  if (!title) { flash("项目标题不能为空"); $("pm-title").focus(); return; }
  const fields = {
    title,
    parent_project_id: Number($("pm-parent").value) || 0,
    hex_color: getCurrentColor(),
    is_favorite: $("pm-favorite").checked,
    is_archived: $("pm-archived").checked,
  };
  const identifier = $("pm-identifier").value.trim();
  if (identifier) fields.identifier = identifier;

  const editingId = editingProjectId;
  closeProjectModal();
  try {
    let resp;
    if (editingId) {
      resp = await fetch(`/api/projects/${editingId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
    } else {
      resp = await fetch("/api/projects", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
    }
    if (resp.status === 401) { location.href = "/login"; return; }
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(e.detail || `HTTP ${resp.status}`);
    }
    await load();
    flash(editingId ? "项目已更新" : "项目已创建", "info");
  } catch (e) {
    flash(`保存项目失败:${e.message}`);
  }
}

async function deleteProjectFromModal(pid) {
  if (!pid) return;
  const p = getProject(pid);
  const taskCount = dataset.tasks.filter((t) => t.project_id === pid).length;
  const msg = taskCount
    ? `此项目下有 ${taskCount} 个任务。确认删除项目"${p ? p.title : ""}"?Vikunja 可能级联删除或拒绝,操作不可撤销。`
    : `确认删除项目"${p ? p.title : ""}"?操作不可撤销。`;
  if (!confirm(msg)) return;
  closeProjectModal();
  try {
    const resp = await fetch(`/api/projects/${pid}`, { method: "DELETE" });
    if (resp.status === 401) { location.href = "/login"; return; }
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(e.detail || `HTTP ${resp.status}`);
    }
    await load();
    flash("项目已删除", "info");
  } catch (e) {
    flash(`删除项目失败:${e.message}`);
    await load();
  }
}

/* ============ 看板拖拽 ============ */
function setupBoardDnD() {
  const board = document.querySelector(".board");
  if (!board) return;
  let draggingTid = null;
  let draggingCard = null;
  board.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".board-card");
    if (!card) return;
    draggingTid = Number(card.dataset.tid);
    draggingCard = card;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    // Firefox 需要 setData 才能开始拖动
    try { e.dataTransfer.setData("text/plain", String(draggingTid)); } catch {}
  });
  board.addEventListener("dragend", () => {
    if (draggingCard) draggingCard.classList.remove("dragging");
    document
      .querySelectorAll(".board-col.drag-over")
      .forEach((c) => c.classList.remove("drag-over"));
    draggingTid = null;
    draggingCard = null;
  });
  board.addEventListener("dragover", (e) => {
    const col = e.target.closest(".board-col");
    if (!col) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".board-col.drag-over").forEach((c) => {
      if (c !== col) c.classList.remove("drag-over");
    });
    col.classList.add("drag-over");
  });
  board.addEventListener("dragleave", (e) => {
    const col = e.target.closest(".board-col");
    if (col && !col.contains(e.relatedTarget)) col.classList.remove("drag-over");
  });
  board.addEventListener("drop", (e) => {
    e.preventDefault();
    const col = e.target.closest(".board-col");
    if (!col || !draggingTid) return;
    col.classList.remove("drag-over");
    const intent = col.dataset.intent || "";
    const t = getTaskById(draggingTid);
    if (!t) return;
    if (intent === "open" && t.done) patchTask(t.id, { done: false });
    else if (intent === "done" && !t.done) patchTask(t.id, { done: true });
    else if (intent.startsWith("p:")) {
      const pid = Number(intent.slice(2));
      if (pid && t.project_id !== pid) patchTask(t.id, { project_id: pid });
    }
  });
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

  // 视图容器内的点击委托:勾选完成 / 新建 / 打开编辑
  $("view-container").addEventListener("click", (e) => {
    // 1. 勾选完成
    const check = e.target.closest('[data-act="toggle-done"]');
    if (check) {
      e.stopPropagation();
      const row = check.closest("[data-tid]");
      if (!row) return;
      const tid = Number(row.dataset.tid);
      const t = getTaskById(tid);
      if (t) patchTask(tid, { done: !t.done });
      return;
    }
    // 2. 树里点 + 新建任务
    const newBtn = e.target.closest('[data-act="new-in-project"]');
    if (newBtn) {
      e.stopPropagation();
      openNewModal(Number(newBtn.dataset.pid));
      return;
    }
    // 3. 树里点 ✎ 编辑项目
    const editProjBtn = e.target.closest('[data-act="edit-project"]');
    if (editProjBtn) {
      e.stopPropagation();
      openProjectModal(Number(editProjBtn.dataset.pid));
      return;
    }
    // 4. 树顶部「+ 项目」
    const newProjTop = e.target.closest('[data-act="new-project-top"]');
    if (newProjTop) {
      e.stopPropagation();
      openProjectModal(null);
      return;
    }
    // 5. 点任务行/卡片 → 编辑
    const item = e.target.closest("[data-tid]");
    if (item) openEditModal(Number(item.dataset.tid));
  });

  // 树形折叠(独立委托,不冲突)
  document.addEventListener("click", (e) => {
    const tog = e.target.closest(".tree-toggle");
    if (!tog) return;
    const branch = tog.closest(".tree-branch");
    if (!branch) return;
    const collapsed = branch.classList.toggle("collapsed");
    tog.textContent = collapsed ? "▸" : "▾";
  });

  // FAB + 弹窗
  $("btn-new-task").addEventListener("click", () => openNewModal());
  $("modal-close").addEventListener("click", closeModal);
  $("modal-cancel").addEventListener("click", closeModal);
  $("modal-save").addEventListener("click", saveModal);
  $("modal-delete").addEventListener("click", () => {
    if (editingTaskId) deleteTaskById(editingTaskId);
  });
  $("modal-mask").addEventListener("click", (e) => {
    if (e.target === $("modal-mask")) closeModal();
  });
  $("m-title").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveModal(); }
  });

  // 归档筛选
  const archivedFilter = $("filter-archived");
  if (archivedFilter) archivedFilter.addEventListener("change", renderCurrent);

  // 项目弹窗
  $("proj-modal-close").addEventListener("click", closeProjectModal);
  $("proj-modal-cancel").addEventListener("click", closeProjectModal);
  $("proj-modal-save").addEventListener("click", saveProjectModal);
  $("proj-modal-delete").addEventListener("click", () => {
    if (editingProjectId) deleteProjectFromModal(editingProjectId);
  });
  $("proj-modal-add-sub").addEventListener("click", () => {
    if (editingProjectId) {
      const pid = editingProjectId;
      closeProjectModal();
      openSubProjectModal(pid);
    }
  });
  $("proj-modal-mask").addEventListener("click", (e) => {
    if (e.target === $("proj-modal-mask")) closeProjectModal();
  });
  $("pm-color-palette").addEventListener("click", (e) => {
    const sw = e.target.closest(".color-swatch");
    if (!sw) return;
    setCurrentColor(sw.dataset.color || "");
  });
  $("pm-color-custom").addEventListener("input", (e) => {
    setCurrentColor(e.target.value);
  });
  $("pm-title").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveProjectModal(); }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("proj-modal-mask").hidden) closeProjectModal();
      else if (!$("modal-mask").hidden) closeModal();
    }
  });

  load();
});
