import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { Store } from "./store.js";
import { Broker } from "./broker.js";
import { createApiRouter } from "./routes.js";

export function createServerRuntime() {
  const store = new Store(config.dataDir);
  const broker = new Broker();

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter({ config, store, broker }));
  app.use(express.static(config.publicDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(config.publicDir, "index.html"));
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const token = new URL(req.url || "/", "http://localhost").searchParams.get("access_token") || "";
    if (config.publicAccessToken && token !== config.publicAccessToken) {
      ws.close(1008, "Unauthorized");
      return;
    }

    broker.attachWebSocket(ws);
    ws.send(
      JSON.stringify({
        type: "snapshot",
        projects: store.listProjects(),
        appName: config.appName,
      })
    );
  });

  return { app, server, store, broker, wss };
}

export async function startServer() {
  const runtime = createServerRuntime();
  await new Promise((resolve) => {
    runtime.server.listen(config.port, "0.0.0.0", resolve);
  });
  console.log(`${config.appName} listening on port ${config.port}`);
  return runtime;
}

const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";

if (import.meta.url === entryHref) {
  startServer();
}
