const state = {
  projects: [],
  activeProjectId: "",
  projectQuery: "",
};

const hiddenProjectNames = new Set(["$recycle.bin", "system volume information"]);

const bodyEl = document.body;
const scrimEl = document.querySelector("#sheet-scrim");
const projectSheetEl = document.querySelector("#project-sheet");
const infoSheetEl = document.querySelector("#info-sheet");
const projectListEl = document.querySelector("#project-list");
const projectCountTextEl = document.querySelector("#project-count-text");
const projectSearchEl = document.querySelector("#project-search");
const conversationEl = document.querySelector("#conversation");
const commandFormEl = document.querySelector("#command-form");
const commandInputEl = document.querySelector("#command-input");
const titleEl = document.querySelector("#project-title");
const metaEl = document.querySelector("#project-meta");
const statusPillEl = document.querySelector("#project-status-pill");
const updatedTextEl = document.querySelector("#project-updated");
const infoTitleEl = document.querySelector("#info-title");
const infoStatusEl = document.querySelector("#info-status");
const infoWorkspaceEl = document.querySelector("#info-workspace");
const summaryMessagesEl = document.querySelector("#summary-messages");
const summaryCommandsEl = document.querySelector("#summary-commands");
const summaryUpdatedEl = document.querySelector("#summary-updated");
const authBannerEl = document.querySelector("#auth-banner");
const authButtonEl = document.querySelector("#auth-button");
const refreshButtonEl = document.querySelector("#refresh-button");
const projectRefreshButtonEl = document.querySelector("#project-refresh-button");
const projectToggleEl = document.querySelector("#project-sheet-toggle");
const infoToggleEl = document.querySelector("#info-sheet-toggle");
const closeProjectSheetEl = document.querySelector("#close-project-sheet");
const closeInfoSheetEl = document.querySelector("#close-info-sheet");
const jumpLatestEl = document.querySelector("#jump-latest");
const jobStatusBarEl = document.querySelector("#job-status-bar");
const jobStatusTitleEl = document.querySelector("#job-status-title");
const jobStatusDetailEl = document.querySelector("#job-status-detail");
const cancelOpenWorkButtonEl = document.querySelector("#cancel-open-work-button");

let ws = null;
let deferredInstallPrompt = null;
let stickToLatest = true;
let pendingUnread = false;

function syncViewportHeight() {
  document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
}

function getAccessToken() {
  return window.localStorage.getItem("codexRelayAccessToken") || "";
}

function bootstrapAccessTokenFromUrl() {
  const url = new URL(window.location.href);
  const token =
    url.searchParams.get("access_token")?.trim() ||
    url.searchParams.get("token")?.trim() ||
    "";

  if (!token) {
    return;
  }

  window.localStorage.setItem("codexRelayAccessToken", token);
  url.searchParams.delete("access_token");
  url.searchParams.delete("token");
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}

function ensureAccessToken(forcePrompt = false) {
  let token = getAccessToken();
  if (!token || forcePrompt) {
    token = window.prompt("请输入 Codex Relay 访问口令", token || "")?.trim() || "";
    if (token) {
      window.localStorage.setItem("codexRelayAccessToken", token);
    }
  }
  return token;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function setAuthBannerVisible(visible) {
  authBannerEl.hidden = !visible;
}

function setJumpLatestVisible(visible) {
  jumpLatestEl.hidden = !visible;
}

function openSheet(kind) {
  if (kind === "projects") {
    projectSheetEl.hidden = false;
    infoSheetEl.hidden = true;
    bodyEl.classList.add("projects-open");
    bodyEl.classList.remove("info-open");
  } else {
    infoSheetEl.hidden = false;
    projectSheetEl.hidden = true;
    bodyEl.classList.add("info-open");
    bodyEl.classList.remove("projects-open");
  }
  scrimEl.hidden = false;
}

function closeSheets() {
  projectSheetEl.hidden = true;
  infoSheetEl.hidden = true;
  bodyEl.classList.remove("projects-open", "info-open");
  scrimEl.hidden = true;
}

function getActiveProject() {
  return getVisibleProjects().find((project) => project.id === state.activeProjectId) || null;
}

function ensureActiveProject() {
  const visibleProjects = getVisibleProjects();
  if (!state.activeProjectId && visibleProjects.length) {
    state.activeProjectId = visibleProjects[0].id;
  }
  if (
    state.activeProjectId &&
    visibleProjects.length &&
    !visibleProjects.some((project) => project.id === state.activeProjectId)
  ) {
    state.activeProjectId = visibleProjects[0].id;
  }
}

function formatTimestamp(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();

  if (sameDay) {
    return `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  }

  return `${date.toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  })} ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
}

function formatRoleLabel(message) {
  if (message.source === "desktop-log") {
    return "桌面进度";
  }
  if (message.role === "user") {
    return "你";
  }
  if (message.role === "assistant") {
    return "Codex";
  }
  return "系统";
}

function formatSourceLabel(message) {
  if (message.source === "desktop-log") {
    return "桌面";
  }
  if (message.source === "web") {
    return "手机";
  }
  if (message.source === "bridge") {
    return "桥接";
  }
  return message.source || "中继";
}

function shouldDisplayMessage(message) {
  if (!message) {
    return false;
  }

  if (message.role !== "system") {
    return true;
  }

  const text = String(message.text || "");
  if (!text) {
    return false;
  }

  if (text.startsWith("Picked up command ") || text === "Bridge connected.") {
    return false;
  }

  return true;
}

function shouldDisplayProject(project) {
  if (!project?.workspacePath) {
    return true;
  }
  const normalizedName = project.workspacePath
    .split(/[\\/]/)
    .filter(Boolean)
    .pop()
    ?.toLowerCase();
  return normalizedName ? !hiddenProjectNames.has(normalizedName) : true;
}

function getVisibleProjects() {
  return state.projects.filter(shouldDisplayProject);
}

function getCommandSummary(project) {
  const commands = project?.commands || [];
  const pending = commands.filter((command) => command.status === "pending").length;
  const running = commands.filter(
    (command) => command.status === "running" || command.status === "cancel_requested"
  ).length;
  const failed = commands.filter((command) => command.status === "failed").length;
  const canceled = commands.filter((command) => command.status === "canceled").length;
  const completed = commands.filter((command) => command.status === "completed").length;
  return { pending, running, failed, canceled, completed };
}

function renderJobStatus(project) {
  if (!project) {
    jobStatusBarEl.hidden = true;
    return;
  }

  const summary = getCommandSummary(project);
  const openCount = summary.pending + summary.running;
  if (!openCount) {
    jobStatusBarEl.hidden = true;
    return;
  }

  jobStatusBarEl.hidden = false;
  if (summary.running) {
    jobStatusTitleEl.textContent = `当前有 ${summary.running} 条工作正在处理`;
    jobStatusDetailEl.textContent =
      summary.pending > 0
        ? `另有 ${summary.pending} 条在排队，当前项目会按顺序执行。`
        : "这条任务会继续在电脑后台执行，结果完成后会自动回到这里。";
  } else {
    jobStatusTitleEl.textContent = `当前有 ${summary.pending} 条工作在排队`;
    jobStatusDetailEl.textContent = "你可以继续追加，也可以先取消前面的未完成工作。";
  }

  cancelOpenWorkButtonEl.disabled = openCount === 0;
}

function isNearConversationBottom() {
  const threshold = 40;
  return (
    conversationEl.scrollHeight - conversationEl.scrollTop - conversationEl.clientHeight <=
    threshold
  );
}

function applyConversationScroll(previousDistanceFromBottom) {
  if (stickToLatest) {
    conversationEl.scrollTop = conversationEl.scrollHeight;
    pendingUnread = false;
    setJumpLatestVisible(false);
    return;
  }

  conversationEl.scrollTop = Math.max(
    0,
    conversationEl.scrollHeight - conversationEl.clientHeight - previousDistanceFromBottom
  );
  setJumpLatestVisible(pendingUnread);
}

function getFilteredProjects() {
  const visibleProjects = getVisibleProjects();
  const query = state.projectQuery.trim().toLowerCase();
  if (!query) {
    return visibleProjects;
  }

  return visibleProjects.filter((project) => {
    const haystack = `${project.title} ${project.workspacePath || ""} ${project.id}`.toLowerCase();
    return haystack.includes(query);
  });
}

function renderProjectList() {
  ensureActiveProject();
  const activeProject = getActiveProject();
  const filteredProjects = getFilteredProjects();
  const others = filteredProjects.filter((project) => project.id !== activeProject?.id);

  const sections = [];

  if (activeProject && (!state.projectQuery || filteredProjects.some((project) => project.id === activeProject.id))) {
    sections.push(`<p class="section-label">当前任务</p>${renderProjectCard(activeProject, true)}`);
  }

  if (others.length) {
    sections.push(
      `<p class="section-label">${state.projectQuery ? "搜索结果" : "可切换任务"}</p>${others
        .map((project) => renderProjectCard(project, false))
        .join("")}`
    );
  }

  if (!sections.length) {
    projectListEl.innerHTML =
      '<div class="empty-state">没有匹配的任务。你可以换个关键词，或回到电脑侧把对应工作区纳入桥接扫描范围。</div>';
  } else {
    projectListEl.innerHTML = sections.join("");
  }

  projectCountTextEl.textContent = `${filteredProjects.length} 个任务`;
}

function renderProjectCard(project, isActive) {
  const messageCount = (project.messages || []).filter(shouldDisplayMessage).length;
  const commandCount = (project.commands || []).length;
  const activeClass = isActive ? "active" : "";

  return `
    <button class="project-card ${activeClass}" data-project-id="${project.id}" type="button">
      <strong>${escapeHtml(project.title)}</strong>
      <span class="project-card-meta">${escapeHtml(project.status || "空闲")} · ${messageCount} 条消息 · ${commandCount} 条指令</span>
      <span class="project-card-path">${escapeHtml(project.workspacePath || "未提供工作区路径")}</span>
    </button>
  `;
}

function renderProjectInfo(project) {
  if (!project) {
    titleEl.textContent = "等待桥接连接";
    metaEl.textContent = "连接后会在这里显示本地任务和最新状态。";
    statusPillEl.textContent = "未连接";
    updatedTextEl.textContent = "尚无最近更新";
    infoTitleEl.textContent = "当前任务概览";
    infoStatusEl.textContent = "未选择任务";
    infoWorkspaceEl.textContent = "-";
    summaryMessagesEl.textContent = "0";
    summaryCommandsEl.textContent = "0";
    summaryUpdatedEl.textContent = "-";
    return;
  }

  titleEl.textContent = project.title;
  metaEl.textContent = project.workspacePath || "未提供工作区路径";
  statusPillEl.textContent = project.status || "空闲";
  updatedTextEl.textContent = formatTimestamp(project.updatedAt);
  infoTitleEl.textContent = `${project.title} 概览`;
  infoStatusEl.textContent = project.status || "空闲";
  infoWorkspaceEl.textContent = project.workspacePath || "未提供工作区路径";
  summaryMessagesEl.textContent = String((project.messages || []).filter(shouldDisplayMessage).length);
  summaryCommandsEl.textContent = String((project.commands || []).length);
  summaryUpdatedEl.textContent = formatTimestamp(project.updatedAt);
}

function renderConversation() {
  const project = getActiveProject();
  if (!project) {
    conversationEl.innerHTML = "";
    setJumpLatestVisible(false);
    return;
  }

  const previousDistanceFromBottom = Math.max(
    0,
    conversationEl.scrollHeight - conversationEl.scrollTop - conversationEl.clientHeight
  );

  const visibleMessages = (project.messages || []).filter(shouldDisplayMessage);
  conversationEl.innerHTML = visibleMessages.length
    ? visibleMessages
        .map(
          (message) => `
            <article class="message ${message.role}">
              <div class="message-meta">
                <p class="message-role">${escapeHtml(formatRoleLabel(message))}</p>
                <div class="message-chips">
                  <span class="message-chip">${escapeHtml(formatSourceLabel(message))}</span>
                  <span class="message-chip">${escapeHtml(formatTimestamp(message.createdAt))}</span>
                </div>
              </div>
              <pre>${escapeHtml(message.text)}</pre>
            </article>
          `
        )
        .join("")
    : '<div class="empty-state">这个任务还没有消息。你可以直接在底部发送下一步指令。</div>';

  applyConversationScroll(previousDistanceFromBottom);
}

function render() {
  ensureActiveProject();
  const activeProject = getActiveProject();
  renderProjectList();
  renderProjectInfo(activeProject);
  renderJobStatus(activeProject);
  renderConversation();
}

async function refreshProjects() {
  const token = getAccessToken();
  const headers = token ? { "x-access-token": token } : {};
  const response = await fetch("/api/projects", { headers });

  if (response.status === 401) {
    setAuthBannerVisible(true);
    return;
  }

  const data = await response.json();
  state.projects = data.projects || [];
  setAuthBannerVisible(false);
  render();
}

function upsertProject(project) {
  const activeProject = getActiveProject();
  const incomingForActiveProject = activeProject && project.id === activeProject.id;
  const activeAtBottom = activeProject ? isNearConversationBottom() : true;

  const index = state.projects.findIndex((item) => item.id === project.id);
  if (index === -1) {
    state.projects.push(project);
  } else {
    state.projects[index] = project;
  }

  if (incomingForActiveProject && !activeAtBottom) {
    pendingUnread = true;
  }
}

function connectWebSocket() {
  const token = getAccessToken();
  if (!token) {
    setAuthBannerVisible(true);
    return;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(
    `${protocol}//${window.location.host}/ws?access_token=${encodeURIComponent(token)}`
  );

  ws.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === "snapshot") {
      state.projects = payload.projects || [];
      ensureActiveProject();
      render();
      return;
    }

    if (payload.type === "project.updated" && payload.project) {
      upsertProject(payload.project);
      render();
    }
  });

  ws.addEventListener("close", () => {
    ws = null;
    window.setTimeout(connectWebSocket, 1000);
  });
}

function autoResizeTextarea() {
  commandInputEl.style.height = "0px";
  commandInputEl.style.height = `${Math.min(commandInputEl.scrollHeight, window.innerHeight * 0.24)}px`;
}

projectToggleEl.addEventListener("click", () => openSheet("projects"));
infoToggleEl.addEventListener("click", () => openSheet("info"));
closeProjectSheetEl.addEventListener("click", closeSheets);
closeInfoSheetEl.addEventListener("click", closeSheets);
scrimEl.addEventListener("click", closeSheets);

refreshButtonEl.addEventListener("click", async () => {
  await refreshProjects();
});

projectRefreshButtonEl.addEventListener("click", async () => {
  await refreshProjects();
});

projectSearchEl.addEventListener("input", () => {
  state.projectQuery = projectSearchEl.value;
  renderProjectList();
});

projectListEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-project-id]");
  if (!button) {
    return;
  }

  state.activeProjectId = button.dataset.projectId;
  stickToLatest = true;
  pendingUnread = false;
  render();
  closeSheets();
});

conversationEl.addEventListener("scroll", () => {
  const nearBottom = isNearConversationBottom();
  stickToLatest = nearBottom;
  if (nearBottom) {
    pendingUnread = false;
    setJumpLatestVisible(false);
  }
});

jumpLatestEl.addEventListener("click", () => {
  stickToLatest = true;
  pendingUnread = false;
  conversationEl.scrollTop = conversationEl.scrollHeight;
  setJumpLatestVisible(false);
});

authButtonEl.addEventListener("click", async () => {
  const token = ensureAccessToken(true);
  if (!token) {
    return;
  }

  await refreshProjects();
  connectWebSocket();
});

commandInputEl.addEventListener("input", autoResizeTextarea);

cancelOpenWorkButtonEl.addEventListener("click", async () => {
  const project = getActiveProject();
  if (!project) {
    return;
  }

  const response = await fetch(`/api/projects/${project.id}/commands/cancel-open`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(getAccessToken() ? { "x-access-token": getAccessToken() } : {}),
    },
    body: JSON.stringify({}),
  });

  if (response.ok) {
    stickToLatest = true;
    await refreshProjects();
  }
});

commandFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const project = getActiveProject();
  const text = commandInputEl.value.trim();

  if (!project || !text) {
    return;
  }

  const response = await fetch(`/api/projects/${project.id}/commands`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(getAccessToken() ? { "x-access-token": getAccessToken() } : {}),
    },
    body: JSON.stringify({ text, source: "web" }),
  });

  if (response.ok) {
    commandInputEl.value = "";
    autoResizeTextarea();
    stickToLatest = true;
    await refreshProjects();
    commandInputEl.focus();
  }
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("/sw.js");
    } catch (error) {
      console.error("Service worker registration failed:", error);
    }
  });
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSheets();
  }
});

window.addEventListener("resize", () => {
  syncViewportHeight();
  autoResizeTextarea();
});

window.addEventListener("orientationchange", () => {
  syncViewportHeight();
  autoResizeTextarea();
});

bootstrapAccessTokenFromUrl();
syncViewportHeight();
autoResizeTextarea();
await refreshProjects();
connectWebSocket();
