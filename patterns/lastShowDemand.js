const { createHash } = require("crypto");
const HOUR = 3600000, DAY = 24 * HOUR;
function settings() {
    const n = (key, value, min = 0) => Math.max(min, Number.isFinite(Number(process.env[key])) && process.env[key] !== "" ? Number(process.env[key]) : value);
    return { windowDays: n("LAST_SHOW_WINDOW_DAYS", 7, 1), holdHours: n("LAST_SHOW_HOLD_HOURS", 24, 1),
        maxGapHours: n("LAST_SHOW_MAX_GAP_HOURS", 12, 1), minPoints: n("LAST_SHOW_MIN_POINTS", 4, 2),
        inventoryDropPercent: n("LAST_SHOW_INVENTORY_DROP_PERCENT", 20), holdTolerancePercent: n("LAST_SHOW_HOLD_TOLERANCE_PERCENT", 5),
        completionDelayHours: n("LAST_SHOW_COMPLETION_DELAY_HOURS", 3, 1), postHours: n("LAST_SHOW_POST_HOURS", 6, 1),
        postDropPercent: n("LAST_SHOW_POST_DROP_PERCENT", 10), postPriceRisePercent: n("LAST_SHOW_POST_PRICE_RISE_PERCENT", 5),
        comparisonPriceFloorPercent: n("LAST_SHOW_COMPARISON_PRICE_FLOOR_PERCENT", 90) };
}
const version = config => createHash("sha256").update(JSON.stringify(config) + require("fs").readFileSync(__filename, "utf8")).digest("hex");
const median = values => { const a = values.slice().sort((a,b) => a-b); return a.length ? (a[Math.floor((a.length-1)/2)] + a[Math.floor(a.length/2)]) / 2 : null; };
function points(history, field, from, to, allowZero) {
    const byTime = new Map();
    for (const row of history || []) {
        if (row.timestamp == null) continue;
        const timestamp = Number(row.timestamp), value = row[field] == null ? NaN : Number(row[field]);
        if (!Number.isFinite(timestamp) || timestamp < from || timestamp > to) continue;
        byTime.set(timestamp, { timestamp, value: Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) ? value : null });
    }
    return [...byTime.values()].sort((a,b) => a.timestamp-b.timestamp);
}
function metric(history, field, from, to, cfg, allowZero = false) {
    const rows = points(history, field, from, to, allowZero), gap = cfg.maxGapHours * HOUR;
    const first = rows[0], last = rows[rows.length-1];
    const complete = to > from && rows.length >= cfg.minPoints && rows.every(p => p.value != null)
        && first.timestamp-from <= gap && to-last.timestamp <= gap
        && rows.every((p,i) => !i || p.timestamp-rows[i-1].timestamp <= gap);
    const good = rows.filter(p => p.value != null);
    return { complete: !!complete, observations: rows.length, firstAt: first?.timestamp || null, lastAt: last?.timestamp || null,
        fromValue: first?.value ?? null, toValue: last?.value ?? null,
        dropPercent: complete && first.value > 0 ? (first.value-last.value)/first.value*100 : null,
        median: median(good.map(p=>p.value)), rows };
}
const clean = ({ rows, ...rest }) => rest;
function siteData(row, site) {
    return site === "tm" ? { history: row.history, count: "resale", price: "resaleMinPrice" }
        : { history: site === "vs" ? row.vsHistory : row.shHistory, count: "primary", price: "minPrice" };
}
function measure(row, from, to, cfg) {
    const primary = metric(row.history, "primary", from, to, cfg, true);
    const recentFrom = Math.max(from, to-48*HOUR);
    const primaryRecent = metric(row.history, "primary", recentFrom, to, cfg, true);
    const sites = {};
    for (const site of ["tm", "vs", "sh"]) {
        const data = siteData(row, site);
        const count = metric(data.history, data.count, from, to, cfg);
        const recentCount = metric(data.history, data.count, recentFrom, to, cfg);
        const price = metric(data.history, data.price, from, to, cfg);
        const holdEnd = price.rows[price.rows.length-1]?.timestamp ?? to;
        const target = holdEnd-cfg.holdHours*HOUR;
        const anchor = price.rows.filter(p=>p.timestamp <= target).slice(-1)[0];
        const holdFrom = anchor?.timestamp ?? target;
        const holding = price.rows.filter(p=>p.timestamp >= holdFrom);
        const baseline = median(price.rows.filter(p=>p.timestamp < holdFrom && p.value != null).map(p=>p.value));
        const held = price.complete && baseline > 0 && holding.length >= 2 && holding[holding.length-1].timestamp-holding[0].timestamp >= cfg.holdHours*HOUR
            && holding.every(p=>p.value >= baseline*(1-cfg.holdTolerancePercent/100));
        const adequate = primary.complete && primaryRecent.complete && count.complete && recentCount.complete && price.complete && baseline > 0
            && holding.length >= 2 && holding[holding.length-1].timestamp-holding[0].timestamp >= cfg.holdHours*HOUR;
        sites[site] = { adequate, supported: adequate && primary.dropPercent >= cfg.inventoryDropPercent
            && count.dropPercent >= cfg.inventoryDropPercent && primaryRecent.dropPercent > 0 && recentCount.dropPercent > 0 && held,
            inventory: clean(count), recentInventory: clean(recentCount), price: clean(price), priceHeld: !!held, baseline,
            holdingFrom: holdFrom, holdingTo: to };
    }
    return { from, to, primary: clean(primary), recentPrimary: clean(primaryRecent), sites,
        adequate: Object.values(sites).some(s=>s.adequate), supported: Object.values(sites).some(s=>s.supported) };
}
function postEvidence(row, priorStart, finalStart, now, site, cfg) {
    const marker = priorStart + cfg.completionDelayHours*HOUR;
    const duration = cfg.postHours*HOUR, end = Math.min(now, finalStart, marker+duration);
    const before = { from: priorStart-duration, to: priorStart }, after = { from: marker, to: end };
    if (end-marker < duration) return { ready: false, adequate: false, supported: false, marker, before, after, reason: "Waiting for post-performance observations" };
    const data = siteData(row, site);
    const prePrice = metric(data.history, data.price, before.from, before.to, cfg);
    const postPrice = metric(data.history, data.price, after.from, after.to, cfg);
    const primary = metric(row.history, "primary", after.from, after.to, cfg, true);
    const inventory = metric(data.history, data.count, after.from, after.to, cfg);
    const prePrimary = metric(row.history, "primary", before.from, before.to, cfg, true);
    const preInventory = metric(data.history, data.count, before.from, before.to, cfg);
    const adequate = [prePrice,postPrice,primary,inventory,prePrimary,preInventory].every(m=>m.complete);
    const priceRisePercent = prePrice.median > 0 && postPrice.median > 0 ? (postPrice.median/prePrice.median-1)*100 : null;
    const held = postPrice.complete && postPrice.rows.every(p=>p.value >= prePrice.median*(1-cfg.holdTolerancePercent/100));
    return { ready: true, adequate, marker, before, after, site, priceRisePercent, primary: clean(primary), inventory: clean(inventory),
        prePrimary: clean(prePrimary), preInventory: clean(preInventory), prePrice: clean(prePrice), postPrice: clean(postPrice),
        supported: adequate && primary.dropPercent >= cfg.postDropPercent && inventory.dropPercent >= cfg.postDropPercent
            && primary.dropPercent > prePrimary.dropPercent && inventory.dropPercent > preInventory.dropPercent
            && priceRisePercent >= cfg.postPriceRisePercent && held };
}
function evaluateLastShow(group, histories, now = Date.now(), cfg = settings()) {
    const events = (group.events || []).slice().sort((a,b)=>+new Date(a.eventDate)-+new Date(b.eventDate) || a.eventID.localeCompare(b.eventID));
    const last = events[events.length-1];
    const result = { status: "insufficient_data", reasons: [], evaluatedAt: new Date(now), ruleVersion: version(cfg), settings: cfg,
        seriesRevision: group.revision || 0, lastEventID: last?.eventID, evidence: [], eventWindows: [],
        histories: events.map(e=>({eventID:e.eventID, revision:histories.get(e.eventID)?.historyRevision || 0, updatedAt:histories.get(e.eventID)?.historyPulledAt || null})) };
    if (events.length < 2 || !last || !Number.isFinite(+new Date(last.eventDate))) { result.reasons.push("At least two dated shows are required"); return result; }
    const finalStart = +new Date(last.eventDate), lead = Math.max(0, finalStart-now), window = cfg.windowDays*DAY;
    if (finalStart <= now) { result.status = "watching"; result.reasons.push("Final known show has started; no upcoming signal"); return result; }
    if (lead >= window-cfg.holdHours*HOUR) { result.status = "watching"; result.reasons.push("Waiting for the equivalent pre-event observation window"); return result; }
    const final = measure(histories.get(last.eventID)||{}, finalStart-window, now, cfg);
    result.eventWindows.push({eventID:last.eventID,from:final.from,to:final.to});
    const completed = events.slice(0,-1).filter(e=>+new Date(e.eventDate)+cfg.completionDelayHours*HOUR <= now);
    if (!completed.length) { result.status = "watching"; result.reasons.push("No earlier performance has reached its estimated completion time"); return result; }
    let best = null, rank = -1;
    for (const earlier of completed) {
        const start = +new Date(earlier.eventDate), row = histories.get(earlier.eventID)||{};
        const nearShow = measure(row, start-window, start, cfg);
        const aligned = measure(row, start-window, start-lead, cfg);
        result.eventWindows.push({eventID:earlier.eventID,from:aligned.from,to:aligned.to});
        for (const site of ["tm","vs","sh"]) {
            const a=nearShow.sites[site], b=aligned.sites[site], c=final.sites[site];
            const comparable = b.adequate && c.adequate;
            const priceRatioPercent = b.price.toValue > 0 && c.price.toValue > 0 ? c.price.toValue/b.price.toValue*100 : null;
            const demand = a.supported && comparable && c.supported && priceRatioPercent >= cfg.comparisonPriceFloorPercent;
            const post = postEvidence(histories.get(last.eventID)||{}, start, finalStart, now, site, cfg);
            const status = demand && post.supported ? "last_show_supported" : demand ? "demand_supported"
                : a.adequate && comparable ? "watching" : "insufficient_data";
            const item = { earlierEventID:earlier.eventID, site, status, nearShow, aligned, final, priceRatioPercent, post };
            result.evidence.push(item);
            const score = ["insufficient_data","watching","demand_supported","last_show_supported"].indexOf(status);
            if (score > rank) { best=item; rank=score; }
        }
    }
    result.status=best.status; result.referenceEventID=best.earlierEventID; result.referenceSite=best.site;
    result.reasons = [result.status === "last_show_supported" ? "Earlier demand, equivalent-time strength and post-performance strengthening are supported"
        : result.status === "demand_supported" ? "Earlier and final-show demand are supported; post-performance strengthening is not yet confirmed"
        : result.status === "watching" ? "Available evidence does not meet the configured demand thresholds"
        : "Missing prices, counts, endpoint coverage, holding duration or fresh snapshots"];
    return result;
}
module.exports = { settings, version, metric, measure, evaluateLastShow };
