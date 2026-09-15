const { randomUUID } = require("crypto");
const { getTmEventsModel, getArtistTourModel, getSeriesModel, getSeriesEventModel, getStateModel, getWatchlistModel } = require("services/db");
const { normalizeEvent, eventId, hash, splitRuns, candidateUntil } = require("./seriesGrouping");
const positive = (key, fallback) => Math.max(Number(process.env[key]) || fallback, 1);
const GAP = positive("SERIES_GAP_DAYS", 7);
const HORIZON = positive("SERIES_CANDIDATE_DAYS", 3);
const VERSION = `series-v1:${GAP}:${HORIZON}`;

async function artistMappings() {
    const map = new Map(), ambiguous = new Set();
    const cursor = getArtistTourModel().find({}, { tmArtistID: 1, artistName: 1, "events.eventID": 1, "events.url": 1 }).maxTimeMS(30000).lean().cursor();
    for await (const tour of cursor) {
        if (!tour.tmArtistID) continue;
        for (const event of tour.events || []) {
            const id = eventId(event);
            if (!id || ambiguous.has(id)) continue;
            if (map.has(id) && map.get(id).id !== tour.tmArtistID) { map.delete(id); ambiguous.add(id); }
            else map.set(id, { id: tour.tmArtistID, name: tour.artistName });
        }
    }
    return map;
}

async function ingest(check) {
    const states = getStateModel(), catalog = getSeriesEventModel();
    const state = await states.findById("series-sync").lean();
    const started = new Date();
    const full = !state || !state.fullScanAt || Date.now() - +state.fullScanAt > positive("SERIES_FULL_SCAN_HOURS", 24) * 3600000;
    const artists = await artistMappings();
    const knownIDs = await catalog.distinct("eventID");
    const identities = [...new Set([...artists.keys(), ...knownIDs])];
    const identityQuery = { $or: [
        { eventID: { $in: identities } },
        { "eventinfo.attractions.0.id": { $exists: true } },
        { "eventinfo._embedded.attractions.0.id": { $exists: true } }
    ] };
    const query = full ? identityQuery : { $and: [identityQuery, { updatedAt: { $gte: new Date(+state.checkpoint - 60000) } }] };
    console.log(`[series] ${full ? "full" : "incremental"} sync, ${artists.size} artist-mapped events`);
    const cursor = getTmEventsModel().find(query, { eventID: 1, UTCEventDate: 1,
        "eventinfo.name": 1, "eventinfo.classifications": 1, "eventinfo.venues": 1,
        "eventinfo.dates": 1, "eventinfo.attractions": 1, "eventinfo._embedded.attractions": 1 }).maxTimeMS(120000).lean().cursor({ batchSize: 300 });
    let batch = [], changed = 0;
    async function flush() {
        if (!batch.length) return;
        check();
        const existing = await catalog.find({ eventID: { $in: batch.map(row => String(row.eventID)) } }).lean();
        const byId = new Map(existing.map(row => [row.eventID, row]));
        const writes = [], dirty = new Set();
        for (const row of batch) {
            if (!row.eventID) continue;
            const next = normalizeEvent(row, artists), previous = byId.get(next.eventID);
            // Do not build a catalog of unrelated sports or unidentified events.
            if (!next.eligible && !previous) continue;
            if (!previous || previous.fingerprint !== next.fingerprint || previous.eligible !== next.eligible) {
                if (previous && previous.groupKey) dirty.add(previous.groupKey);
                if (next.groupKey) dirty.add(next.groupKey);
                writes.push({ updateOne: { filter: { eventID: next.eventID }, update: { $set: { ...next, seenAt: started } }, upsert: true } });
                changed++;
            } else if (full) {
                writes.push({ updateOne: { filter: { eventID: next.eventID }, update: { $set: { seenAt: started } } } });
            }
        }
        // Persist invalidation before catalog changes, so a crash cannot lose the work.
        if (dirty.size) await states.bulkWrite([...dirty].map(key => ({ updateOne: {
            filter: { _id: `group:${key}` }, update: { $set: { dirty: true } }, upsert: true
        } })));
        if (writes.length) await catalog.bulkWrite(writes);
        batch = [];
    }
    for await (const row of cursor) { batch.push(row); if (batch.length >= 300) await flush(); }
    await flush();
    if (full) {
        // Retain historical metadata, but stop treating a source-deleted event as a known scheduled show.
        const missing = await catalog.find({ eligible: true, seenAt: { $lt: started } }, { groupKey: 1 }).lean();
        const keys = [...new Set(missing.map(row => row.groupKey).filter(Boolean))];
        if (keys.length) await states.bulkWrite(keys.map(key => ({ updateOne: { filter: { _id: `group:${key}` }, update: { $set: { dirty: true } }, upsert: true } })));
        await catalog.updateMany({ eligible: true, seenAt: { $lt: started } }, { $set: { eligible: false } });
    }
    check();
    await states.updateOne({ _id: "series-sync" }, { $set: { checkpoint: started, ...(full ? { fullScanAt: started } : {}) } }, { upsert: true });
    return changed;
}

async function rebuild(groupKey, check) {
    const catalog = getSeriesEventModel(), series = getSeriesModel();
    const events = await catalog.find({ groupKey, eligible: true }).sort({ eventDate: 1 }).lean();
    const previous = await series.find({ groupKey }).lean();
    const available = new Map(previous.map(row => [row.seriesID, row]));
    const runs = splitRuns(events, GAP).filter(run => run.length > 1);
    const writes = [], kept = [];
    for (const run of runs) {
        const ids = new Set(run.map(row => row.eventID));
        // Preserve the best-overlapping ID through additions; merges retire the other IDs.
        let best = null, overlap = 0;
        for (const row of available.values()) {
            const count = row.eventIDs.filter(id => ids.has(id)).length;
            if (count > overlap) { best = row; overlap = count; }
        }
        if (best) available.delete(best.seriesID);
        const seriesID = best ? best.seriesID : randomUUID();
        const members = run.map(row => ({ eventID: row.eventID, eventName: row.eventName, artist: row.artist,
            location: row.location, venue: row.venue, eventDate: row.eventDate, timezone: row.timezone }));
        const fingerprint = hash([VERSION, members]);
        const last = run[run.length - 1];
        const set = { checkedAt: new Date(), active: true };
        const update = { $set: set };
        if (!best || best.fingerprint !== fingerprint || !best.active) {
            Object.assign(set, { groupKey, artistID: last.artistID, artist: last.artist, location: last.location,
                eventIDs: [...ids], events: members, lastEventID: last.eventID,
                firstEventDate: run[0].eventDate, lastEventDate: last.eventDate,
                candidateWindows: run.map(event => ({ from: candidateUntil([event], HORIZON), to: event.eventDate })), fingerprint, ruleVersion: VERSION,
                updatedAt: new Date(), coverage: "last_known", demand: null, demandInputKey: null, demandExpiresAt: new Date(0) });
            update.$inc = { revision: 1 };
        }
        writes.push({ updateOne: { filter: { seriesID }, update, upsert: true } });
        kept.push(seriesID);
    }
    check();
    if (writes.length) await series.bulkWrite(writes);
    await series.updateMany({ groupKey, active: true, seriesID: { $nin: kept } }, { $set: { active: false, updatedAt: new Date() }, $inc: { revision: 1 } });
    await getStateModel().updateOne({ _id: `group:${groupKey}` }, { $set: { dirty: false, checkedAt: new Date(), ruleVersion: VERSION } }, { upsert: true });
}

async function queueHistories(check) {
    const now = new Date(), model = getWatchlistModel();
    const visible = await getSeriesModel().find({ active: true, candidateWindows: { $elemMatch: { from: { $lte: now }, to: { $gte: now } } } }).lean();
    const members = new Map();
    for (const series of visible) for (const event of series.events) members.set(event.eventID, event);
    const ids = [...members.keys()];
    // Membership expiration stops refreshing obsolete series without deleting their histories.
    await model.updateMany({ seriesTracked: true, eventID: { $nin: ids } }, { $set: { seriesTracked: false } });
    for (let offset = 0; offset < ids.length; offset += 300) {
        check();
        const chunk = ids.slice(offset, offset + 300);
        await model.bulkWrite(chunk.map(id => {
            const event = members.get(id);
            return { updateOne: { filter: { eventID: id }, update: {
                $set: { seriesTracked: true, eventName: event.eventName, UTCEventDate: event.eventDate,
                    timezone: event.timezone, venue: event.venue, passed: +event.eventDate < Date.now() },
                $setOnInsert: { pulledAt: now, historyUpdated: false }
            }, upsert: true } };
        }));
    }
}

async function runSeries(check = () => {}) {
    const changed = await ingest(check);
    const now = new Date();
    // Time-based candidates need no new source data. Rebuild only changed/stale groups.
    const candidates = await getSeriesEventModel().find({ eligible: true,
        eventDate: { $gte: now, $lte: new Date(+now + (HORIZON + 2) * 86400000) } }, { groupKey: 1 }).lean();
    const dirty = await getStateModel().find({ _id: /^group:/, $or: [{ dirty: true }, { ruleVersion: { $ne: VERSION } }] }).lean();
    const keys = new Set(dirty.map(row => row._id.slice(6)));
    const candidateKeys = [...new Set(candidates.map(row => row.groupKey))];
    const states = await getStateModel().find({ _id: { $in: candidateKeys.map(key => `group:${key}`) } }).lean();
    const byId = new Map(states.map(row => [row._id, row]));
    for (const key of candidateKeys) {
        const state = byId.get(`group:${key}`);
        if (!state || !state.checkedAt || +now - +state.checkedAt > positive("SERIES_REFRESH_MINUTES", 60) * 60000) keys.add(key);
    }
    for (const key of keys) { check(); await rebuild(key, check); }
    await queueHistories(check);
    console.log(`[series] changed events=${changed}, groups checked=${keys.size}`);
}
module.exports = { runSeries, rebuild, queueHistories };
