const { Schema } = require("mongoose");

const snapshot = {
    timestamp: Number,
    primary: Number,
    minPrice: Number,
    _id: false
};

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
        history: [snapshot],
        vsEventID: String,
        vsHistory: [snapshot],
        shEventID: String,
        shHistory: [snapshot],
        patterns: { type: Schema.Types.Mixed, default: {} },
        historyPulledAt: Date
    },
    { collection: "supply_change_events" }
);
