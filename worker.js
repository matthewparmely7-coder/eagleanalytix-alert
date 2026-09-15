const { schedule } = require("services/workerRunner");
const watchlist = require("services/watchlist");
const { evaluateBatch } = require("services/patterns");
const { evaluateSeriesBatch } = require("services/lastShowDemand");
const { evaluateTourBatch } = require("services/laterTourOpportunity");
const { runTours } = require("services/tours");
const { runSeries } = require("services/series");
const { evaluateDemandBatch } = require("services/lowerResaleDemand");
const { refreshDemandMetadata } = require("services/resaleDemandMetadata");
const positive = (name, fallback) => Math.max(Number(process.env[name]) || fallback, 1);

function startWorker(role = "all") {
    if (!["all", "history", "patterns", "series"].includes(role)) throw new Error(`Unknown worker role: ${role}`);
    const stops = [];
    if (role === "all" || role === "history") stops.push(schedule("resale-demand-metadata", 60000,
        check => refreshDemandMetadata(50, check)));
    if (role === "all" || role === "patterns") stops.push(schedule("lower-resale-demand", positive("PATTERN_TICK_MS", 30000),
        check => evaluateDemandBatch(positive("LOWER_RESALE_BATCH_SIZE", 10), check)));
    if (role === "all" || role === "history") {
        const hour = Math.min(Math.max(parseInt(process.env.DAILY_LIST_HOUR, 10) || 0, 0), 23);
        const rawMinute = parseInt(process.env.DAILY_LIST_MINUTE, 10);
        const minute = Math.min(Math.max(Number.isFinite(rawMinute) ? rawMinute : 10, 0), 59);
        stops.push(schedule("watchlist", { cron: `${minute} ${hour} * * *`, timezone: process.env.TIMEZONE || "America/New_York" },
            () => watchlist.pullWatchlist()));
        stops.push(schedule("history", positive("TICK_MS", 60000), async check => {
            const result = await watchlist.refreshHistoryBatch(positive("BATCH_SIZE", 8), check);
            if (result.processed) console.log(`[history] updated ${result.processed}`);
        }));
    }
    if (role === "all" || role === "patterns") stops.push(schedule("patterns", positive("PATTERN_TICK_MS", 30000), async check => {
        const processed = await evaluateBatch(positive("PATTERN_BATCH_SIZE", 20), check);
        if (processed) console.log(`[patterns] evaluated ${processed}`);
    }));
    if (role === "all" || role === "patterns") stops.push(schedule("last-show-demand", positive("PATTERN_TICK_MS", 30000), async check => {
        const processed = await evaluateSeriesBatch(positive("LAST_SHOW_BATCH_SIZE", 10), check);
        if (processed) console.log(`[last-show-demand] evaluated ${processed}`);
    }));
    if (role === "all" || role === "patterns") stops.push(schedule("later-tour-opportunity", positive("PATTERN_TICK_MS", 30000), async check => {
        const processed = await evaluateTourBatch(positive("LATER_TOUR_BATCH_SIZE", 5), check);
        if (processed) console.log(`[later-tour-opportunity] evaluated ${processed}`);
    }));
    if (role === "all" || role === "series") stops.push(schedule("series", positive("SERIES_TICK_MS", 300000), async check => {
        await runSeries(check); await runTours(check);
    }));
    console.log(`[alert] worker role=${role}`);
    return () => Promise.all(stops.map(stop => stop()));
}
module.exports = { startWorker };
