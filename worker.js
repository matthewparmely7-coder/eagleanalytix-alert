const CronJob = require("cron").CronJob;
const watchlist = require("services/watchlist");

const TICK_MS = parseInt(process.env.TICK_MS, 10) || 60 * 1000;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE, 10) || 8;
const DAILY_LIST_HOUR = Math.min(Math.max(parseInt(process.env.DAILY_LIST_HOUR, 10) || 0, 0), 23);
const DAILY_LIST_MINUTE = Math.min(Math.max(parseInt(process.env.DAILY_LIST_MINUTE, 10) || 10, 0), 59);
const TIMEZONE = (process.env.TIMEZONE || "America/New_York").trim();
const DAILY_CRON = `${DAILY_LIST_MINUTE} ${DAILY_LIST_HOUR} * * *`;

async function pullWatchlist() {
    try {
        const { added, skipped, vsMatched, shMatched, passedCount, from, to, listedOn } = await watchlist.pullWatchlist();
        console.log(
            `[alert] daily list ${listedOn}: added ${added}, already stored ${skipped}, VS ${vsMatched}, SH ${shMatched}, marked passed ${passedCount}  ${from.toISOString()} – ${to.toISOString()}`
        );
    } catch (err) {
        console.error("[alert] daily list failed:", err.message);
    }
}

async function refreshHistory() {
    try {
        const { processed, reset, passedCount, cycleDone } = await watchlist.refreshHistoryBatch(BATCH_SIZE);
        if (passedCount) {
            console.log(`[alert] marked ${passedCount} events passed`);
        }
        if (cycleDone) {
            console.log("[alert] no open events; history worker idle");
            return;
        }
        if (reset) {
            console.log("[alert] history cycle complete; reset historyUpdated");
        }
        console.log(`[alert] history batch ${processed}`);
    } catch (err) {
        console.error("[alert] history batch failed:", err.message);
    }
}

function startWorker() {
    const job = new CronJob(DAILY_CRON, pullWatchlist, null, true, TIMEZONE);
    console.log(`[alert] daily event list at ${String(DAILY_LIST_HOUR).padStart(2, "0")}:${String(DAILY_LIST_MINUTE).padStart(2, "0")} ${TIMEZONE}`);
    if (job.nextDate) {
        console.log("[alert] next daily list:", job.nextDate().toString());
    }
    console.log(`[alert] history worker every ${TICK_MS}ms, batch ${BATCH_SIZE}`);
    pullWatchlist();
    refreshHistory();
    setInterval(refreshHistory, TICK_MS);
}

module.exports = { startWorker };
