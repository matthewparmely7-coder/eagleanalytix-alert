require("dotenv").config();
require("./path");

const { connect } = require("services/db");
const { startWorker } = require("./worker");

async function main() {
    console.log("[alert] starting");
    await connect();
    startWorker();
}

main().catch(err => {
    console.error("[alert] failed to start:", err.message);
    process.exit(1);
});
