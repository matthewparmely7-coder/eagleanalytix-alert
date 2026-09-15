const test = require("node:test");
const assert = require("node:assert/strict");
require("../path");
const { normalizeEvent, splitRuns, candidateUntil } = require("../services/seriesGrouping");
const event = (id, date) => ({ eventID: id, eventDate: new Date(date), eligible: true, timezone: "America/New_York" });
test("chains indefinitely across adjacent gaps, discovers a future last show", () => {
    const events = Array.from({ length: 10 }, (_, i) => event(String(i), Date.UTC(2026, 8, 1 + i * 5, 20)));
    const runs = splitRuns(events.reverse(), 7);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].length, 10);
    assert.equal(runs[0].at(-1).eventID, "9");
});
test("gap splits separate visits and cancellation removes membership", () => {
    const rows = [event("a", "2026-09-01"), { ...event("b", "2026-09-05"), eligible: false }, event("c", "2026-09-10")];
    assert.deepEqual(splitRuns(rows, 7).map(run => run.map(e => e.eventID)), [["a"], ["c"]]);
});
test("uses local calendar gaps across daylight saving", () => {
    assert.equal(splitRuns([event("a", "2026-10-31T23:00:00Z"), event("b", "2026-11-02T00:00:00Z")], 1).length, 1);
});
test("candidate horizon is local calendar days and does not limit discovery", () => {
    assert.equal(candidateUntil([event("a", "2026-09-18T23:00:00Z")], 3).toISOString(), "2026-09-15T04:00:00.000Z");
});
test("requires reliable artist identity and distinguishes same-named cities", () => {
    const row = { eventID: "a", UTCEventDate: "2026-09-18T23:00:00Z", eventinfo: {
        name: "Concert", classifications: { segment: { name: "Music" } }, venues: { city: "Portland", state: "OR", country: "US" }
    } };
    assert.equal(normalizeEvent(row).eligible, false);
    const artists = new Map([["a", { id: "artist1", name: "Artist" }]]);
    const first = normalizeEvent(row, artists);
    assert.equal(first.eligible, true);
    row.eventinfo.venues.state = "ME";
    assert.notEqual(normalizeEvent(row, artists).groupKey, first.groupKey);
    row.eventinfo.dates = { status: { code: "cancelled" } };
    assert.equal(normalizeEvent(row, artists).eligible, false);
});
test("history normalization retains resale-only prices without primary fallback", () => {
    const { mergeSnapshots, appendHistory } = require("../services/watchlist");
    const points = mergeSnapshots([[{ timestamp: 1, ticketinfo: { primary: 10, resale: 0, primary_minPrice: 80, resale_minPrice: 0 } }]], "tm");
    assert.equal(points[0].minPrice, 80);
    assert.equal(points[0].resaleMinPrice, null);
    assert.equal(appendHistory([{ timestamp: 1, primary: 10, minPrice: 80 }], points)[0].primaryMinPrice, 80);
});
test("pattern writes are conditional on the evaluated revision and metadata", () => {
    const { revisionFilter } = require("../services/patterns");
    const date = new Date();
    assert.deepEqual(revisionFilter({ eventID: "a", historyRevision: 12, UTCEventDate: date, timezone: "UTC" }),
        { eventID: "a", historyRevision: 12, UTCEventDate: date, timezone: "UTC" });
    assert.deepEqual(revisionFilter({ eventID: "legacy" }).historyRevision, { $exists: false });
});
