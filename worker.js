const CronJob = require("cron").CronJob;
const supplyChange = require("patterns/supplyChange");

const TICK_MS = parseInt(process.env.TICK_MS, 10) || 60 * 1000;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE, 10) || 8;
const DAILY_LIST_HOUR = Math.min(Math.max(parseInt(process.env.DAILY_LIST_HOUR, 10) || 0, 0), 23);
const DAILY_LIST_MINUTE = Math.min(Math.max(parseInt(process.env.DAILY_LIST_MINUTE, 10) || 10, 0), 59);
const TIMEZONE = (process.env.TIMEZONE || "America/New_York").trim();
const DAILY_CRON = `${DAILY_LIST_MINUTE} ${DAILY_LIST_HOUR} * * *`;

async function pullTomorrowEvents() {
    try {
        const { added, skipped, vsMatched, from, to, targetUtcDate } = await supplyChange.pullTomorrowEvents();
        console.log(
            `[supply_change_40] daily list UTC ${targetUtcDate}: added ${added}, already stored ${skipped}, VS matched ${vsMatched}  ${from.toISOString()} – ${to.toISOString()}`
        );
    } catch (err) {
        console.error("[supply_change_40] daily pull failed:", err.message);
    }
}

async function refreshHistory() {
    try {
        const { processed, reset, passedCount, cycleDone } = await supplyChange.refreshHistoryBatch(BATCH_SIZE);
        if (passedCount) {
            console.log(`[supply_change_40] marked ${passedCount} events passed`);
        }
        if (cycleDone) {
            console.log("[supply_change_40] no open events; history worker idle");
            return;
        }
        if (reset) {
            console.log("[supply_change_40] history cycle complete; reset historyUpdated");
        }
        console.log(`[supply_change_40] history batch ${processed}`);
    } catch (err) {
        console.error("[supply_change_40] history batch failed:", err.message);
    }
}

function startWorker() {
    const job = new CronJob(DAILY_CRON, pullTomorrowEvents, null, true, TIMEZONE);
    console.log(`[alert] daily event list at ${String(DAILY_LIST_HOUR).padStart(2, "0")}:${String(DAILY_LIST_MINUTE).padStart(2, "0")} ${TIMEZONE}`);
    if (job.nextDate) {
        console.log("[alert] next daily list:", job.nextDate().toString());
    }
    console.log(`[alert] history worker every ${TICK_MS}ms, batch ${BATCH_SIZE}`);
    pullTomorrowEvents();
    refreshHistory();
    setInterval(refreshHistory, TICK_MS);
}

module.exports = { startWorker };
