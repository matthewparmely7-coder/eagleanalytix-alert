const { createHash } = require("crypto");
const moment = require("moment-timezone");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = value => String(typeof value === "object" && value ? value.name || value.countryCode || value.stateCode || "" : value || "").trim();
const normalize = value => text(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
const eventId = value => String(value.eventID || ((value.url || "").match(/\/event\/([^/?]+)/) || [])[1] || "");

function normalizeEvent(row, artists = new Map()) {
    const info = row.eventinfo || {};
    const venue = info.venues || {};
    const classification = Array.isArray(info.classifications) ? info.classifications[0] : info.classifications;
    const attractions = info.attractions || (info._embedded && info._embedded.attractions) || [];
    // Only an explicit primary attraction or an unambiguous saved artist-tour mapping.
    const direct = attractions[0];
    const artist = direct && direct.id ? { id: direct.id, name: direct.name } : artists.get(String(row.eventID));
    const city = text(venue.city), country = text(venue.country), state = text(venue.state);
    const date = new Date(row.UTCEventDate);
    const status = normalize(info.dates && info.dates.status && info.dates.status.code);
    const segment = normalize(classification && classification.segment && classification.segment.name);
    const eligible = !!(artist && artist.id && city && country && Number.isFinite(+date)
        && (segment === "music" || (!segment && artist))
        && !["cancelled", "canceled", "postponed"].includes(status)
        && !(info.dates && info.dates.start && (info.dates.start.dateTBA || info.dates.start.dateTBD)));
    const groupKey = eligible ? hash([String(artist.id), normalize(country), normalize(state), normalize(city)]) : "";
    const record = {
        eventID: String(row.eventID), groupKey, artistID: artist ? String(artist.id) : "",
        artist: artist ? text(artist.name) : "", location: [city, state, country].filter(Boolean).join(", "),
        venue: text(venue.name), eventName: text(info.name), eventDate: Number.isFinite(+date) ? date : null,
        timezone: moment.tz.zone(info.dates && info.dates.timezone) ? info.dates.timezone : "America/New_York",
        eligible
    };
    record.fingerprint = hash(record);
    return record;
}

// Chaining adjacent local calendar dates has no total-duration or show-count cutoff.
function splitRuns(events, gapDays) {
    const sorted = events.filter(event => event.eligible).slice().sort((a, b) => +a.eventDate - +b.eventDate || a.eventID.localeCompare(b.eventID));
    const runs = [];
    for (const event of sorted) {
        const run = runs[runs.length - 1];
        const prev = run && run[run.length - 1];
        const gap = prev ? moment(event.eventDate).tz(event.timezone).startOf("day")
            .diff(moment(prev.eventDate).tz(event.timezone).startOf("day"), "days") : Infinity;
        if (!run || gap > gapDays) runs.push([event]);
        else run.push(event);
    }
    return runs;
}

function candidateUntil(events, horizonDays) {
    return events.map(event => moment(event.eventDate).tz(event.timezone).startOf("day").subtract(horizonDays, "days").toDate())
        .reduce((a, b) => a < b ? a : b);
}
module.exports = { hash, normalizeEvent, splitRuns, eventId, candidateUntil };
