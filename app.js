require("dotenv").config();
require("./path");

const { connect, close } = require("services/db");
const { startWorker } = require("./worker");

async function main() {
    console.log("[alert] starting");
    await connect();
    const stop = startWorker(process.argv[2] || process.env.WORKER_ROLE || "all");
    let stopping = false;
    async function shutdown() {
        if (stopping) return;
        stopping = true;
        await stop();
        await close();
    }
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}

main().catch(err => {
    console.error("[alert] failed to start:", err.message);
    process.exit(1);
});
