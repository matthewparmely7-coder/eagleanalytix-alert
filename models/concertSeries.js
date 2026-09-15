const { Schema } = require("mongoose");
const schema = new Schema({
    seriesID: { type: String, unique: true, required: true },
    groupKey: { type: String, index: true },
    artistID: String, artist: String, location: String,
    eventIDs: [String],
    events: [{ eventID: String, eventName: String, artist: String, location: String,
        venue: String, eventDate: Date, timezone: String, _id: false }],
    lastEventID: String, firstEventDate: Date, lastEventDate: Date,
    candidateWindows: [{ from: Date, to: Date, _id: false }],
    revision: { type: Number, default: 0 },
    fingerprint: String, ruleVersion: String,
    active: Boolean, checkedAt: Date, updatedAt: Date,
    demand: Schema.Types.Mixed, demandInputKey: String, demandEvaluatedAt: Date, demandExpiresAt: Date,
    demandGeneration: { type: Number, default: 0 },
    coverage: { type: String, default: "last_known" }
}, { collection: "concert_series" });
schema.index({ eventIDs: 1 });
schema.index({ active: 1, "candidateWindows.from": 1, "candidateWindows.to": 1 });
module.exports = schema;
