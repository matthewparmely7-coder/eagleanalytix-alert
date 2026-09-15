const fs = require("fs");
const path = require("path");
const { getWatchlistModel } = require("services/db");
const { detectAll } = require("patterns/detect");
const { thresholds } = require("patterns/detect/thresholds");
const { hash } = require("./seriesGrouping");
const folder = path.join(__dirname, "../patterns/detect");
const VERSION = hash([thresholds(), fs.readdirSync(folder).filter(name => name.endsWith(".js")).sort()
    .map(name => fs.readFileSync(path.join(folder, name), "utf8"))]);

function revisionFilter(event) {
    return { eventID: event.eventID, historyRevision: event.historyRevision == null ? { $exists: false } : event.historyRevision,
        UTCEventDate: event.UTCEventDate, timezone: event.timezone == null ? null : event.timezone };
}

async function evaluateBatch(batchSize, check = () => {}) {
    const model = getWatchlistModel(), now = new Date();
    const batch = await model.find({ $or: [
        { patternNextAt: null }, { patternNextAt: { $lte: now } }, { patternRulesVersion: { $ne: VERSION } }
    ] }).sort({ patternNextAt: 1, UTCEventDate: 1 }).limit(batchSize).lean();
    let processed = 0;
    for (const event of batch) {
        check();
        const passed = event.UTCEventDate && +new Date(event.UTCEventDate) < +now;
        const patterns = passed ? {} : detectAll(event.history, event.vsHistory, event.shHistory,
            { eventDate: event.UTCEventDate, timezone: event.timezone });
        const interval = Math.max(Number(process.env.PATTERN_RECHECK_MS) || 900000, 1000);
        // Recheck old events daily for date corrections; new history always resets this deadline.
        const next = new Date(+now + (passed ? 86400000 : interval));
        const result = await model.updateOne(revisionFilter(event), { $set: {
            patterns, patternHistoryRevision: event.historyRevision || 0, patternRulesVersion: VERSION,
            patternEvaluatedAt: now, patternNextAt: next
        } });
        if (result.modifiedCount) processed++;
    }
    return processed;
}
module.exports = { evaluateBatch, revisionFilter };
