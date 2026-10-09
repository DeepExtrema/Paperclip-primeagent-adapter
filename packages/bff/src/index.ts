#!/usr/bin/env node
import { startStandalone } from "./server.js";

if (process.argv.length !== 4 || process.argv[2] !== "--config") {
  console.error("Usage: paperclip-primeagent-bff --config /absolute/private/config.json");
  process.exitCode = 2;
} else {
  try {
    await startStandalone(process.argv[3]!);
  } catch (error) {
    console.error("Prime BFF could not start:", error);
    process.exitCode = 1;
  }
}
