const mongoose = require("mongoose");
const tmEventsSchema = require("models/tm_events");
const eventMatchSchema = require("models/event_match");
const supplyChangeEventSchema = require("models/supplyChangeEvent");

mongoose.set("strictQuery", false);

let sourceConn;
let localConn;
let tmEventsModel;
let eventMatchModel;
let supplyChangeEventModel;

function sourceUri() {
    return (process.env.SOURCE_MONGODB_URI || process.env.MONGODB_URI || "").trim();
}

function localUri() {
    return (process.env.DATABASE_URL || "").trim();
}

async function connect() {
    const source = sourceUri();
    const local = localUri();
    if (!source) {
        throw new Error("Set SOURCE_MONGODB_URI in .env (same value as backend MONGODB_URI)");
    }
    if (!local) {
        throw new Error("Set DATABASE_URL in .env (local Mongo, e.g. mongodb://127.0.0.1:27017/eagleanalytix_alert)");
    }

    const opts = { useNewUrlParser: true, serverSelectionTimeoutMS: 10000 };

    sourceConn = await mongoose.createConnection(source, opts).asPromise();
    localConn = await mongoose.createConnection(local, opts).asPromise();

    tmEventsModel = sourceConn.model("tm_eventsModel", tmEventsSchema);
    eventMatchModel = sourceConn.model("eventMatchModel", eventMatchSchema);
    supplyChangeEventModel = localConn.model("supplyChangeEvent", supplyChangeEventSchema);

    console.log("[alert] connected to source MongoDB");
    console.log("[alert] connected to local MongoDB");
}

function getTmEventsModel() {
    return tmEventsModel;
}

function getEventMatchModel() {
    return eventMatchModel;
}

function getSupplyChangeEventModel() {
    return supplyChangeEventModel;
}

module.exports = {
    connect,
    getTmEventsModel,
    getEventMatchModel,
    getSupplyChangeEventModel
};
