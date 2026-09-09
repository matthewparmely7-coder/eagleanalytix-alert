require("dotenv").config();
require("./path");

const { startWorker } = require("./worker");

// Separate Event Alerts worker.
// Does not change eagleanalytix_cron or eagleanalytix-backend.
// Later: persist hits to Mongo. Not wired yet.

console.log("[alert] starting");
startWorker();
