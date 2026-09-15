const { Schema } = require("mongoose");

// History snapshots are schema-flexible:
// legacy: { timestamp, primary, minPrice }
// current: { timestamp, primary, resale, minPrice } — resale is TM-only (null/absent on VS/SH)
const snapshot = {
    timestamp: Number,
    primary: Number,
    resale: Number,
    minPrice: Number,
    resaleMinPrice: Number,
    primaryMinPrice: Number,
    _id: false
};

const schema = new Schema(
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
        historyPulledAt: Date,
        historyAttemptAt: Date,
        historyNextAt: Date,
        historyRevision: { type: Number, default: 0 },
        historyFingerprint: String,
        tourTracked: { type: Boolean, default: false },
        seriesTracked: { type: Boolean, default: false },
        patternHistoryRevision: Number,
        patternRulesVersion: String,
        patternEvaluatedAt: Date,
        patternNextAt: Date,
        demandMetadata: Schema.Types.Mixed,
        resaleDemand: Schema.Types.Mixed,
        resaleDemandGeneration: { type: Number, default: 0 },
        resaleDemandInputKey: String,
        resaleDemandNextAt: Date,
        resaleDemandExpiresAt: Date
    },
    { collection: "supply_change_events" }
);

schema.index({ passed: 1, historyPulledAt: 1 });
schema.index({ seriesTracked: 1, historyPulledAt: 1 });
schema.index({ patternNextAt: 1 });
schema.index({ historyNextAt: 1 });
schema.index({ resaleDemandNextAt: 1, UTCEventDate: 1 });
schema.index({ 'demandMetadata.checkedAt': 1 });
schema.index({ 'resaleDemand.peers.eventID': 1 });
schema.index({ 'demandMetadata.identity': 1, 'demandMetadata.market': 1, UTCEventDate: 1 });
module.exports = schema;
