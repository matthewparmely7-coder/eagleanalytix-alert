const { PATTERN_IDS } = require("patterns");

const TICK_MS = parseInt(process.env.TICK_MS, 10) || 60 * 1000;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE, 10) || 20;

function startWorker() {
    console.log(`[alert] tick every ${TICK_MS}ms, batch ${BATCH_SIZE}`);
    console.log(`[alert] patterns: ${PATTERN_IDS.join(", ")}`);
    tick();
    setInterval(tick, TICK_MS);
}

async function tick() {
    const at = new Date().toISOString();
    console.log(`[alert] tick ${at}`);

    // 1. Pick next batch of candidate events (not every event).
    // 2. Read S3 history only for that batch.
    // 3. Run pattern checks.
    // 4. Store hits (Mongo later).
}

module.exports = { startWorker };
