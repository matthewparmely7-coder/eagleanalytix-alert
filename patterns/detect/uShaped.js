const { toSeries, miss, extreme, pctChange } = require("./series");
const { jumpMeets, thresholds } = require("./thresholds");

const MIN_POINTS = 6;
const CANDIDATE_GAP_MS = 12 * 60 * 60 * 1000;

function medianValue(rows) {
    const vals = rows.map(row => row.value).sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

function inQuietBand(value, center, pct) {
    return center && Math.abs(value - center) / center <= pct;
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

function spacedIndices(rows, minGapMs) {
    const idxs = [];
    let lastTs = -Infinity;
    for (let i = 0; i < rows.length; i++) {
        if (i === rows.length - 1 || rows[i].timestamp - lastTs >= minGapMs) {
            idxs.push(i);
            lastTs = rows[i].timestamp;
        }
    }
    return idxs;
}

function smoothDecline(series, from, to, variationPct) {
    const drop = from.value - to.value;
    if (drop <= 0) {
        return false;
    }
    const slack = drop * variationPct;
    const pts = series.filter(row => row.timestamp >= from.timestamp && row.timestamp <= to.timestamp);
    if (pts.length < 2) {
        return false;
    }
    let runMin = from.value;
    for (let i = 0; i < pts.length; i++) {
        const value = pts[i].value;
        if (value < runMin) {
            runMin = value;
        }
        if (value > runMin + slack) {
            return false;
        }
    }
    return true;
}

function pickH1(series, left, troughStart, troughLevel, variationPct, minDipPercent, minDropMs) {
    let best = null;
    for (let i = 0; i < left.length; i++) {
        const row = left[i];
        if (row.value <= troughLevel || troughStart.timestamp - row.timestamp < minDropMs) {
            continue;
        }
        const dip = ((row.value - troughLevel) / row.value) * 100;
        if (dip < minDipPercent) {
            continue;
        }
        if (!smoothDecline(series, row, troughStart, variationPct)) {
            continue;
        }
        if (!best || row.value > best.value || (row.value === best.value && row.timestamp > best.timestamp)) {
            best = row;
        }
    }
    return best;
}

function findTrough(series, h2, minTroughMs, wiggle, minJumpPercent, minJumpPrice) {
    const before = series.filter(row => row.timestamp < h2.timestamp);
    if (before.length < 2) {
        return [];
    }
    const maxTroughLevel = minJumpPercent > 0 ? h2.value / (1 + minJumpPercent / 100) : h2.value;
    const ends = spacedIndices(before, CANDIDATE_GAP_MS);
    const found = [];
    for (let e = ends.length - 1; e >= 0; e--) {
        const end = before[ends[e]];
        const seedFrom = end.timestamp - minTroughMs;
        const seed = before.filter(row => row.timestamp >= seedFrom && row.timestamp <= end.timestamp);
        if (seed.length < 2) {
            continue;
        }
        const level = medianValue(seed);
        if (!level || level > maxTroughLevel || !withinBand(seed, level, wiggle)) {
            continue;
        }
        let startIdx = 0;
        while (startIdx < before.length && before[startIdx].timestamp < seedFrom) {
            startIdx++;
        }
        while (startIdx > 0 && inQuietBand(before[startIdx - 1].value, level, wiggle)) {
            startIdx--;
        }
        const troughStart = before[startIdx];
        if (!troughStart || end.timestamp - troughStart.timestamp < minTroughMs) {
            continue;
        }
        const launch = lastQuietPoint(series, h2.timestamp, level, wiggle);
        if (!launch || launch.timestamp < troughStart.timestamp) {
            continue;
        }
        const rise = series.filter(row => row.timestamp >= launch.timestamp && row.timestamp < h2.timestamp);
        if (retraces([launch].concat(rise), wiggle)) {
            continue;
        }
        const jumpPercent = pctChange(level, h2.value);
        const jumpPrice = h2.value - level;
        if (jumpPercent == null || !jumpMeets(jumpPercent, jumpPrice, minJumpPercent, minJumpPrice)) {
            continue;
        }
        const troughWindow = series.filter(row => row.timestamp >= troughStart.timestamp && row.timestamp <= launch.timestamp);
        const trough = extreme(troughWindow, "min") || launch;
        found.push({ troughStart, launch, level, trough, jumpPercent });
    }
    return found;
}

function detectUShaped(history, opts = {}) {
    const t = thresholds();
    const minDipPercent = opts.minDipPercent != null ? opts.minDipPercent : t.uShapeDipPercent;
    const minJumpPercent = opts.minJumpPercent != null ? opts.minJumpPercent : t.uShapeJumpPercent;
    const minJumpPrice = opts.minJumpPrice != null ? opts.minJumpPrice : t.uShapeJumpPrice;
    const variationPct = (opts.variationPercent != null ? opts.variationPercent : t.uShapeVariationPercent) / 100;
    const minTroughMs = (opts.troughDays != null ? opts.troughDays : t.uShapeTroughDays) * 24 * 60 * 60 * 1000;
    const minDropMs = (opts.dropDays != null ? opts.dropDays : t.uShapeDropDays) * 24 * 60 * 60 * 1000;
    const actionMs = (opts.actionDays != null ? opts.actionDays : t.uShapeActionDays) * 24 * 60 * 60 * 1000;
    const series = toSeries(history, "minPrice");
    if (!series || series.length < MIN_POINTS) {
        return miss();
    }

    const tNow = series[series.length - 1].timestamp;
    const actionFrom = tNow - actionMs;
    const recent = series.filter(row => row.timestamp >= actionFrom);
    const h2 = extreme(recent, "max");
    if (!h2) {
        return miss();
    }
    const after = series.filter(row => row.timestamp >= h2.timestamp);
    if (!withinBand(after, h2.value, variationPct)) {
        return miss();
    }

    const troughs = findTrough(series, h2, minTroughMs, variationPct, minJumpPercent, minJumpPrice);
    for (let i = 0; i < troughs.length; i++) {
        const found = troughs[i];
        const left = series.filter(row => row.timestamp < found.troughStart.timestamp);
        const h1 = pickH1(series, left, found.troughStart, found.level, variationPct, minDipPercent, minDropMs);
        if (!h1) {
            continue;
        }
        const dipPercent = ((h1.value - found.level) / h1.value) * 100;
        return {
            hit: true,
            dipPercent: Math.round(dipPercent),
            jumpPercent: Math.round(found.jumpPercent),
            from: h1.timestamp,
            to: tNow,
            h1: { timestamp: h1.timestamp, value: h1.value },
            trough: { timestamp: found.trough.timestamp, value: found.trough.value },
            h2: { timestamp: h2.timestamp, value: h2.value }
        };
    }
    return miss();
}

module.exports = { detectUShaped };
