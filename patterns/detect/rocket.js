const { toSeries, miss, extreme, pctChange } = require("./series");
const { rocketWindow } = require("./window");
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

function retraces(between, pct) {
    if (between.length < 2) {
        return false;
    }
    let runMax = between[0].value;
    for (let i = 1; i < between.length; i++) {
        const value = between[i].value;
        if (value > runMax) {
            runMax = value;
        }
        if (runMax && (runMax - value) / runMax > pct) {
            return true;
        }
    }
    return false;
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

function detectRocket(history, opts = {}) {
    const t = thresholds();
    const minJumpPercent = opts.minJumpPercent != null ? opts.minJumpPercent : t.rocketJumpPercent;
    const minJumpPrice = opts.minJumpPrice != null ? opts.minJumpPrice : t.rocketJumpPrice;
    const quietPct = (opts.quietPercent != null ? opts.quietPercent : t.rocketQuietPercent) / 100;
    const actionMs = t.rocketActionDays * 24 * 60 * 60 * 1000;
    const { from: winFrom, to: winTo } = rocketWindow(opts);
    const series = toSeries(history, "minPrice").filter(row => row.timestamp >= winFrom && row.timestamp <= winTo);
    if (!series || series.length < MIN_POINTS) {
        return miss();
    }

    const tNow = series[series.length - 1].timestamp;
    const actionFrom = tNow - actionMs;
    const head = series.filter(row => row.timestamp < actionFrom);
    const quietSrc = head.length >= 2 ? head : series.slice(0, Math.max(2, Math.floor(series.length * 0.6)));
    const quietLevel = medianValue(quietSrc);
    if (!quietLevel) {
        return miss();
    }

    const recent = series.filter(row => row.timestamp >= actionFrom);
    const recentPeak = extreme(recent, "max");
    if (!recentPeak) {
        return miss();
    }

    const start = lastQuietPoint(series, recentPeak.timestamp, quietLevel, quietPct);
    if (!start || start.timestamp < actionFrom - 24 * 60 * 60 * 1000) {
        return miss();
    }

    const afterStart = series.filter(row => row.timestamp >= start.timestamp);
    const end = extreme(afterStart, "max");
    if (!end || end.timestamp <= start.timestamp || end.timestamp < actionFrom || end.value <= start.value) {
        return miss();
    }

    const jumpPercent = pctChange(quietLevel, end.value);
    const jumpPrice = end.value - quietLevel;
    if (jumpPercent == null || !jumpMeets(jumpPercent, jumpPrice, minJumpPercent, minJumpPrice)) {
        return miss();
    }

    const before = series.filter(row => row.timestamp <= start.timestamp);
    if (!withinBand(before, quietLevel, quietPct)) {
        return miss();
    }

    const between = afterStart.filter(row => row.timestamp < end.timestamp);
    if (retraces([start].concat(between), quietPct)) {
        return miss();
    }

    const after = series.filter(row => row.timestamp >= end.timestamp);
    if (!withinBand(after, end.value, quietPct)) {
        return miss();
    }

    return {
        hit: true,
        quietValue: Math.round(quietLevel),
        jumpPercent: Math.round(jumpPercent),
        from: start.value,
        to: end.value,
        trough: { timestamp: start.timestamp, value: start.value },
        pickup: { timestamp: end.timestamp, value: end.value }
    };
}

module.exports = { detectRocket };
