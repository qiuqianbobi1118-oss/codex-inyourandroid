import express from "express";

function requireBridgeAuth(config, req, res, next) {
  if (!config.bridgeSharedSecret) {
    return res.status(500).json({ error: "BRIDGE_SHARED_SECRET is not configured." });
  }

  const provided = req.get("x-bridge-secret");
  if (!provided || provided !== config.bridgeSharedSecret) {
    return res.status(401).json({ error: "Unauthorized bridge request." });
  }
  return next();
}

function requirePublicAuth(config, req, res, next) {
  if (!config.publicAccessToken) {
    return next();
  }

  const provided =
    req.get("x-access-token") ||
    req.query.access_token ||
    req.body?.access_token;

  if (provided !== config.publicAccessToken) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  return next();
}

export function createApiRouter({ config, store, broker }) {
  const router = express.Router();

  router.get("/health", (_req, res) => {
    res.json({ ok: true, appName: config.appName });
  });

  router.get("/projects", requirePublicAuth.bind(null, config), (_req, res) => {
    res.json({ projects: store.listProjects() });
  });

  router.post("/projects", requirePublicAuth.bind(null, config), (req, res) => {
    const project = store.upsertProject(req.body || {});
    broker.publish({ type: "project.updated", project });
    res.status(201).json({ project });
  });

  router.get("/projects/:projectId", requirePublicAuth.bind(null, config), (req, res) => {
    const project = store.getProject(req.params.projectId);
    if (!project) {
      return res.status(404).json({ error: "Project not found." });
    }
    return res.json({ project });
  });

  router.post("/projects/:projectId/messages", requirePublicAuth.bind(null, config), (req, res) => {
    try {
      const message = store.appendMessage(req.params.projectId, req.body || {});
      const project = store.getProject(req.params.projectId);
      broker.publish({ type: "message.created", project, message });
      broker.publish({ type: "project.updated", project });
      return res.status(201).json({ message });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.post("/projects/:projectId/commands", requirePublicAuth.bind(null, config), (req, res) => {
    try {
      const command = store.enqueueCommand(req.params.projectId, req.body || {});
      const project = store.getProject(req.params.projectId);
      store.appendMessage(req.params.projectId, {
        role: "user",
        text: command.text,
        source: command.source,
      });
      const refreshedProject = store.getProject(req.params.projectId);
      broker.publish({ type: "command.enqueued", projectId: req.params.projectId, command });
      broker.publish({ type: "project.updated", project: refreshedProject });
      return res.status(201).json({ command });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.get("/projects/:projectId/commands", requirePublicAuth.bind(null, config), (req, res) => {
    try {
      const commands = store.listCommands(req.params.projectId, req.query.after || "");
      return res.json({ commands });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.post("/projects/:projectId/commands/:commandId/ack", requirePublicAuth.bind(null, config), (req, res) => {
    try {
      const command = store.ackCommand(req.params.projectId, req.params.commandId);
      const project = store.getProject(req.params.projectId);
      broker.publish({ type: "project.updated", project });
      return res.json({ command });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.post("/projects/:projectId/commands/cancel-open", requirePublicAuth.bind(null, config), (req, res) => {
    try {
      const commands = store.cancelOpenCommands(req.params.projectId);
      if (commands.length) {
        store.appendMessage(req.params.projectId, {
          role: "system",
          text: `已取消 ${commands.length} 条未完成工作。`,
          source: "web",
          status: "idle",
        });
      }
      const project = store.getProject(req.params.projectId);
      broker.publish({ type: "project.updated", project });
      return res.json({ commands, project });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.post("/bridge/projects/upsert", requireBridgeAuth.bind(null, config), (req, res) => {
    const project = store.upsertProject(req.body || {});
    broker.publish({ type: "project.updated", project });
    res.status(201).json({ project });
  });

  router.post("/bridge/projects/sync", requireBridgeAuth.bind(null, config), (req, res) => {
    const projects = Array.isArray(req.body?.projects) ? req.body.projects : [];
    const synced = store.syncProjects(projects);
    broker.publish({ type: "snapshot", projects: synced, appName: config.appName });
    res.status(200).json({ projects: synced });
  });

  router.post("/bridge/projects/:projectId/events", requireBridgeAuth.bind(null, config), (req, res) => {
    try {
      const message = store.appendMessage(req.params.projectId, req.body || {});
      const project = store.getProject(req.params.projectId);
      broker.publish({ type: "message.created", project, message });
      broker.publish({ type: "project.updated", project });
      return res.status(201).json({ message });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.get("/bridge/projects/:projectId/commands", requireBridgeAuth.bind(null, config), (req, res) => {
    try {
      const commands = store.listCommands(req.params.projectId, req.query.after || "");
      return res.json({ commands });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.post(
    "/bridge/projects/:projectId/commands/:commandId/ack",
    requireBridgeAuth.bind(null, config),
    (req, res) => {
      try {
        const command = store.ackCommand(req.params.projectId, req.params.commandId);
        const project = store.getProject(req.params.projectId);
        broker.publish({ type: "project.updated", project });
        return res.json({ command });
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }
  );

  router.get(
    "/bridge/projects/:projectId/commands/:commandId",
    requireBridgeAuth.bind(null, config),
    (req, res) => {
      try {
        const command = store.getCommand(req.params.projectId, req.params.commandId);
        if (!command) {
          return res.status(404).json({ error: "Command not found." });
        }
        return res.json({ command });
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }
  );

  router.post(
    "/bridge/projects/:projectId/commands/:commandId/status",
    requireBridgeAuth.bind(null, config),
    (req, res) => {
      try {
        const command = store.setCommandStatus(
          req.params.projectId,
          req.params.commandId,
          req.body?.status,
          req.body?.meta || {}
        );
        const project = store.getProject(req.params.projectId);
        broker.publish({ type: "project.updated", project });
        return res.json({ command });
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }
  );

  return router;
}
