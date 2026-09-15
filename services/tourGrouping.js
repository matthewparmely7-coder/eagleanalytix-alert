const { hash, splitRuns } = require("./seriesGrouping");
function tourKey(event) {
    const title = String(event.eventName || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    // Artist mappings also contain parking, upgrades and bundles; those are not performances.
    if (!event.eligible || !event.artistID || !/\btour\b/.test(title)
        || /\b(parking|premium|vip|upgrade|package|bundle|pass|hospitality|soundcheck)\b/.test(title)) return null;
    return hash([event.artistID, title]);
}
function groupTours(events, gapDays = 30) {
    const groups = new Map();
    for (const event of events) { const key = tourKey(event); if (key) { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(event); } }
    return [...groups].flatMap(([groupKey, members]) => splitRuns(members, gapDays)
        .filter(run => run.length >= 2 && new Set(run.map(e => e.location)).size >= 2)
        .map(events => ({ groupKey, events })));
}
module.exports = { tourKey, groupTours };
