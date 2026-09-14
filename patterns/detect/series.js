function asArray(data) {
    return Array.isArray(data) ? data : [];
}

function toSeries(history, field) {
    return asArray(history)
        .map(row => ({
            timestamp: Number(row && row.timestamp),
            value: Number(row && row[field])
        }))
        .filter(row => Number.isFinite(row.timestamp) && Number.isFinite(row.value))
        .sort((a, b) => a.timestamp - b.timestamp);
}

function miss() {
    return { hit: false };
}

function pctChange(from, to) {
    if (!from) {
        return null;
    }
    return ((to - from) / from) * 100;
}

function extreme(rows, pick) {
    return rows.reduce((best, row) => {
        if (!best) {
            return row;
        }
        if (pick === "min") {
            if (row.value < best.value || (row.value === best.value && row.timestamp < best.timestamp)) {
                return row;
            }
            return best;
        }
        if (row.value > best.value || (row.value === best.value && row.timestamp < best.timestamp)) {
            return row;
        }
        return best;
    }, null);
}

function mean(rows) {
    if (!rows.length) {
        return null;
    }
    return rows.reduce((sum, row) => sum + row.value, 0) / rows.length;
}

function stdev(rows) {
    if (rows.length < 2) {
        return 0;
    }
    const avg = mean(rows);
    const variance = rows.reduce((sum, row) => sum + (row.value - avg) ** 2, 0) / rows.length;
    return Math.sqrt(variance);
}

module.exports = {
    toSeries,
    miss,
    pctChange,
    extreme,
    mean,
    stdev
};
