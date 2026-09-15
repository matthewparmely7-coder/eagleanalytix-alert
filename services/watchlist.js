const moment = require("moment-timezone");
const { getTmEventsModel, getEventMatchModel, getWatchlistModel, getSeriesModel, getTourModel } = require("services/db");
const { readTicketInfo } = require("services/s3");
const { hash } = require("./seriesGrouping");

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

function historyFromDate(event) {
    // Earlier concerts retain the lead-up to their own date, even in long residencies.
    const anchor = event.seriesTracked && +new Date(event.UTCEventDate) < Date.now()
        ? moment(event.UTCEventDate).tz(event.timezone || TIMEZONE) : moment.tz(TIMEZONE);
    return anchor.startOf("day").subtract(HISTORY_LOOKBACK_DAYS, "day").toDate();
}

function asArray(data) {
    return Array.isArray(data) ? data : [];
}

async function withTimeout(task, ms) {
    let timer;
    const controller = new AbortController();
    try { return await Promise.race([task(controller.signal), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("S3 history timeout")); }, ms);
    })]); } finally { clearTimeout(timer); }
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

function ticketResale(row, source) {
    if (source !== "tm") {
        return NaN;
    }
    const info = row && row.ticketinfo;
    if (!info) {
        return NaN;
    }
    return parseFloat(info.resale);
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
    return (
        row &&
        row.timestamp != null &&
        (row.primary != null || row.resale != null || row.minPrice != null)
    );
}

function normalizePoint(row, prev) {
    const prevRow = prev || {};
    const point = {
        timestamp: Number(row.timestamp),
        primary: row.primary != null ? row.primary : prevRow.primary != null ? prevRow.primary : null,
        minPrice: row.minPrice != null ? row.minPrice : prevRow.minPrice != null ? prevRow.minPrice : null
    };
    // Keep resale when present on either side so legacy {primary,minPrice} rows still merge.
    const resale = row.resale != null ? row.resale : prevRow.resale != null ? prevRow.resale : null;
    if (resale != null) {
        point.resale = resale;
    }
    for (const field of ["resaleMinPrice", "primaryMinPrice"]) {
        if (Object.prototype.hasOwnProperty.call(row, field)) point[field] = row[field];
        else if (prevRow[field] != null) point[field] = prevRow[field];
    }
    return point;
}

function mergeSnapshots(lists, source) {
    const byTs = new Map();
    for (const list of lists) {
        for (const row of asArray(list)) {
            if (!row || row.timestamp == null) continue;
            const ts = Number(row.timestamp);
            if (!Number.isFinite(ts) || byTs.has(ts)) continue;
            const primary = finiteOrNull(ticketCount(row, source));
            const resale = finiteOrNull(ticketResale(row, source));
            const minPrice = finiteOrNull(ticketMinPrice(row, source));
            if (primary == null && resale == null && minPrice == null) continue;
            const point = { timestamp: ts, primary, minPrice };
            if (source === "tm") {
                const resalePrice = parseFloat(row.ticketinfo.resale_minPrice);
                const primaryPrice = parseFloat(row.ticketinfo.primary_minPrice);
                point.resaleMinPrice = resalePrice > 0 ? finiteOrNull(resalePrice) : null;
                point.primaryMinPrice = primaryPrice > 0 ? finiteOrNull(primaryPrice) : null;
            }
            if (source === "tm" && resale != null) {
                point.resale = resale;
            }
            byTs.set(ts, point);
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
        byTs.set(ts, normalizePoint(row, byTs.get(ts)));
    }
    return Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
}

async function readS3History(eventID, folders, source, fromDate) {
    if (!eventID) {
        return [];
    }
    const lists = [];
    for (const folder of folders) {
        lists.push(asArray(await withTimeout(signal => readTicketInfo(`${eventID}.json`, folder, signal), S3_TIMEOUT_MS)));
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
    const fromDate = historyFromDate(event);
    const points = await readS3History(event.eventID, ["tm-special", "tm-daily"], "tm", fromDate);
    return sinceLookback(appendHistory(event.history, points), fromDate);
}

async function loadSiteHistory(event, idField, historyField, folders, source) {
    const fromDate = historyFromDate(event);
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
                const set = { timezone: timezoneOf(event), UTCEventDate: event.UTCEventDate,
                    eventName: (event.eventinfo && event.eventinfo.name) || "",
                    venue: (event.eventinfo && event.eventinfo.venues && event.eventinfo.venues.name) || "",
                    passed: false };
                const vsEventID = vsByTm.get(event.eventID), shEventID = shByTm.get(event.eventID);
                if (vsEventID) set.vsEventID = vsEventID;
                if (shEventID) set.shEventID = shEventID;
                return watchlist.updateOne({ eventID: event.eventID }, { $set: set });
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
        await watchlist.bulkWrite(fresh.map(event => ({ updateOne: {
            filter: { eventID: event.eventID }, update: { $setOnInsert: event }, upsert: true
        } })));
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

async function refreshHistoryBatch(batchSize, check = () => {}) {
    const model = getWatchlistModel();
    const passedCount = await markPassedEvents();
    const refreshMs = Math.max(Number(process.env.HISTORY_REFRESH_MS) || 300000, 1000);
    const batch = await model.find({
        $and: [
            { $or: [{ passed: { $ne: true } }, { seriesTracked: true }, { tourTracked: true }] },
            { $or: [{ historyNextAt: null }, { historyNextAt: { $lte: new Date() } }] }
        ]
    }).sort({ historyNextAt: 1, UTCEventDate: 1 }).limit(batchSize).lean();
    const needMatch = batch.filter(event => !event.vsEventID || !event.shEventID).map(event => event.eventID);
    const { vs: vsByTm, sh: shByTm } = await matchesByTm(needMatch);
    let processed = 0;
    // Bounded by batchSize. Wait for every write before releasing the worker lease.
    const results = await Promise.allSettled(batch.map(async event => {
        check();
        // Back off failed events as well, so an unavailable S3 object cannot starve the queue.
        await model.updateOne({ eventID: event.eventID }, { $set: {
            historyAttemptAt: new Date(), historyNextAt: new Date(Date.now() + refreshMs)
        } });
        const vsEventID = event.vsEventID || vsByTm.get(event.eventID) || "";
        const shEventID = event.shEventID || shByTm.get(event.eventID) || "";
        const withIds = { ...event, vsEventID, shEventID };
        const [history, vsResult, shResult] = await Promise.all([
            loadTmHistory(withIds),
            loadSiteHistory(withIds, "vsEventID", "vsHistory", ["vs-special", "vs-daily"], "vs"),
            loadSiteHistory(withIds, "shEventID", "shHistory", ["sh-special", "sh-daily"], "sh")
        ]);
        const vsHistory = vsResult.history, shHistory = shResult.history;
        const fingerprint = hash([history, vsHistory, shHistory]);
        const changed = fingerprint !== event.historyFingerprint;
        const set = { historyPulledAt: new Date(), historyUpdated: true };
        if (vsEventID) set.vsEventID = vsEventID;
        if (shEventID) set.shEventID = shEventID;
        if (changed) Object.assign(set, { history, vsHistory, shHistory, historyFingerprint: fingerprint, patternNextAt: new Date(0), resaleDemandNextAt: new Date(0), resaleDemandExpiresAt: new Date(0) });
        check();
        await model.updateOne({ eventID: event.eventID }, { $set: set, ...(changed ? { $inc: { historyRevision: 1 } } : {}) });
        if (changed) await model.updateMany({ 'resaleDemand.peers.eventID': event.eventID }, {
            $set: { resaleDemandNextAt: new Date(0), resaleDemandExpiresAt: new Date(0) }, $inc: { resaleDemandGeneration: 1 }
        });
        if (changed) await getSeriesModel().updateMany({ active: true, eventIDs: event.eventID }, {
            $set: { demandInputKey: null, demandExpiresAt: new Date(0) }, $inc: { demandGeneration: 1 }
        });
        if (changed) await getTourModel().updateMany({ active: true, eventIDs: event.eventID }, {
            $set: { demandInputKey: null, demandExpiresAt: new Date(0) }, $inc: { demandGeneration: 1 }
        });
        processed++;
    }));
    for (const result of results) if (result.status === "rejected") console.error(`[history] ${result.reason.message}`);
    return { processed, passedCount, reset: false, cycleDone: !batch.length };
}

module.exports = { pullWatchlist, refreshHistoryBatch, mergeSnapshots, appendHistory };
