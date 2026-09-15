const { Schema } = require("mongoose");
module.exports = new Schema({
    _id: String, owner: String, leaseUntil: Date, checkpoint: Date,
    fullScanAt: Date, dirty: Boolean, checkedAt: Date, ruleVersion: String
}, { collection: "alert_worker_state" });
