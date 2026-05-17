import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

function parseEnvFile(envPath) {
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

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(moduleDir, "..");
parseEnvFile(path.join(rootDir, ".env"));

const dataDir = process.env.DATA_DIR || path.join(rootDir, "data");
fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  rootDir,
  publicDir: path.join(rootDir, "public"),
  dataDir,
  port: Number(process.env.PORT || 8787),
  appName: process.env.APP_NAME || "Codex Mobile Relay",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  publicAccessToken: process.env.PUBLIC_ACCESS_TOKEN || "",
  bridgeSharedSecret: process.env.BRIDGE_SHARED_SECRET || "",
};
