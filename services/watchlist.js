const moment = require("moment-timezone");
const { getTmEventsModel, getEventMatchModel, getWatchlistModel } = require("services/db");
const { readTicketInfo } = require("services/s3");
const { detectAll } = require("patterns/detect");

const TIMEZONE = (process.env.TIMEZONE || "America/New_York").trim();
const S3_TIMEOUT_MS = parseInt(process.env.S3_TIMEOUT_MS, 10) || 15000;
const HISTORY_LOOKBACK_DAYS = Math.max(parseInt(process.env.HISTORY_LOOKBACK_DAYS, 10) || 60, 1);
const WATCHLIST_DAYS = Math.max(parseInt(process.env.WATCHLIST_DAYS, 10) || 21, 1);

function watchlistBounds() {
    const now = new Date();
    const to = moment.tz(TIMEZONE).startOf("day").add(WATCHLIST_DAYS, "day");
    return {
        from: now,
        to: to.toDate(),
        listedOn: moment.tz(TIMEZONE).format("YYYY-MM-DD")
    };
}

function historyFromDate() {
    return moment.tz(TIMEZONE).startOf("day").subtract(HISTORY_LOOKBACK_DAYS, "day").toDate();
}

function asArray(data) {
    return Array.isArray(data) ? data : [];
}

function withTimeout(promise, ms) {
    return Promise.race([
        Promise.resolve(promise).catch(() => []),
        new Promise(resolve => setTimeout(() => resolve([]), ms))
    ]);
}

function ticketCount(row, source) {
    const info = row && row.ticketinfo;
    if (!info) {
        return NaN;
    }
    if (source === "vs") {
        return parseFloat(info.ticketCount);
    }
    if (source === "sh") {
        return parseFloat(info.totalTickets);
    }
    return parseFloat(info.primary);
}

function ticketMinPrice(row, source) {
    const info = row && row.ticketinfo;
    if (!info) {
        return NaN;
    }
    if (source === "vs") {
        return parseFloat(info.minPrice);
    }
    if (source === "sh") {
        return parseFloat(info.pricingSummary && info.pricingSummary.min);
    }
    const resale = parseFloat(info.resale_minPrice);
    if (Number.isFinite(resale) && resale > 0) {
        return resale;
    }
    const primary = parseFloat(info.primary_minPrice);
    return Number.isFinite(primary) && primary > 0 ? primary : NaN;
}

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

function keepPoint(row) {
    return row && row.timestamp != null && (row.primary != null || row.minPrice != null);
}

function mergeSnapshots(lists, source) {
    const byTs = new Map();
    for (const list of lists) {
        for (const row of asArray(list)) {
            if (!row || row.timestamp == null) continue;
            const ts = Number(row.timestamp);
            if (!Number.isFinite(ts) || byTs.has(ts)) continue;
            const primary = finiteOrNull(ticketCount(row, source));
            const minPrice = finiteOrNull(ticketMinPrice(row, source));
            if (primary == null && minPrice == null) continue;
            byTs.set(ts, { timestamp: ts, primary, minPrice });
        }
    }
    return Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function sinceLookback(history, fromDate) {
    const fromTs = fromDate.getTime();
    return asArray(history).filter(row => keepPoint(row) && Number(row.timestamp) >= fromTs);
}

function appendHistory(existing, newer) {
    const byTs = new Map();
    for (const row of [...asArray(existing), ...asArray(newer)]) {
        if (!keepPoint(row)) continue;
        const ts = Number(row.timestamp);
        if (!Number.isFinite(ts)) continue;
        const prev = byTs.get(ts);
        byTs.set(ts, {
            timestamp: ts,
            primary: row.primary != null ? row.primary : prev && prev.primary,
            minPrice: row.minPrice != null ? row.minPrice : prev && prev.minPrice
        });
    }
    return Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
}

async function readS3History(eventID, folders, source, fromDate) {
    if (!eventID) {
        return [];
    }
    const lists = [];
    for (const folder of folders) {
        lists.push(asArray(await withTimeout(readTicketInfo(`${eventID}.json`, folder), S3_TIMEOUT_MS)));
    }
    return mergeSnapshots(lists, source).filter(row => row.timestamp >= fromDate.getTime());
}

async function matchesByTm(eventIDs) {
    const ids = eventIDs.filter(Boolean);
    const vs = new Map();
    const sh = new Map();
    if (!ids.length) {
        return { vs, sh };
    }
    const matches = await getEventMatchModel()
        .find({ tmEventID: { $in: ids } }, { tmEventID: 1, vsEventID: 1, shEventID: 1 })
        .lean()
        .maxTimeMS(15000);
    for (const match of matches) {
        if (!match.tmEventID) continue;
        const tmId = String(match.tmEventID);
        if (match.vsEventID) {
            vs.set(tmId, String(match.vsEventID));
        }
        if (match.shEventID) {
            sh.set(tmId, String(match.shEventID));
        }
    }
    return { vs, sh };
}

async function loadTmHistory(event) {
    const fromDate = historyFromDate();
    const points = await readS3History(event.eventID, ["tm-special", "tm-daily"], "tm", fromDate);
    return sinceLookback(appendHistory(event.history, points), fromDate);
}

async function loadSiteHistory(event, idField, historyField, folders, source) {
    const fromDate = historyFromDate();
    const siteId = event[idField] && String(event[idField]).trim();
    if (!siteId) {
        return { history: sinceLookback(event[historyField], fromDate), siteId: "" };
    }
    const points = await readS3History(siteId, folders, source, fromDate);
    return {
        history: sinceLookback(appendHistory(event[historyField], points), fromDate),
        siteId
    };
}

function timezoneOf(event) {
    return (event.eventinfo && event.eventinfo.dates && event.eventinfo.dates.timezone) || "America/New_York";
}

async function markPassedEvents() {
    const result = await getWatchlistModel().updateMany(
        { passed: { $ne: true }, UTCEventDate: { $lt: new Date() } },
        { $set: { passed: true } }
    );
    return result.modifiedCount || 0;
}

async function pullWatchlist() {
    const passedCount = await markPassedEvents();
    const { from, to, listedOn } = watchlistBounds();
    const watchlist = getWatchlistModel();

    const events = await getTmEventsModel()
        .find(
            { active: true, UTCEventDate: { $gte: from, $lt: to } },
            {
                eventID: 1,
                UTCEventDate: 1,
                "eventinfo.name": 1,
                "eventinfo.venues.name": 1,
                "eventinfo.dates.timezone": 1
            }
        )
        .sort({ UTCEventDate: 1 })
        .lean()
        .maxTimeMS(15000);

    const ids = events.map(event => event.eventID).filter(Boolean);
    const { vs: vsByTm, sh: shByTm } = await matchesByTm(ids);
    const existing = ids.length ? await watchlist.find({ eventID: { $in: ids } }, { eventID: 1 }).lean() : [];
    const have = new Set(existing.map(row => row.eventID));
    const pulledAt = new Date();

    await Promise.all(
        events
            .filter(event => event.eventID && have.has(event.eventID))
            .map(event => {
                const set = { timezone: timezoneOf(event) };
                const vsEventID = vsByTm.get(event.eventID);
                const shEventID = shByTm.get(event.eventID);
                if (vsEventID) {
                    set.vsEventID = vsEventID;
                }
                if (shEventID) {
                    set.shEventID = shEventID;
                }
                if (!vsEventID && !shEventID) {
                    return null;
                }
                return watchlist.updateOne(
                    {
                        eventID: event.eventID,
                        $or: [
                            { vsEventID: { $exists: false } },
                            { vsEventID: "" },
                            { vsEventID: null },
                            { shEventID: { $exists: false } },
                            { shEventID: "" },
                            { shEventID: null }
                        ]
                    },
                    { $set: set }
                );
            })
            .filter(Boolean)
    );

    const fresh = events
        .filter(event => event.eventID && !have.has(event.eventID))
        .map(event => ({
            eventID: event.eventID,
            UTCEventDate: event.UTCEventDate,
            eventName: (event.eventinfo && event.eventinfo.name) || "",
            venue: (event.eventinfo && event.eventinfo.venues && event.eventinfo.venues.name) || "",
            timezone: timezoneOf(event),
            vsEventID: vsByTm.get(event.eventID) || "",
            vsHistory: [],
            shEventID: shByTm.get(event.eventID) || "",
            shHistory: [],
            pulledAt,
            passed: false,
            historyUpdated: false,
            history: [],
            patterns: {}
        }));

    if (fresh.length) {
        await watchlist.insertMany(fresh);
    }

    return {
        added: fresh.length,
        skipped: have.size,
        vsMatched: vsByTm.size,
        shMatched: shByTm.size,
        passedCount,
        from,
        to,
        listedOn
    };
}

async function nextBatch(model, batchSize) {
    return model
        .find({ passed: { $ne: true }, historyUpdated: { $ne: true } })
        .sort({ UTCEventDate: 1 })
        .limit(batchSize)
        .lean();
}

async function refreshHistoryBatch(batchSize) {
    const model = getWatchlistModel();
    const passedCount = await markPassedEvents();
    let batch = await nextBatch(model, batchSize);
    let reset = false;

    if (!batch.length) {
        const open = await model.countDocuments({ passed: { $ne: true } });
        if (!open) {
            return { processed: 0, reset, passedCount, cycleDone: true };
        }
        await model.updateMany({ passed: { $ne: true } }, { $set: { historyUpdated: false } });
        reset = true;
        batch = await nextBatch(model, batchSize);
    }

    const pulledAt = new Date();
    const needMatch = batch.filter(event => !event.vsEventID || !event.shEventID).map(event => event.eventID);
    const { vs: vsByTm, sh: shByTm } = await matchesByTm(needMatch);

    await Promise.all(
        batch.map(async event => {
            const vsEventID = event.vsEventID || vsByTm.get(event.eventID) || "";
            const shEventID = event.shEventID || shByTm.get(event.eventID) || "";
            const withIds = { ...event, vsEventID, shEventID };
            const [history, vsResult, shResult] = await Promise.all([
                loadTmHistory(withIds),
                loadSiteHistory(withIds, "vsEventID", "vsHistory", ["vs-special", "vs-daily"], "vs"),
                loadSiteHistory(withIds, "shEventID", "shHistory", ["sh-special", "sh-daily"], "sh")
            ]);
            const vsHistory = vsResult.history;
            const shHistory = shResult.history;
            const detected = detectAll(history, vsHistory, shHistory, {
                eventDate: event.UTCEventDate,
                timezone: event.timezone
            });
            const patterns = { ...(event.patterns || {}) };
            if (detected.supply_change) {
                patterns.supply_change = detected.supply_change;
            }
            if (detected.u_shaped) {
                patterns.u_shaped = detected.u_shaped;
            }
            if (detected.rocket) {
                patterns.rocket = detected.rocket;
            }
            console.log(
                `[alert] ${event.eventID} TM=${history.length} VS=${vsHistory.length || "none"} SH=${shHistory.length || "none"}`
            );
            const set = {
                history,
                vsHistory,
                shHistory,
                patterns,
                historyUpdated: true,
                historyPulledAt: pulledAt
            };
            if (vsEventID) {
                set.vsEventID = vsEventID;
            }
            if (shEventID) {
                set.shEventID = shEventID;
            }
            await model.updateOne({ eventID: event.eventID }, { $set: set });
        })
    );

    return { processed: batch.length, reset, passedCount, cycleDone: false };
}

module.exports = {
    pullWatchlist,
    refreshHistoryBatch
};
