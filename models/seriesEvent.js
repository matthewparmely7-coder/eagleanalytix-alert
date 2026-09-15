const { Schema } = require("mongoose");
const schema = new Schema({
    eventID: { type: String, unique: true }, groupKey: String,
    artistID: String, artist: String, location: String, venue: String,
    eventName: String, eventDate: Date, timezone: String,
    eligible: Boolean, fingerprint: String, seenAt: Date
}, { collection: "concert_series_events" });
schema.index({ groupKey: 1, eligible: 1, eventDate: 1 });
schema.index({ eligible: 1, eventDate: 1 });
module.exports = schema;
