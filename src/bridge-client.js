import { startBridge } from "./bridge-lib.js";

startBridge().catch((error) => {
  console.error(error);
  process.exit(1);
});
