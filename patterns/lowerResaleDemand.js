const { metric } = require('./lastShowDemand');
const { createHash } = require('crypto');
const HOUR = 3600000, DAY = 24 * HOUR;
const median = values => { const v = values.slice().sort((a,b)=>a-b); return v.length ? (v[Math.floor((v.length-1)/2)]+v[Math.floor(v.length/2)])/2 : null; };
const clean = ({rows, ...value}) => value;
function settings() {
    const n = (key, fallback, min=0) => Math.max(min, Number(process.env['LOWER_RESALE_' + key]) || fallback);
    return { windowDays:n('WINDOW_DAYS',7,3), maxGapHours:n('MAX_GAP_HOURS',12,1), minPoints:4,
        lowCount:n('MAX_COUNT',150,1), nearPrimary:n('NEAR_PRIMARY',50,1), primaryDrop:n('PRIMARY_DROP_PERCENT',25),
        countDrop:n('COUNT_DROP_PERCENT',10), priceRise:n('PRICE_RISE_PERCENT',10), holdTolerance:5,
        peerRatio:Math.min(n('PEER_RATIO',0.5),1), minPeers:n('MIN_PEERS',3,3), horizonDays:21 };
}
const version = cfg => createHash('sha256').update(JSON.stringify(cfg)+require('fs').readFileSync(__filename)).digest('hex');
function measure(row, now, cfg) {
    const from = now-cfg.windowDays*DAY, sites = {};
    for (const site of ['tm','vs','sh']) {
        const history = row[site==='tm'?'history':site==='vs'?'vsHistory':'shHistory'] || [];
        const countField = site==='tm'?'resale':'primary', priceField=site==='tm'?'resaleMinPrice':'minPrice';
        const inventory = metric(history,countField,now-48*HOUR,now,cfg);
        const price = metric(history,priceField,now-48*HOUR,now,cfg);
        const latest = metric(history,countField,now-cfg.maxGapHours*HOUR,now,{...cfg,minPoints:1});
        const baseline = median(price.rows.filter(p=>p.timestamp<now-24*HOUR && p.value!=null).map(p=>p.value));
        const anchor = price.rows.filter(p=>p.timestamp<=now-24*HOUR).slice(-1)[0];
        const holding = price.rows.filter(p=>anchor && p.timestamp>=anchor.timestamp);
        const fullHold = holding.length>=2 && holding[holding.length-1].timestamp-holding[0].timestamp>=24*HOUR;
        const priceHeld = price.complete && baseline>0 && fullHold && holding.every(p=>p.value>=baseline*(1-cfg.holdTolerance/100));
        const priceRisePercent = baseline>0 && price.toValue>0 ? (price.toValue/baseline-1)*100 : null;
        const riseHeld = priceHeld && holding.every(p=>p.value>=baseline*(1+cfg.priceRise/100));
        const adequate = inventory.complete && price.complete && fullHold && baseline>0;
        sites[site] = { adequate, low:latest.toValue>0 && latest.toValue<=cfg.lowCount,
            latestCount:latest.toValue, fresh:latest.toValue>0 && latest.lastAt>=now-cfg.maxGapHours*HOUR,
            inventory:clean(inventory), price:clean(price), baseline, priceRisePercent, priceHeld,
            demand:adequate && priceHeld && (riseHeld || inventory.dropPercent>=cfg.countDrop) };
    }
    const primary=metric(row.history,'primary',from,now,cfg,true);
    const near=metric(row.history,'primary',now-24*HOUR,now,cfg,true);
    const persistentNear=near.complete && near.rows[near.rows.length-1].timestamp-near.rows[0].timestamp>=12*HOUR
        && near.rows.every(p=>p.value<=cfg.nearPrimary);
    const confirmed= row.demandMetadata?.soldOut===true && +new Date(row.demandMetadata.checkedAt)>=now-DAY;
    return {from,to:now,primary:clean(primary),persistentNear,confirmed,
        primaryReady:confirmed || (primary.complete && primary.dropPercent>=cfg.primaryDrop && persistentNear),sites};
}
function comparable(a,b) {
    const x=a.demandMetadata||{}, y=b.demandMetadata||{};
    return !!(x.eligible!==false && y.eligible!==false && x.identity && x.market && x.dayClass && x.identity===y.identity && x.market===y.market && x.dayClass===y.dayClass
        && ((x.venueID && x.venueID===y.venueID) || (x.capacity>0 && y.capacity>0 && Math.abs(x.capacity/y.capacity-1)<=0.25)));
}
function evaluate(row, peers=[], now=Date.now(), cfg=settings()) {
    const result={status:'insufficient_data',reasons:[],routes:[],sites:{},peers:[],evaluatedAt:new Date(now),
        historyRevision:row.historyRevision||0,eventDate:row.UTCEventDate,metadataKey:row.demandMetadata?.key||null,
        ruleVersion:version(cfg),settings:cfg,score:0};
    const start=+new Date(row.UTCEventDate);
    if (row.demandMetadata?.eligible===false) {result.reasons=['Event is cancelled, postponed or rescheduled'];return result;}
    if (!Number.isFinite(start) || start<=now || start>now+cfg.horizonDays*DAY) {result.reasons=['Outside the upcoming event window'];return result;}
    const target=measure(row,now,cfg); result.evidence=target; result.sites=target.sites;
    const fresh=Object.values(target.sites).filter(s=>s.fresh);
    const low=fresh.length>0 && fresh.every(s=>s.low);
    if (target.primaryReady && low && Object.values(target.sites).some(s=>s.low&&s.demand)) result.routes.push('primary_sellout');
    const lead=start-now, seen=new Set([row.eventID]);
    for(const peer of peers) {
        if(seen.has(peer.eventID) || !comparable(row,peer)) continue;
        seen.add(peer.eventID);
        const end=+new Date(peer.UTCEventDate)-lead;
        if(!Number.isFinite(end) || end>now || Math.abs(+new Date(peer.UTCEventDate)-start)>90*DAY) continue;
        const measured=measure(peer,end,cfg);
        result.peers.push({eventID:peer.eventID,eventName:peer.eventName,eventDate:peer.UTCEventDate,
            from:end-cfg.windowDays*DAY,to:end,historyRevision:peer.historyRevision||0,sites:measured.sites});
    }
    for (const site of ['tm','vs','sh']) {
        const targetSite=target.sites[site], good=result.peers.filter(p=>p.sites[site].demand);
        const typical=median(good.map(p=>p.sites[site].latestCount));
        const typicalDrop=median(good.map(p=>p.sites[site].inventory.dropPercent));
        const typicalRise=median(good.map(p=>p.sites[site].priceRisePercent));
        const supported=good.length>=cfg.minPeers && targetSite.demand && targetSite.latestCount<typical*cfg.peerRatio
            && (targetSite.inventory.dropPercent>=typicalDrop || targetSite.priceRisePercent>=typicalRise);
        targetSite.comparison={peers:good.length,medianCount:typical,medianDropPercent:typicalDrop,medianRisePercent:typicalRise,supported};
        if(supported && !result.routes.includes('comparable_events')) result.routes.push('comparable_events');
    }
    const routeData=target.primary.complete || target.confirmed || ['tm','vs','sh'].some(site=>result.peers.filter(p=>p.sites[site].adequate).length>=cfg.minPeers);
    result.status=result.routes.length?'supported':routeData && Object.values(target.sites).some(s=>s.adequate)?'watching':'insufficient_data';
    if(result.routes.includes('primary_sellout')) result.reasons.push(target.confirmed?'Confirmed sellout, scarce resale and strengthening demand':'Primary declined to persistently low supply; scarce resale and strengthening demand');
    if(result.routes.includes('comparable_events')) result.reasons.push('Resale is below comparable high-demand events at equal lead time');
    if(!result.routes.length) {
        if(!Object.values(target.sites).some(s=>s.adequate)) result.reasons.push('Need fresh resale counts and resale prices covering 48 hours, including a full 24-hour price hold');
        if(!target.primaryReady) result.reasons.push('Primary sellout or sustained decline to near-sellout is not established');
        if(!low) result.reasons.push('Available resale inventories are not all below the low-supply threshold');
        if(!Object.values(target.sites).some(s=>s.demand)) result.reasons.push('Demand strengthening is not established');
        if(!result.peers.length) result.reasons.push('No comparable events with matching identity, market, day type and venue/capacity');
        else result.reasons.push('Comparable-event evidence does not meet the configured thresholds');
    }
    result.score=Math.max(0,...Object.values(target.sites).filter(s=>s.demand).map(s=>Math.max(s.inventory.dropPercent||0,s.priceRisePercent||0)));
    return result;
}
module.exports={settings,version,measure,comparable,evaluate};
