const { Schema } = require("mongoose");

module.exports = new Schema(
    {
        eventID: { type: String, required: true, unique: true },
        UTCEventDate: Date,
        eventName: String,
        venue: String,
        timezone: String,
        targetUtcDate: String,
        pulledAt: Date,
        passed: { type: Boolean, default: false },
        historyUpdated: { type: Boolean, default: false },
        history: [
            {
                timestamp: Number,
                primary: Number
            }
        ],
        vsEventID: String,
        vsHistory: [
            {
                timestamp: Number,
                primary: Number
            }
        ],
        historyPulledAt: Date
    },
    { collection: "supply_change_events" }
);
