import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (process.env[key]) {
      continue;
    }
    process.env[key] = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
  }
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(moduleDir, "..");
loadEnv(path.join(rootDir, ".env"));

const serverUrl = process.env.RELAY_SERVER_URL || "http://127.0.0.1:8787";
const bridgeSecret = process.env.BRIDGE_SHARED_SECRET || "";
const projectRoots = (process.env.BRIDGE_PROJECT_ROOTS || "C:\\Projects;D:\\Projects")
  .split(";")
  .map((value) => value.trim())
  .filter(Boolean);
const projectContainers = (process.env.BRIDGE_PROJECT_CONTAINER_NAMES || "Projects")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const excludedProjectNames = new Set(
  (process.env.BRIDGE_PROJECT_EXCLUDE_NAMES ||
    "codex,codex-mobile-relay,relevantsoftware,wireguard,projects,$recycle.bin,system volume information")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);
const includeSingleFiles =
  (process.env.BRIDGE_INCLUDE_SINGLE_FILES || "false").toLowerCase() === "true";
const discoverSiblingProjects =
  (process.env.BRIDGE_DISCOVER_SIBLINGS || "true").toLowerCase() !== "false";
const defaultProjectId = process.env.BRIDGE_DEFAULT_PROJECT_ID || "main-project";
const explicitCodexLogRoot = process.env.BRIDGE_CODEX_LOG_ROOT || "";
const explicitCodexExe = process.env.BRIDGE_CODEX_EXE || "";
const bridgeRootDir = rootDir;
const dataDir = process.env.DATA_DIR || path.join(bridgeRootDir, "data");
const projectRegistryPath =
  process.env.BRIDGE_PROJECT_REGISTRY_PATH || path.join(dataDir, "projects.json");
const pollIntervalMs = Number(process.env.BRIDGE_POLL_INTERVAL_MS || 4000);
const codexExecTimeoutMs = Number(process.env.BRIDGE_CODEX_EXEC_TIMEOUT_MS || 1800000);
const mockMode = (process.env.BRIDGE_MOCK_MODE || "true").toLowerCase() !== "false";
const tailCodexLogs = (process.env.BRIDGE_TAIL_CODEX_LOGS || "true").toLowerCase() !== "false";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "project";
}

function stablePathHash(targetPath) {
  const input = path.resolve(targetPath).replace(/\\/g, "/").toLowerCase();
  let hash = 2166136261;
  for (const char of input) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildProjectId(targetPath, preferredId = "") {
  if (preferredId) {
    return preferredId;
  }
  return `${slugify(path.basename(targetPath))}-${stablePathHash(targetPath)}`;
}

function displayNameFromPath(targetPath) {
  const base = path.basename(targetPath);
  return base
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizePath(targetPath) {
  return path.resolve(targetPath).toLowerCase();
}

function isDriveRoot(targetPath) {
  const resolved = path.resolve(targetPath);
  return resolved === path.parse(resolved).root;
}

function isContainerDirectory(targetPath) {
  return projectContainers.includes(path.basename(targetPath).toLowerCase());
}

function shouldSkipDirectory(entryName) {
  const normalized = entryName.trim().toLowerCase();
  return !normalized || normalized.startsWith(".") || normalized.startsWith("_archive") || excludedProjectNames.has(normalized);
}

function createProjectRecord(workspacePath, preferredId = "") {
  return {
    id: buildProjectId(workspacePath, preferredId),
    title: displayNameFromPath(workspacePath),
    workspacePath,
  };
}

function loadProjectRegistry() {
  if (!fs.existsSync(projectRegistryPath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(projectRegistryPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item) => item && typeof item.workspacePath === "string" && item.workspacePath.trim())
      .map((item) => {
        const project = createProjectRecord(item.workspacePath.trim(), item.id || "");
        if (typeof item.title === "string" && item.title.trim()) {
          project.title = item.title.trim();
        }
        return project;
      })
      .filter((project) => fs.existsSync(project.workspacePath));
  } catch (error) {
    console.error(`Failed to load project registry ${projectRegistryPath}: ${error.message}`);
    return [];
  }
}

function collectCandidateRoots() {
  const seen = new Set();
  const candidates = [];

  for (const rootPath of projectRoots) {
    const resolved = path.resolve(rootPath);
    if (!seen.has(`configured:${resolved}`)) {
      seen.add(`configured:${resolved}`);
      candidates.push({ path: resolved, mode: "configured" });
    }

    if (!discoverSiblingProjects || isDriveRoot(resolved)) {
      continue;
    }

    const parentPath = path.dirname(resolved);
    if (!parentPath || parentPath === resolved) {
      continue;
    }

    if (!seen.has(`siblings:${parentPath}`)) {
      seen.add(`siblings:${parentPath}`);
      candidates.push({ path: parentPath, mode: "siblings" });
    }
  }

  return candidates;
}

function pushChildDirectories(discovered, rootPath) {
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || shouldSkipDirectory(entry.name)) {
      continue;
    }

    const childPath = path.join(rootPath, entry.name);
    if (isContainerDirectory(childPath)) {
      const nestedEntries = fs.readdirSync(childPath, { withFileTypes: true });
      for (const nestedEntry of nestedEntries) {
        if (!nestedEntry.isDirectory() || shouldSkipDirectory(nestedEntry.name)) {
          continue;
        }
        discovered.push(createProjectRecord(path.join(childPath, nestedEntry.name)));
      }
      continue;
    }

    discovered.push(createProjectRecord(childPath));
  }
}

export function discoverProjects() {
  const registryProjects = loadProjectRegistry();
  if (registryProjects.length) {
    return registryProjects;
  }

  const discovered = [];

  for (const candidate of collectCandidateRoots()) {
    if (!fs.existsSync(candidate.path)) {
      continue;
    }

    const stat = fs.statSync(candidate.path);
    if (stat.isDirectory()) {
      const shouldScanChildren =
        candidate.mode === "siblings" || isDriveRoot(candidate.path) || isContainerDirectory(candidate.path);

      if (shouldScanChildren) {
        pushChildDirectories(discovered, candidate.path);
        continue;
      }

      discovered.push(createProjectRecord(candidate.path));
      continue;
    }

    discovered.push(createProjectRecord(candidate.path));
  }

  const seen = new Set();
  return discovered.filter((project) => {
    const key = normalizePath(project.workspacePath);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function api(pathname, init = {}) {
  const response = await fetch(`${serverUrl}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-bridge-secret": bridgeSecret,
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json();
}

async function registerProject(project) {
  await api("/api/bridge/projects/upsert", {
    method: "POST",
    body: JSON.stringify({
      id: project.id,
      title: project.title,
      status: "idle",
      machineName: os.hostname(),
      workspacePath: project.workspacePath,
      metadata: {
        bridgeMode: mockMode ? "mock" : "real",
        discoveredFrom: project.workspacePath,
      },
    }),
  });
}

async function syncProjects(projects) {
  await api("/api/bridge/projects/sync", {
    method: "POST",
    body: JSON.stringify({
      projects: projects.map((project) => ({
        id: project.id,
        title: project.title,
        status: "idle",
        machineName: os.hostname(),
        workspacePath: project.workspacePath,
        metadata: {
          bridgeMode: mockMode ? "mock" : "real",
          discoveredFrom: project.workspacePath,
        },
      })),
    }),
  });
}

async function postAssistantMessage(projectId, text, status = "running") {
  return api(`/api/bridge/projects/${projectId}/events`, {
    method: "POST",
    body: JSON.stringify({
      role: "assistant",
      text,
      source: "bridge",
      status,
    }),
  });
}

async function postSystemMessage(projectId, text, status = "idle") {
  return api(`/api/bridge/projects/${projectId}/events`, {
    method: "POST",
    body: JSON.stringify({
      role: "system",
      text,
      source: "bridge",
      status,
    }),
  });
}

async function postDesktopMessage(projectId, text, status = "running") {
  return api(`/api/bridge/projects/${projectId}/events`, {
    method: "POST",
    body: JSON.stringify({
      role: "assistant",
      text,
      source: "desktop-log",
      status,
      meta: {
        channel: "desktop-activity",
      },
    }),
  });
}

function findCodexExecutable() {
  if (explicitCodexExe && fs.existsSync(explicitCodexExe)) {
    return explicitCodexExe;
  }

  const candidates = [];
  const localAppData =
    process.env.LOCALAPPDATA ||
    (process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "AppData", "Local")
      : "");

  if (localAppData) {
    candidates.push(localAppData);
  }

  const usersRoot = "C:\\Users";
  if (fs.existsSync(usersRoot)) {
    for (const entry of fs.readdirSync(usersRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(path.join(usersRoot, entry.name, "AppData", "Local"));
      }
    }
  }

  for (const base of candidates) {
    const binPath = path.join(
      base,
      "Packages",
      "OpenAI.Codex_2p2nqsd0c76g0",
      "LocalCache",
      "Local",
      "OpenAI",
      "Codex",
      "bin",
      "codex.exe"
    );
    if (fs.existsSync(binPath)) {
      return binPath;
    }
  }

  return "codex";
}

function safeReadText(filePath, maxChars = 8000) {
  if (!filePath || !fs.existsSync(filePath)) {
    return "";
  }

  try {
    return fs.readFileSync(filePath, "utf8").slice(0, maxChars).trim();
  } catch {
    return "";
  }
}

function buildProjectPrompt(project, userPrompt) {
  const syncDoc =
    safeReadText(path.join(project.workspacePath, "CODEX-SYNC.md"), 10000) ||
    safeReadText(path.join(project.workspacePath, "STATUS.md"), 8000) ||
    "";

  return [
    `你正在通过手机中继为项目“${project.title}”工作。`,
    "如果工作区里有同步文档或状态文档，请优先根据这些内容回答，不要泛泛而谈。",
    "如果用户在问状态、进展、优先级、下一步，请尽量给出简洁、可执行的答案。",
    syncDoc ? `\n以下是当前项目文档摘录：\n${syncDoc}\n` : "",
    `用户刚刚的请求是：\n${userPrompt}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildProjectStatusReply(project, userPrompt) {
  return "";
}

class CommandCanceledError extends Error {
  constructor(message = "command canceled") {
    super(message);
    this.name = "CommandCanceledError";
    this.code = "COMMAND_CANCELED";
  }
}

function stopProcessTree(pid) {
  try {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } catch {
  }
}

function runCodexExec(project, prompt, options = {}) {
  const codexExe = findCodexExecutable();
  const outputDir = path.join(bridgeRootDir, "logs");
  fs.mkdirSync(outputDir, { recursive: true });
  const safeProjectId = project.id.replace(/[^a-z0-9_-]/gi, "_");
  const outputFile = path.join(outputDir, `codex-last-${safeProjectId}.txt`);
  const finalPrompt = buildProjectPrompt(project, prompt);
  if (fs.existsSync(outputFile)) {
    fs.rmSync(outputFile, { force: true });
  }
  const promptFile = path.join(outputDir, `codex-prompt-${safeProjectId}.txt`);
  fs.writeFileSync(promptFile, finalPrompt, "utf8");

  const args = [
    "exec",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "--cd",
    project.workspacePath,
    "--output-last-message",
    outputFile,
    "-",
  ];

  return new Promise((resolve, reject) => {
    console.log(
      `[bridge] codex exec start project=${project.id} exeExists=${fs.existsSync(
        codexExe
      )} exe="${codexExe}" output="${outputFile}" prompt="${prompt.slice(
        0,
        120
      )}"`
    );
    const child = spawn(codexExe, args, {
      cwd: project.workspacePath,
      windowsHide: true,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let stdout = "";
    let settled = false;
    let cancelCheckInFlight = false;
    let timeout = null;
    let outputWatcher = null;
    const finishWithReply = (replyText, reason = "reply-ready") => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(outputWatcher);
      stopProcessTree(child.pid);
      console.log(
        `[bridge] codex exec ${reason} project=${project.id} lastMessage="${replyText.slice(0, 120)}"`
      );
      resolve({
        code: null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        lastMessage: replyText,
      });
    };
    outputWatcher = setInterval(() => {
      if (settled || !fs.existsSync(outputFile)) {
      } else {
        const candidate = fs.readFileSync(outputFile, "utf8").trim();
        if (candidate) {
          finishWithReply(candidate, "reply-ready");
          return;
        }
      }

      if (settled || !options.shouldCancel || cancelCheckInFlight) {
        return;
      }

      cancelCheckInFlight = true;
      Promise.resolve(options.shouldCancel())
        .then((shouldCancel) => {
          if (!shouldCancel || settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          clearInterval(outputWatcher);
          stopProcessTree(child.pid);
          reject(new CommandCanceledError());
        })
        .catch(() => {})
        .finally(() => {
          cancelCheckInFlight = false;
        });
    }, 1000);

    timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      console.error(`[bridge] codex exec timeout project=${project.id} pid=${child.pid}`);
      stopProcessTree(child.pid);
      let lastMessage = "";
      if (fs.existsSync(outputFile)) {
        lastMessage = fs.readFileSync(outputFile, "utf8").trim();
      }
      if (lastMessage) {
        finishWithReply(lastMessage, "timeout-but-reply-ready");
        return;
      }
      settled = true;
      clearInterval(outputWatcher);
      reject(new Error(`codex exec timed out after ${codexExecTimeoutMs}ms`));
    }, codexExecTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.stdin.write(finalPrompt, "utf8");
    child.stdin.end();

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(outputWatcher);
      console.error(`[bridge] codex exec spawn error project=${project.id}: ${error.message}`);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(outputWatcher);
      let lastMessage = "";
      if (fs.existsSync(outputFile)) {
        lastMessage = fs.readFileSync(outputFile, "utf8").trim();
      }

      if (code === 0) {
        console.log(
          `[bridge] codex exec success project=${project.id} code=${code} lastMessage="${lastMessage.slice(
            0,
            120
          )}"`
        );
        resolve({
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          lastMessage,
        });
        return;
      }

      if (lastMessage) {
        console.log(
          `[bridge] codex exec nonzero-but-reply-ready project=${project.id} code=${code} lastMessage="${lastMessage.slice(
            0,
            120
          )}"`
        );
        resolve({
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          lastMessage,
        });
        return;
      }

      reject(
        new Error(
          [
            `codex exec exited with code ${code}`,
            stderr.trim(),
            stdout.trim(),
            lastMessage ? `lastMessage: ${lastMessage}` : "",
          ]
            .filter(Boolean)
            .join("\n")
        )
      );
    });
  });
}

async function fetchCommands(projectId, afterId = "") {
  const url = new URL(`/api/bridge/projects/${projectId}/commands`, serverUrl);
  if (afterId) {
    url.searchParams.set("after", afterId);
  }

  const response = await fetch(url, {
    headers: {
      "x-bridge-secret": bridgeSecret,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.commands || [];
}

async function ackCommand(projectId, commandId) {
  const response = await fetch(`${serverUrl}/api/bridge/projects/${projectId}/commands/${commandId}/ack`, {
    method: "POST",
    headers: {
      "x-bridge-secret": bridgeSecret,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
}

async function fetchCommand(projectId, commandId) {
  const response = await fetch(`${serverUrl}/api/bridge/projects/${projectId}/commands/${commandId}`, {
    headers: {
      "x-bridge-secret": bridgeSecret,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.command || null;
}

async function setCommandStatus(projectId, commandId, status, meta = {}) {
  const response = await fetch(`${serverUrl}/api/bridge/projects/${projectId}/commands/${commandId}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bridge-secret": bridgeSecret,
    },
    body: JSON.stringify({ status, meta }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.command || null;
}

async function executeMockCommand(projectId, command) {
  await postSystemMessage(projectId, `Picked up command ${command.id}`, "running");
  await sleep(1200);
  await postAssistantMessage(
    projectId,
    `Mock bridge received your instruction and would now continue Codex work:\n\n${command.text}`,
    "idle"
  );
  await setCommandStatus(projectId, command.id, "completed", { phase: "mock-reply" }).catch(() => {});
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

  if (
    text.startsWith("Picked up command ") ||
    text === "Bridge connected."
  ) {
    return false;
  }

  return true;
}

function findCodexLogRoot() {
  if (explicitCodexLogRoot && fs.existsSync(explicitCodexLogRoot)) {
    return explicitCodexLogRoot;
  }

  const candidateRoots = [];
  const localAppData =
    process.env.LOCALAPPDATA ||
    (process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "AppData", "Local")
      : "");

  if (localAppData) {
    candidateRoots.push(localAppData);
  }

  const usersRoot = "C:\\Users";
  if (fs.existsSync(usersRoot)) {
    for (const entry of fs.readdirSync(usersRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      candidateRoots.push(path.join(usersRoot, entry.name, "AppData", "Local"));
    }
  }

  for (const root of candidateRoots) {
    const packagesDir = path.join(root, "Packages");
    if (!fs.existsSync(packagesDir)) {
      continue;
    }

    const packageDir = fs
      .readdirSync(packagesDir, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.startsWith("OpenAI.Codex_"));

    if (!packageDir) {
      continue;
    }

    const logRoot = path.join(
      packagesDir,
      packageDir.name,
      "LocalCache",
      "Local",
      "Codex",
      "Logs"
    );
    if (fs.existsSync(logRoot)) {
      return logRoot;
    }
  }

  return "";
}

function findLatestCodexLogFile(logRoot) {
  if (!logRoot || !fs.existsSync(logRoot)) {
    return "";
  }

  const stack = [logRoot];
  let latest = null;

  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = fs.statSync(fullPath);
      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = { path: fullPath, mtimeMs: stat.mtimeMs };
      }
    }
  }

  return latest?.path || "";
}

function summarizeDesktopLogLine(line) {
  const clean = line.trim();
  if (!clean) {
    return null;
  }

  const conversationMatch = clean.match(/conversationId=([a-f0-9-]+)/i);
  const conversationSuffix = conversationMatch
    ? conversationMatch[1].slice(-6)
    : "";

  if (clean.includes("method=turn/start")) {
    return {
      text: `Desktop Codex started a new turn${conversationSuffix ? ` for session …${conversationSuffix}` : ""}.`,
      status: "running",
    };
  }

  if (clean.includes("Received item/started")) {
    return {
      text: `Desktop Codex is actively working${conversationSuffix ? ` in session …${conversationSuffix}` : ""}.`,
      status: "running",
    };
  }

  if (clean.includes("Received item/completed")) {
    return {
      text: `Desktop Codex completed a work item${conversationSuffix ? ` in session …${conversationSuffix}` : ""}.`,
      status: "idle",
    };
  }

  if (clean.includes("[desktop-notifications][global-error]")) {
    return {
      text: "Desktop Codex reported a UI-side warning while processing.",
      status: "running",
    };
  }

  if (clean.includes("Conversation state not found")) {
    return null;
  }

  return null;
}

function startCodexDesktopTail(projectId) {
  if (!tailCodexLogs) {
    return { stop() {} };
  }

  const logRoot = findCodexLogRoot();
  if (!logRoot) {
    console.log("Codex desktop log root not found. Skipping desktop tail.");
    return { stop() {} };
  }

  let currentFile = "";
  let currentPosition = 0;
  let lastFingerprint = "";

  const syncLatestFile = () => {
    const latestFile = findLatestCodexLogFile(logRoot);
    if (!latestFile) {
      return;
    }
    if (latestFile !== currentFile) {
      currentFile = latestFile;
      currentPosition = Math.max(0, fs.statSync(currentFile).size - 8192);
    }
  };

  const pump = async () => {
    try {
      syncLatestFile();
      if (!currentFile || !fs.existsSync(currentFile)) {
        return;
      }

      const stat = fs.statSync(currentFile);
      if (stat.size < currentPosition) {
        currentPosition = 0;
      }
      if (stat.size === currentPosition) {
        return;
      }

      const stream = fs.createReadStream(currentFile, {
        encoding: "utf8",
        start: currentPosition,
        end: stat.size - 1,
      });

      let chunk = "";
      for await (const part of stream) {
        chunk += part;
      }
      currentPosition = stat.size;

      const lines = chunk.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const summary = summarizeDesktopLogLine(line);
        if (!summary) {
          continue;
        }
        const fingerprint = `${summary.status}:${summary.text}`;
        if (fingerprint === lastFingerprint) {
          continue;
        }
        lastFingerprint = fingerprint;
        await postDesktopMessage(projectId, summary.text, summary.status);
      }
    } catch (error) {
      console.error("Codex desktop tail failed:", error.message);
    }
  };

  const timer = setInterval(() => {
    pump();
  }, 2000);

  pump();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function executeRealCommand(project, command, releaseProject, releaseCommand) {
  let settled = false;
  const isCanceled = async () => {
    const latest = await fetchCommand(project.id, command.id).catch(() => null);
    return latest?.status === "cancel_requested" || latest?.status === "canceled";
  };
  const startedAt = Date.now();
  const progressMessages = new Set();
  const progressTimer = setInterval(() => {
    if (settled) {
      return;
    }
    const elapsedMinutes = Math.max(1, Math.floor((Date.now() - startedAt) / 60000));
    const progressText =
      elapsedMinutes <= 1
        ? "这条指令还在处理中，我会在拿到结果后自动回到这里。"
        : `这条指令已处理约 ${elapsedMinutes} 分钟，电脑仍在后台继续执行。`;
    if (progressMessages.has(progressText)) {
      return;
    }
    progressMessages.add(progressText);
    postSystemMessage(project.id, progressText, "running").catch(() => {});
  }, 30000);

  try {
    await postSystemMessage(project.id, "已收到指令，正在后台处理中。", "running");
    await setCommandStatus(project.id, command.id, "running", { phase: "accepted" }).catch(() => {});

    if (await isCanceled()) {
      settled = true;
      await setCommandStatus(project.id, command.id, "canceled", { phase: "canceled-before-start" }).catch(
        () => {}
      );
      await postSystemMessage(project.id, "已取消这条未完成工作。", "idle").catch(() => {});
      return;
    }

    const fastReply = buildProjectStatusReply(project, command.text);
    if (fastReply) {
      console.log(`[bridge] local project status reply for ${command.id}`);
      if (await isCanceled()) {
        settled = true;
        await setCommandStatus(project.id, command.id, "canceled", { phase: "canceled-before-fast-reply" }).catch(
          () => {}
        );
        await postSystemMessage(project.id, "已取消这条未完成工作。", "idle").catch(() => {});
        return;
      }
      settled = true;
      await postAssistantMessage(project.id, fastReply, "idle");
      await setCommandStatus(project.id, command.id, "completed", { phase: "fast-reply" }).catch(() => {});
      return;
    }

    const result = await runCodexExec(project, command.text, { shouldCancel: isCanceled });
    if (await isCanceled()) {
      settled = true;
      await setCommandStatus(project.id, command.id, "canceled", { phase: "reply-suppressed-after-cancel" }).catch(
        () => {}
      );
      await postSystemMessage(project.id, "已取消这条未完成工作，不再回贴旧结果。", "idle").catch(() => {});
      return;
    }

    settled = true;
    console.log(`[bridge] posting assistant reply for ${command.id}`);
    await postAssistantMessage(
      project.id,
      result.lastMessage ||
        result.stdout ||
        "Codex finished the requested step, but did not emit a final text reply.",
      "idle"
    );
    console.log(`[bridge] assistant reply posted for ${command.id}`);
    await setCommandStatus(project.id, command.id, "completed", { phase: "reply-posted" }).catch(() => {});
  } catch (error) {
    settled = true;
    if (error instanceof CommandCanceledError || error?.code === "COMMAND_CANCELED") {
      console.log(`[bridge] command ${command.id} canceled during execution`);
      await setCommandStatus(project.id, command.id, "canceled", { phase: "canceled-during-exec" }).catch(
        () => {}
      );
      await postSystemMessage(project.id, "已取消这条未完成工作，不再回贴旧结果。", "idle").catch(() => {});
      return;
    }
    console.error(`[bridge] command ${command.id} failed: ${error.message}`);
    await postSystemMessage(
      project.id,
      `任务 ${command.id} 执行失败。\n\n${error.message}`,
      "idle"
    );
    console.log(`[bridge] failure message posted for ${command.id}`);
    await setCommandStatus(project.id, command.id, "failed", { error: error.message }).catch(() => {});
  } finally {
    clearInterval(progressTimer);
    releaseProject();
    releaseCommand();
  }
}

export async function startBridge() {
  if (!bridgeSecret) {
    throw new Error("BRIDGE_SHARED_SECRET is required for the bridge client.");
  }

  console.log("Bridge starting...");
  const projects = discoverProjects();
  if (!projects.length) {
    throw new Error("No projects discovered. Check BRIDGE_PROJECT_ROOTS.");
  }

  const commandCursor = new Map();
  const processingCommands = new Set();
  const busyProjects = new Set();
  let pollInFlight = false;
  await syncProjects(projects);
  for (const project of projects) {
    await registerProject(project);
    await postSystemMessage(project.id, "Bridge connected.", "idle");
  }
  const desktopTail = startCodexDesktopTail(defaultProjectId);

  const interval = setInterval(async () => {
    if (pollInFlight) {
      return;
    }
    pollInFlight = true;
    try {
      const currentProjects = discoverProjects();
      await syncProjects(currentProjects);
      for (const project of currentProjects) {
        if (busyProjects.has(project.id)) {
          continue;
        }
        await registerProject(project);
        const lastSeenCommandId = commandCursor.get(project.id) || "";
        const commands = await fetchCommands(project.id, lastSeenCommandId);
        for (const command of commands) {
          if (processingCommands.has(command.id) || busyProjects.has(project.id)) {
            continue;
          }

          processingCommands.add(command.id);
          busyProjects.add(project.id);

          console.log(`[bridge] acknowledging ${command.id}`);
          await ackCommand(project.id, command.id);
          console.log(`[bridge] acknowledged ${command.id}`);
          commandCursor.set(project.id, command.id);

          if (mockMode) {
            void executeMockCommand(project.id, command)
              .catch((error) => {
                console.error(`[bridge] mock command ${command.id} failed: ${error.message}`);
              })
              .finally(() => {
                busyProjects.delete(project.id);
                processingCommands.delete(command.id);
              });
          } else {
            void executeRealCommand(
              project,
              command,
              () => busyProjects.delete(project.id),
              () => processingCommands.delete(command.id)
            );
          }

          break;
        }
      }
    } catch (error) {
      console.error("Bridge loop failed:", error.message);
    } finally {
      pollInFlight = false;
    }
  }, pollIntervalMs);

  return {
    stop() {
      clearInterval(interval);
      desktopTail.stop();
    },
  };
}
