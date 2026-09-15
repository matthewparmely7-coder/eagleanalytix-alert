const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("crypto");
require("../path");

test("Mongo: additions, merges, splits, retirement, history queue and revision guard", { skip: !process.env.SERIES_TEST_MONGO_URI }, async () => {
    // Explicit isolated test server only; never load .env or use the configured app databases.
    const mongoose = require("mongoose");
    const base = process.env.SERIES_TEST_MONGO_URI;
    assert.match(base, /^mongodb:\/\/127\.0\.0\.1:27189\/?$/);
    const suffix = randomUUID().replace(/-/g, "");
    process.env.SOURCE_MONGODB_URI = `${base}/series_test_source_${suffix}`;
    process.env.DATABASE_URL = `${base}/series_test_alert_${suffix}`;
    const db = require("../services/db");
    const seed = await mongoose.createConnection(process.env.SOURCE_MONGODB_URI).asPromise();
    const source = seed.collection("tm_eventsmodels");
    const tours = seed.collection("tmartisttourmodels");
    const day = 86400000;
    const date = offset => new Date(Date.now() + offset * day);
    const row = (id, offset) => ({ eventID: id, UTCEventDate: date(offset), updatedAt: new Date(), eventinfo: {
        name: `Artist Show ${id}`, classifications: { segment: { name: "Music" } },
        dates: { timezone: "America/New_York", status: { code: "onsale" } },
        venues: { name: "Venue", city: "Chicago", state: "IL", country: "US" }
    } });
    try {
        await source.insertMany([row("a", -2), row("b", -1), row("c", 1)]);
        await tours.insertOne({ tmArtistID: "artist-1", artistName: "Artist", events: ["a", "b", "c", "d", "e", "f", "bridge"].map(eventID => ({ eventID })) });
        await db.connect();
        const { runSeries } = require("../services/series");
        const series = db.getSeriesModel(), watchlist = db.getWatchlistModel();
        await runSeries();
        let group = await series.findOne({ active: true }).lean();
        assert.deepEqual(group.eventIDs, ["a", "b", "c"]);
        assert.equal(group.lastEventID, "c");
        assert.equal(await watchlist.countDocuments({ seriesTracked: true }), 3);
        assert.equal((await watchlist.findOne({ eventID: "a" })).passed, true);
        const id = group.seriesID, revision = group.revision;
        await runSeries();
        assert.equal((await series.findOne({ seriesID: id })).revision, revision, "unchanged work must not bump revision");

        await source.insertOne(row("d", 4));
        await runSeries();
        group = await series.findOne({ active: true }).lean();
        assert.equal(group.seriesID, id);
        assert.equal(group.lastEventID, "d");
        assert.equal(group.revision, revision + 1);
        assert.equal(group.events.length, 4, "future show beyond candidate horizon is retained");

        await source.insertMany([row("e", 16), row("f", 17)]);
        await runSeries();
        assert.equal(await series.countDocuments({ active: true }), 2);
        await source.insertOne(row("bridge", 10));
        await runSeries();
        assert.equal(await series.countDocuments({ active: true }), 1, "bridge merges groups");
        group = await series.findOne({ active: true }).lean();
        assert.equal(group.lastEventID, "f");
        await source.updateOne({ eventID: "bridge" }, { $set: { "eventinfo.dates.status.code": "cancelled", updatedAt: new Date() } });
        await runSeries();
        assert.equal(await series.countDocuments({ active: true }), 2, "cancellation splits groups");
        assert.equal((await watchlist.findOne({ eventID: "e" })).seriesTracked, false);

        const { evaluateBatch } = require("../services/patterns");
        await watchlist.updateOne({ eventID: "c" }, { $set: { historyRevision: 12, history: [], patternNextAt: new Date(0) } });
        const originalUpdate = watchlist.updateOne.bind(watchlist);
        let changed = false;
        watchlist.updateOne = async (filter, update, options) => {
            if (!changed && filter.eventID === "c" && update.$set.patternHistoryRevision === 12) {
                changed = true;
                await originalUpdate({ eventID: "c" }, { $inc: { historyRevision: 1 }, $set: { patternNextAt: new Date(0) } });
            }
            return originalUpdate(filter, update, options);
        };
        await evaluateBatch(100);
        watchlist.updateOne = originalUpdate;
        assert.equal(changed, true);
        assert.notEqual((await watchlist.findOne({ eventID: "c" })).patternHistoryRevision, 12);
        await evaluateBatch(100);
        assert.equal((await watchlist.findOne({ eventID: "c" })).patternHistoryRevision, 13);

        // Backend reads the stored group and never splits it across event pages.
        const aliases = require("module-alias");
        const path = require("path");
        aliases.addAlias("libs", path.resolve(__dirname, "../../eagleanalytix-backend/libs"));
        process.env.ALERT_MONGODB_URI = process.env.DATABASE_URL;
        const backendDb = require("../../eagleanalytix-backend/libs/alertDb");
        try {
            const api = require("../../eagleanalytix-backend/services/concertSeriesService");
            const response = await api.getConcertSeries({ limit: 1 });
            assert.equal(response.result.length, 1);
            assert.equal(response.result[0].events.length, 4);
            assert.equal(response.result[0].number, 1);
        } finally { (await backendDb.getConcertSeriesModel()).db.close(); }
    } finally {
        await seed.dropDatabase();
        if (db.getWatchlistModel()) await db.getWatchlistModel().db.dropDatabase();
        await db.close();
        await seed.close();
    }
});
