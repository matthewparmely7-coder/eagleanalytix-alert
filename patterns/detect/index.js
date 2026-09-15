const { detectSupplyChange } = require("./supplyChange");
const { detectUShaped } = require("./uShaped");
const { detectRocket } = require("./rocket");
const { detectLowResalePrimary } = require("./lowResalePrimary");
const { isSupplyChangeEvent, isUShapeEvent, isRocketEvent, isLowResaleEvent } = require("./window");

function detectAll(tmHistory, vsHistory, shHistory, opts = {}) {
    const window = { eventDate: opts.eventDate, timezone: opts.timezone };
    const patterns = {};

    if (isSupplyChangeEvent(opts.eventDate, opts.timezone)) {
        patterns.supply_change = {
            tm: detectSupplyChange(tmHistory, window)
        };
    }

    if (isUShapeEvent(opts.eventDate, opts.timezone)) {
        patterns.u_shaped = {
            tm: detectUShaped(tmHistory),
            vs: detectUShaped(vsHistory),
            sh: detectUShaped(shHistory)
        };
    }

    if (isRocketEvent(opts.eventDate, opts.timezone)) {
        patterns.rocket = {
            tm: detectRocket(tmHistory, window),
            vs: detectRocket(vsHistory, window),
            sh: detectRocket(shHistory, window)
        };
    }

    if (isLowResaleEvent(opts.eventDate, opts.timezone)) {
        patterns.low_resale_primary = {
            tm: detectLowResalePrimary(tmHistory, vsHistory, window)
        };
    }

    return patterns;
}

module.exports = {
    detectAll,
    detectSupplyChange,
    detectUShaped,
    detectRocket,
    detectLowResalePrimary
};
