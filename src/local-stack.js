import { startServer } from "./server.js";
import { startBridge } from "./bridge-lib.js";

try {
  await startServer();
  await startBridge();
  console.log("Local stack ready.");
} catch (error) {
  console.error(error);
  process.exit(1);
}
