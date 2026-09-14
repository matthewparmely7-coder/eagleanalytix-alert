const { Schema } = require("mongoose");

// Same collection as eagleanalytix-backend. Read-only on the source connection.
module.exports = new Schema(
    {
        tmEventID: String,
        vsEventID: String,
        shEventID: String
    },
    { collection: "eventmatchmodels" }
);
