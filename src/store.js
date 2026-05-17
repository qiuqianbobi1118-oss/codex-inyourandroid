import fs from "node:fs";
import path from "node:path";

function nowIso() {
  return new Date().toISOString();
}

function createEmptyState() {
  return {
    projects: {},
    projectOrder: [],
    commandCounter: 0,
    eventCounter: 0,
  };
}

function isOpenCommandStatus(status) {
  return status === "pending" || status === "running" || status === "cancel_requested";
}

export class Store {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, "state.json");
    this.state = this.#load();
  }

  #load() {
    if (!fs.existsSync(this.filePath)) {
      const initial = createEmptyState();
      this.#save(initial);
      return initial;
    }

    const raw = fs.readFileSync(this.filePath, "utf8");
    return { ...createEmptyState(), ...JSON.parse(raw) };
  }

  #save(nextState = this.state) {
    fs.writeFileSync(this.filePath, JSON.stringify(nextState, null, 2), "utf8");
  }

  #touchProject(project) {
    project.updatedAt = nowIso();
    if (!project.createdAt) {
      project.createdAt = project.updatedAt;
    }
  }

  listProjects() {
    return this.state.projectOrder
      .map((id) => this.state.projects[id])
      .filter(Boolean);
  }

  getProject(projectId) {
    return this.state.projects[projectId] || null;
  }

  upsertProject(input) {
    const projectId = input.id;
    const existing = this.state.projects[projectId];
    const next = existing || {
      id: projectId,
      title: input.title || projectId,
      description: input.description || "",
      status: input.status || "idle",
      machineName: input.machineName || "",
      workspacePath: input.workspacePath || "",
      messages: [],
      commands: [],
      activeCommandId: "",
      metadata: {},
    };

    next.title = input.title || next.title;
    next.description = input.description ?? next.description;
    next.status = input.status || next.status;
    next.machineName = input.machineName ?? next.machineName;
    next.workspacePath = input.workspacePath ?? next.workspacePath;
    next.metadata = { ...next.metadata, ...(input.metadata || {}) };

    this.#touchProject(next);
    this.state.projects[projectId] = next;
    if (!this.state.projectOrder.includes(projectId)) {
      this.state.projectOrder.unshift(projectId);
    }
    this.#save();
    return next;
  }

  syncProjects(projectInputs) {
    const nextOrder = [];
    const nextProjects = {};

    for (const input of projectInputs) {
      const existing = this.state.projects[input.id];
      const next = existing || {
        id: input.id,
        title: input.title || input.id,
        description: input.description || "",
        status: input.status || "idle",
        machineName: input.machineName || "",
        workspacePath: input.workspacePath || "",
        messages: [],
        commands: [],
        activeCommandId: "",
        metadata: {},
      };

      next.title = input.title || next.title;
      next.description = input.description ?? next.description;
      next.status = input.status || next.status;
      next.machineName = input.machineName ?? next.machineName;
      next.workspacePath = input.workspacePath ?? next.workspacePath;
      next.metadata = { ...next.metadata, ...(input.metadata || {}) };
      this.#touchProject(next);

      nextProjects[input.id] = next;
      nextOrder.push(input.id);
    }

    this.state.projects = nextProjects;
    this.state.projectOrder = nextOrder;
    this.#save();
    return this.listProjects();
  }

  appendMessage(projectId, messageInput) {
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    this.state.eventCounter += 1;
    const message = {
      id: `evt_${this.state.eventCounter}`,
      role: messageInput.role,
      text: messageInput.text,
      source: messageInput.source || "system",
      createdAt: nowIso(),
      meta: messageInput.meta || {},
    };

    project.messages.push(message);
    if (project.messages.length > 200) {
      project.messages = project.messages.slice(-200);
    }
    if (messageInput.status) {
      project.status = messageInput.status;
    }
    this.#touchProject(project);
    this.#save();
    return message;
  }

  enqueueCommand(projectId, commandInput) {
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    this.state.commandCounter += 1;
    const command = {
      id: `cmd_${this.state.commandCounter}`,
      text: commandInput.text,
      source: commandInput.source || "web",
      createdAt: nowIso(),
      status: "pending",
      meta: commandInput.meta || {},
    };

    project.commands.push(command);
    this.#touchProject(project);
    this.#save();
    return command;
  }

  listCommands(projectId, afterId = "") {
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (!afterId) {
      return project.commands.filter((command) => command.status === "pending");
    }

    let seen = false;
    return project.commands.filter((command) => {
      if (!seen && command.id === afterId) {
        seen = true;
        return false;
      }
      return seen && command.status === "pending";
    });
  }

  ackCommand(projectId, commandId) {
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const command = project.commands.find((item) => item.id === commandId);
    if (!command) {
      throw new Error(`Command not found: ${commandId}`);
    }

    command.status = "running";
    command.acknowledgedAt = nowIso();
    command.startedAt = nowIso();
    project.activeCommandId = commandId;
    this.#touchProject(project);
    this.#save();
    return command;
  }

  getCommand(projectId, commandId) {
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    return project.commands.find((item) => item.id === commandId) || null;
  }

  setCommandStatus(projectId, commandId, status, extra = {}) {
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const command = project.commands.find((item) => item.id === commandId);
    if (!command) {
      throw new Error(`Command not found: ${commandId}`);
    }

    command.status = status;
    command.meta = { ...command.meta, ...(extra || {}) };
    if (status === "completed") {
      command.completedAt = nowIso();
    }
    if (status === "failed") {
      command.failedAt = nowIso();
    }
    if (status === "canceled" || status === "cancel_requested") {
      command.canceledAt = nowIso();
    }

    if (project.activeCommandId === commandId && status !== "running" && status !== "cancel_requested") {
      project.activeCommandId = "";
    }

    this.#touchProject(project);
    this.#save();
    return command;
  }

  cancelOpenCommands(projectId) {
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const updated = [];
    for (const command of project.commands) {
      if (command.status === "pending") {
        command.status = "canceled";
        command.canceledAt = nowIso();
        updated.push(command);
        continue;
      }
      if (command.status === "running") {
        command.status = "cancel_requested";
        command.canceledAt = nowIso();
        updated.push(command);
      }
    }

    if (!project.commands.some((command) => isOpenCommandStatus(command.status))) {
      project.activeCommandId = "";
    }

    this.#touchProject(project);
    this.#save();
    return updated;
  }
}
