const { Schema } = require("mongoose");

// Same collection as eagleanalytix-backend. Read-only on the source connection.
module.exports = new Schema(
    {
        eventID: String,
        eventinfo: {},
        UTCEventDate: Date,
        active: Boolean
    },
    { timestamps: true }
);
