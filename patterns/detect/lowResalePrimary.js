const { toSeries, miss, extreme, pctChange } = require("./series");
const { lowResaleWindow } = require("./window");
const { jumpMeets, thresholds } = require("./thresholds");

const MIN_POINTS = 4;

function medianValue(rows) {
    const vals = rows.map(row => row.value).sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

function inQuietBand(value, quietLevel, pct) {
    return quietLevel && Math.abs(value - quietLevel) / quietLevel <= pct;
}

function withinBand(series, center, pct) {
    if (!center || !series.length) {
        return false;
    }
    return series.every(row => Math.abs(row.value - center) / center <= pct);
}

function lastQuietPoint(series, beforeTs, quietLevel, pct) {
    let found = null;
    for (let i = 0; i < series.length; i++) {
        const row = series[i];
        if (row.timestamp >= beforeTs) {
            break;
        }
        if (inQuietBand(row.value, quietLevel, pct)) {
            found = row;
        }
    }
    return found;
}

function latestFinite(series) {
    for (let i = series.length - 1; i >= 0; i--) {
        if (Number.isFinite(series[i].value)) {
            return series[i];
        }
    }
    return null;
}

function detectGetInInflection(getIn, t) {
    if (!getIn || getIn.length < MIN_POINTS) {
        return miss();
    }

    const actionMs = t.lowResaleActionDays * 24 * 60 * 60 * 1000;
    const quietPct = t.lowResaleQuietPercent / 100;
    const tNow = getIn[getIn.length - 1].timestamp;
    const actionFrom = tNow - actionMs;
    const head = getIn.filter(row => row.timestamp < actionFrom);
    const quietSrc = head.length >= 2 ? head : getIn.slice(0, Math.max(2, Math.floor(getIn.length * 0.6)));
    const quietLevel = medianValue(quietSrc);
    if (!quietLevel) {
        return miss();
    }

    const recent = getIn.filter(row => row.timestamp >= actionFrom);
    const recentPeak = extreme(recent, "max");
    if (!recentPeak) {
        return miss();
    }

    const start = lastQuietPoint(getIn, recentPeak.timestamp, quietLevel, quietPct);
    if (!start || start.timestamp < actionFrom - 24 * 60 * 60 * 1000) {
        return miss();
    }

    const afterStart = getIn.filter(row => row.timestamp >= start.timestamp);
    const end = extreme(afterStart, "max");
    if (!end || end.timestamp <= start.timestamp || end.timestamp < actionFrom || end.value <= start.value) {
        return miss();
    }

    const jumpPercent = pctChange(quietLevel, end.value);
    const jumpPrice = end.value - quietLevel;
    if (jumpPercent == null || !jumpMeets(jumpPercent, jumpPrice, t.lowResaleJumpPercent, t.lowResaleJumpPrice)) {
        return miss();
    }

    const before = getIn.filter(row => row.timestamp <= start.timestamp);
    if (!withinBand(before, quietLevel, quietPct)) {
        return miss();
    }

    return {
        hit: true,
        quietValue: Math.round(quietLevel),
        changePercent: Math.round(jumpPercent),
        from: start.value,
        to: end.value,
        trough: { timestamp: start.timestamp, value: start.value },
        pickup: { timestamp: end.timestamp, value: end.value }
    };
}

function detectLowResalePrimary(tmHistory, vsHistory, opts = {}) {
    const t = thresholds();
    const { from: winFrom, to: winTo } = lowResaleWindow(opts);
    const inWindow = row => row.timestamp >= winFrom && row.timestamp <= winTo;

    const primary = toSeries(tmHistory, "primary").filter(inWindow);
    const resale = toSeries(tmHistory, "resale").filter(inWindow);
    const getIn = toSeries(tmHistory, "minPrice").filter(inWindow);
    const vsCount = toSeries(vsHistory, "primary").filter(inWindow);

    if (primary.length < MIN_POINTS || resale.length < 1) {
        return miss();
    }

    const nowPrimary = latestFinite(primary);
    const nowResale = latestFinite(resale);
    const nowVs = latestFinite(vsCount);
    if (!nowPrimary || !nowResale) {
        return miss();
    }

    // Gate A: TM resale must be on (not 0) and thin. Zero usually means marketplace off.
    if (!(nowResale.value > 0 && nowResale.value <= t.thinTmResaleMax)) {
        return miss();
    }

    // Gate B: VS thin when we have a match (soft if no VS series).
    if (nowVs && !(nowVs.value > 0 && nowVs.value <= t.thinVsMax)) {
        return miss();
    }

    // Gate C: primary still working — declining over lookback.
    const lookbackMs = t.lowResaleLookbackDays * 24 * 60 * 60 * 1000;
    const lookback = primary.filter(row => row.timestamp >= nowPrimary.timestamp - lookbackMs);
    if (lookback.length < 2) {
        return miss();
    }
    const first = lookback[0];
    const last = lookback[lookback.length - 1];
    const dropPct = pctChange(first.value, last.value);
    const sold = first.value - last.value;
    if (dropPct == null || dropPct > -t.minPrimaryDropPercent) {
        return miss();
    }
    if (t.minPrimarySold > 0 && sold < t.minPrimarySold) {
        return miss();
    }

    // Gate D: primary nearly gone or recent drop steepening.
    const primaryLow = last.value <= t.primaryLowMax;
    const slopeSteep = dropPct <= -t.steepPrimaryDropPercent;
    if (!primaryLow && !slopeSteep) {
        return miss();
    }

    // Effect: resale get-in inflection after drain.
    const priceHit = detectGetInInflection(getIn, t);
    if (!priceHit.hit) {
        return miss();
    }

    return {
        hit: true,
        primaryFrom: first.value,
        primaryTo: last.value,
        primaryDropPercent: Math.round(dropPct),
        primarySold: Math.round(sold),
        resale: nowResale.value,
        vsCount: nowVs ? nowVs.value : null,
        getInFrom: priceHit.from,
        getInTo: priceHit.to,
        getInJumpPercent: priceHit.changePercent,
        trough: { timestamp: first.timestamp, value: first.value },
        pickup: { timestamp: last.timestamp, value: last.value },
        priceTrough: priceHit.trough,
        pricePickup: priceHit.pickup
    };
}

module.exports = { detectLowResalePrimary, detectGetInInflection };
