const { toSeries, miss, extreme, mean, pctChange } = require("./series");
const { supplyWindow } = require("./window");
const { jumpMeets, thresholds } = require("./thresholds");

const MIN_POINTS = 4;
const HOLD_FLOOR = 0.75;
const MAX_GIVEBACK = 0.5;
const DROP_NOW_PERCENT = 10;
const QUIET_RANGE = 0.2;

function isQuietBefore(before) {
    if (before.length < 2) {
        return true;
    }
    const avg = mean(before);
    const minPoint = extreme(before, "min");
    const maxPoint = extreme(before, "max");
    if (!avg || !minPoint || !maxPoint) {
        return false;
    }
    const range = (maxPoint.value - minPoint.value) / avg;
    if (range <= QUIET_RANGE) {
        return true;
    }
    const first = before[0].value;
    const last = before[before.length - 1].value;
    const rose = pctChange(first, last);
    if (rose != null && rose > 10) {
        return false;
    }
    return last <= minPoint.value * 1.15;
}

function isHolding(after, peakValue, troughValue) {
    if (after.length < 1) {
        return false;
    }
    const last = after[after.length - 1];
    const hold = after.length === 1 ? last.value : mean(after);
    if (!hold || last.value < hold * HOLD_FLOOR) {
        return false;
    }
    if (after.length >= 2) {
        const start = after[0].value;
        const end = last.value;
        const afterMin = extreme(after, "min");
        if (start && afterMin && ((start - end) / start) * 100 >= DROP_NOW_PERCENT && end <= afterMin.value * 1.05) {
            return false;
        }
        const added = peakValue - troughValue;
        if (added > 0 && (peakValue - afterMin.value) / added > MAX_GIVEBACK) {
            return false;
        }
    }
    return true;
}

function detectPickup(series, minPickupPercent, minPickupCount) {
    if (!series || series.length < MIN_POINTS) {
        return miss();
    }

    const actionMs = thresholds().supplyActionHours * 60 * 60 * 1000;
    const tNow = series[series.length - 1].timestamp;
    const actionFrom = tNow - actionMs;
    let best = null;

    for (let i = 0; i < series.length - 1; i++) {
        const trough = series[i];
        const before = series.slice(0, i + 1);
        if (!isQuietBefore(before)) {
            continue;
        }
        for (let j = i + 1; j < series.length; j++) {
            const peak = series[j];
            if (peak.timestamp < actionFrom) {
                continue;
            }
            if (peak.timestamp - trough.timestamp > actionMs) {
                break;
            }
            const pickupPercent = pctChange(trough.value, peak.value);
            const pickupCount = peak.value - trough.value;
            if (pickupPercent == null || !jumpMeets(pickupPercent, pickupCount, minPickupPercent, minPickupCount)) {
                continue;
            }
            const after = series.slice(j);
            if (!isHolding(after, peak.value, trough.value)) {
                continue;
            }
            if (!best || pickupPercent > best.changePercent) {
                best = {
                    hit: true,
                    changePercent: Math.round(pickupPercent),
                    changeCount: Math.round(peak.value - trough.value),
                    direction: "up",
                    from: trough.value,
                    to: peak.value,
                    trough: { timestamp: trough.timestamp, value: trough.value },
                    pickup: { timestamp: peak.timestamp, value: peak.value }
                };
            }
        }
    }

    return best || miss();
}

function detectSupplyChange(history, opts = {}) {
    const t = thresholds();
    const minPickupPercent = opts.minAbsPercent != null ? opts.minAbsPercent : t.supplyJumpPercent;
    const minPickupCount = opts.minAbsCount != null ? opts.minAbsCount : t.supplyJumpCount;
    const { from: winFrom, to: winTo } = supplyWindow(opts);
    const series = toSeries(history, "primary").filter(row => row.timestamp >= winFrom && row.timestamp <= winTo);
    return detectPickup(series, minPickupPercent, minPickupCount);
}

module.exports = { detectSupplyChange, detectPickup, supplyWindow };
