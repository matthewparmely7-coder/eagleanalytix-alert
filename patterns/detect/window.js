const moment = require("moment-timezone");
const { thresholds } = require("./thresholds");

const SUPPLY_EVENT_DAYS = { from: 0, to: 1 };
const U_SHAPE_EVENT_DAYS = { from: 0, to: 7 };
const ROCKET_EVENT_DAYS = { from: 0, to: 21 };

function eventTimezone(opts = {}) {
    return opts.timezone || "America/New_York";
}

function daysUntilEvent(eventDate, timezone) {
    if (!eventDate) {
        return null;
    }
    const tz = timezone || "America/New_York";
    const eventDay = moment(eventDate).tz(tz).startOf("day");
    const today = moment.tz(tz).startOf("day");
    return eventDay.diff(today, "days");
}

function inDayRange(eventDate, timezone, range) {
    const days = daysUntilEvent(eventDate, timezone);
    return days != null && days >= range.from && days <= range.to;
}

function supplyWindow(opts = {}) {
    const tz = eventTimezone(opts);
    const from = moment.tz(tz).startOf("day").subtract(thresholds().supplyHistoryDays - 1, "day");
    const eventEnd = opts.eventDate ? moment(opts.eventDate) : moment.tz(tz).endOf("day");
    return { from: from.valueOf(), to: eventEnd.valueOf() };
}

function isSupplyChangeEvent(eventDate, timezone) {
    return inDayRange(eventDate, timezone, SUPPLY_EVENT_DAYS);
}

function isUShapeEvent(eventDate, timezone) {
    return inDayRange(eventDate, timezone, U_SHAPE_EVENT_DAYS);
}

function isRocketEvent(eventDate, timezone) {
    return inDayRange(eventDate, timezone, ROCKET_EVENT_DAYS);
}

function rocketWindow(opts = {}) {
    const tz = eventTimezone(opts);
    const from = moment.tz(tz).startOf("day").subtract(thresholds().rocketHistoryDays - 1, "day");
    const to = moment.tz(tz).endOf("day");
    return { from: from.valueOf(), to: to.valueOf() };
}

module.exports = {
    daysUntilEvent,
    supplyWindow,
    isSupplyChangeEvent,
    isUShapeEvent,
    isRocketEvent,
    rocketWindow,
    SUPPLY_EVENT_DAYS,
    U_SHAPE_EVENT_DAYS,
    ROCKET_EVENT_DAYS
};
