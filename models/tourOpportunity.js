const schema = require("./concertSeries").clone();
schema.set("collection", "tour_opportunities");
schema.add({ tourName: String, membership: String, viewEventIDs: [String], targetEventIDs: [String], referenceEventIDs: [String] });
module.exports = schema;
