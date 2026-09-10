const moment = require("moment-timezone");
const { getTmEventsModel, getEventMatchModel, getSupplyChangeEventModel } = require("services/db");
const { readTicketInfo } = require("services/s3");

const TIMEZONE = (process.env.TIMEZONE || "America/New_York").trim();
const S3_TIMEOUT_MS = parseInt(process.env.S3_TIMEOUT_MS, 10) || 15000;
const HISTORY_LOOKBACK_DAYS = Math.max(parseInt(process.env.HISTORY_LOOKBACK_DAYS, 10) || 1, 1);

function tomorrowUtcBounds() {
    const tomorrow = moment.utc().add(1, "day").startOf("day");
    return {
        from: tomorrow.toDate(),
        to: tomorrow.clone().add(1, "day").toDate(),
        targetUtcDate: tomorrow.format("YYYY-MM-DD")
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
    return parseFloat(info.primary);
}

function mergeSnapshots(lists, source) {
    const byTs = new Map();
    for (const list of lists) {
        for (const row of asArray(list)) {
            if (!row || row.timestamp == null) continue;
            const ts = Number(row.timestamp);
            if (!Number.isFinite(ts) || byTs.has(ts)) continue;
            const primary = ticketCount(row, source);
            byTs.set(ts, {
                timestamp: ts,
                primary: Number.isFinite(primary) ? primary : null
            });
        }
    }
    return Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
}

async function readS3History(eventID, folders, source, fromDate) {
    const { points } = await readS3HistoryDetailed(eventID, folders, source, fromDate);
    return points;
}

async function readS3HistoryDetailed(eventID, folders, source, fromDate) {
    const folderCounts = {};
    if (!eventID) {
        for (const folder of folders) {
            folderCounts[folder] = 0;
        }
        return { points: [], folderCounts };
    }
    const lists = [];
    for (const folder of folders) {
        const rows = asArray(await withTimeout(readTicketInfo(`${eventID}.json`, folder), S3_TIMEOUT_MS));
        folderCounts[folder] = rows.length;
        lists.push(rows);
    }
    const points = mergeSnapshots(lists, source).filter(row => row.timestamp >= fromDate.getTime() && row.primary != null);
    return { points, folderCounts };
}

function readTmHistory(eventID, fromDate) {
    return readS3History(eventID, ["tm-special", "tm-daily"], "tm", fromDate);
}

function readVsHistory(eventID, fromDate) {
    return readS3History(eventID, ["vs-special", "vs-daily"], "vs", fromDate);
}

function sinceLookback(history, fromDate) {
    const fromTs = fromDate.getTime();
    return asArray(history).filter(row => row && Number(row.timestamp) >= fromTs && row.primary != null);
}

function appendHistory(existing, newer) {
    const byTs = new Map();
    for (const row of [...asArray(existing), ...asArray(newer)]) {
        if (!row || row.timestamp == null || row.primary == null) continue;
        const ts = Number(row.timestamp);
        if (!Number.isFinite(ts) || byTs.has(ts)) continue;
        byTs.set(ts, { timestamp: ts, primary: row.primary });
    }
    return Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
}

async function loadWindowHistory(existing, fetchHistory) {
    const fromDate = historyFromDate();
    const fetched = await fetchHistory(fromDate);
    return sinceLookback(appendHistory(existing, fetched), fromDate);
}

async function vsIdsByTm(eventIDs) {
    const ids = eventIDs.filter(Boolean);
    if (!ids.length) {
        return new Map();
    }
    const matches = await getEventMatchModel()
        .find({ tmEventID: { $in: ids } }, { tmEventID: 1, vsEventID: 1 })
        .lean()
        .maxTimeMS(15000);
    const map = new Map();
    for (const row of matches) {
        if (row.tmEventID && row.vsEventID) {
            map.set(String(row.tmEventID), String(row.vsEventID));
        }
    }
    return map;
}

async function loadHistoryForEvent(event) {
    return loadWindowHistory(event.history, fromDate => readTmHistory(event.eventID, fromDate));
}

async function loadVsHistoryForEvent(event) {
    const vsEventID = event.vsEventID && String(event.vsEventID).trim();
    const fromDate = historyFromDate();
    if (!vsEventID) {
        return {
            history: sinceLookback(event.vsHistory, fromDate),
            vsEventID: "",
            folderCounts: { "vs-special": 0, "vs-daily": 0 }
        };
    }
    const { points, folderCounts } = await readS3HistoryDetailed(vsEventID, ["vs-special", "vs-daily"], "vs", fromDate);
    return {
        history: sinceLookback(appendHistory(event.vsHistory, points), fromDate),
        vsEventID,
        folderCounts
    };
}


async function pullTomorrowEvents() {
    const { from, to, targetUtcDate } = tomorrowUtcBounds();
    const tmEventsModel = getTmEventsModel();
    const supplyChangeEventModel = getSupplyChangeEventModel();

    const events = await tmEventsModel
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
    const vsByTm = await vsIdsByTm(ids);
    const existing = ids.length
        ? await supplyChangeEventModel.find({ eventID: { $in: ids } }, { eventID: 1 }).lean()
        : [];
    const have = new Set(existing.map(row => row.eventID));

    const pulledAt = new Date();
    const timezoneOf = event =>
        (event.eventinfo && event.eventinfo.dates && event.eventinfo.dates.timezone) || "America/New_York";

    await Promise.all(
        events
            .filter(event => event.eventID && have.has(event.eventID))
            .map(event => {
                const vsEventID = vsByTm.get(event.eventID) || "";
                const set = { timezone: timezoneOf(event) };
                if (vsEventID) {
                    set.vsEventID = vsEventID;
                }
                return supplyChangeEventModel.updateOne(
                    {
                        eventID: event.eventID,
                        $or: [
                            { timezone: { $exists: false } },
                            { timezone: "" },
                            { timezone: null },
                            { vsEventID: { $exists: false } },
                            { vsEventID: "" },
                            { vsEventID: null }
                        ]
                    },
                    { $set: set }
                );
            })
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
            targetUtcDate,
            pulledAt,
            passed: false,
            historyUpdated: false,
            history: []
        }));

    if (fresh.length) {
        await supplyChangeEventModel.insertMany(fresh);
    }

    await supplyChangeEventModel.updateMany(
        {
            passed: { $ne: true },
            vsEventID: { $exists: true, $nin: [null, ""] }
        },
        { $set: { historyUpdated: false } }
    );

    return { added: fresh.length, skipped: have.size, vsMatched: vsByTm.size, from, to, targetUtcDate };
}

async function markPassedEvents() {
    const result = await getSupplyChangeEventModel().updateMany(
        { passed: { $ne: true }, UTCEventDate: { $lt: new Date() } },
        { $set: { passed: true } }
    );
    return result.modifiedCount || 0;
}

async function refreshHistoryBatch(batchSize) {
    const model = getSupplyChangeEventModel();
    const passedCount = await markPassedEvents();
    let batch = await model
        .find({ passed: { $ne: true }, historyUpdated: { $ne: true } })
        .sort({ UTCEventDate: 1 })
        .limit(batchSize)
        .lean();

    let reset = false;
    if (!batch.length) {
        const open = await model.countDocuments({ passed: { $ne: true } });
        if (!open) {
            return { processed: 0, reset, passedCount, cycleDone: true };
        }
        // Reset only events that are not passed.
        await model.updateMany({ passed: { $ne: true } }, { $set: { historyUpdated: false } });
        reset = true;
        batch = await model
            .find({ passed: { $ne: true }, historyUpdated: { $ne: true } })
            .sort({ UTCEventDate: 1 })
            .limit(batchSize)
            .lean();
    }

    const pulledAt = new Date();
    const missingVs = batch.filter(event => !event.vsEventID).map(event => event.eventID);
    const vsByTm = await vsIdsByTm(missingVs);

    await Promise.all(
        batch.map(async event => {
            const vsEventID = event.vsEventID || vsByTm.get(event.eventID) || "";
            const withVs = { ...event, vsEventID };
            const [history, vsResult] = await Promise.all([loadHistoryForEvent(withVs), loadVsHistoryForEvent(withVs)]);
            const vsHistory = vsResult.history;
            const specialCount = vsResult.folderCounts["vs-special"] || 0;
            const dailyCount = vsResult.folderCounts["vs-daily"] || 0;
            if (!vsResult.vsEventID) {
                console.log(`[supply_change_40] ${event.eventID} no VS match; TM points ${history.length}`);
            } else if (!specialCount && !dailyCount) {
                console.log(`[supply_change_40] ${event.eventID} VS ${vsResult.vsEventID} no vs-special/vs-daily file; TM points ${history.length}`);
            } else {
                console.log(
                    `[supply_change_40] ${event.eventID} VS ${vsResult.vsEventID} special=${specialCount} daily=${dailyCount} inWindow=${vsHistory.length} TM=${history.length}`
                );
            }
            const set = {
                history,
                vsHistory,
                historyUpdated: true,
                historyPulledAt: pulledAt
            };
            if (vsEventID) {
                set.vsEventID = vsEventID;
            }
            await model.updateOne({ eventID: event.eventID }, { $set: set });
        })
    );

    return { processed: batch.length, reset, passedCount, cycleDone: false };
}

module.exports = {
    pullTomorrowEvents,
    refreshHistoryBatch
};
