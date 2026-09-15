const { settings: demandSettings, measure, metric } = require("./lastShowDemand");
const { hash } = require("../services/seriesGrouping");
const DAY = 86400000, HOUR = 3600000;
function settings() {
    const n=(key,fallback,min=0)=>Math.max(min, process.env[key] != null && process.env[key] !== "" && Number.isFinite(Number(process.env[key])) ? Number(process.env[key]) : fallback);
    return { ...demandSettings(), earlyShows:Math.floor(n("LATER_TOUR_EARLY_SHOWS",3,1)), minEarlyShows:Math.floor(n("LATER_TOUR_MIN_EARLY_SHOWS",2,1)),
        candidateDays:n("LATER_TOUR_CANDIDATE_DAYS",90,1), gapDays:n("LATER_TOUR_GAP_DAYS",30,1),
        accelerationRatio:n("LATER_TOUR_ACCELERATION_RATIO",1.2,1), priceRisePercent:n("LATER_TOUR_PRICE_RISE_PERCENT",5), laterDropPercent:n("LATER_TOUR_INVENTORY_DROP_PERCENT",10),
        windowDays:n("LATER_TOUR_WINDOW_DAYS",7,1), holdHours:n("LATER_TOUR_HOLD_HOURS",24,1),
        maxGapHours:n("LATER_TOUR_MAX_GAP_HOURS",12,1) };
}
const version=cfg=>hash(["later-tour-v1",cfg,require("fs").readFileSync(__filename,"utf8"),require("fs").readFileSync(require.resolve("./lastShowDemand"),"utf8")]);
function marketStrength(window, site, drop) {
    const s=window.sites[site];
    const inventoryAvailable=window.primary.complete || s.inventory.complete;
    const declining=(window.primary.complete && window.primary.dropPercent>=drop) || (s.inventory.complete && s.inventory.dropPercent>=drop);
    const adequate=s.price.complete && s.baseline>0 && inventoryAvailable;
    return { adequate, supported:adequate && s.priceHeld && declining };
}
function evaluateLaterTour(group, histories, now=Date.now(), cfg=settings()) {
    const events=(group.events||[]).slice().sort((a,b)=>+new Date(a.eventDate)-+new Date(b.eventDate)||a.eventID.localeCompare(b.eventID));
    const refs=events.slice(0,cfg.earlyShows), candidates=events.slice(cfg.earlyShows)
        .filter(e=>+new Date(e.eventDate)>now && +new Date(e.eventDate)<=now+cfg.candidateDays*DAY);
    const result={status:"watching",reasons:[],ruleVersion:version(cfg),settings:cfg,seriesRevision:group.revision||0,evaluatedAt:new Date(now),
        membership:"inferred_artist_and_tour_title",socialHype:"not_measured",eventResults:[],eventWindows:[],
        histories:events.filter(e=>refs.includes(e)||candidates.includes(e)).map(e=>({eventID:e.eventID,revision:histories.get(e.eventID)?.historyRevision||0,updatedAt:histories.get(e.eventID)?.historyPulledAt||null}))};
    const completed=refs.filter(e=>+new Date(e.eventDate)+cfg.completionDelayHours*HOUR<=now);
    const early=completed.map(e=>({eventID:e.eventID,eventDate:+new Date(e.eventDate),location:e.location,
        window:measure(histories.get(e.eventID)||{},+new Date(e.eventDate)-cfg.windowDays*DAY,+new Date(e.eventDate),cfg)}));
    const tourStart=events.length?+new Date(events[0].eventDate):now;
    for(const target of candidates) {
        const out={eventID:target.eventID,status:"watching",reasons:[],evidence:[],eventWindows:[]};
        if(completed.length<cfg.minEarlyShows) {out.reasons=["Waiting for enough early tour performances to finish"];result.eventResults.push(out);continue;}
        const row=histories.get(target.eventID)||{}, end=+new Date(target.eventDate), lead=end-now;
        for(const site of ["tm","vs","sh"]) {
            const qualified=early.filter(e=>marketStrength(e.window,site,cfg.inventoryDropPercent).supported);
            const reference=qualified[qualified.length-1] || early[early.length-1];
            const marker=reference.eventDate+cfg.completionDelayHours*HOUR;
            const from=Math.max(now-cfg.windowDays*DAY,marker);
            const current=measure(row,from,now,cfg), strength=marketStrength(current,site,cfg.laterDropPercent);
            const before=measure(row,tourStart-cfg.windowDays*DAY,tourStart,cfg);
            const beforeSite=before.sites[site], curSite=current.sites[site];
            const priceRisePercent=beforeSite.price.median>0 && curSite.price.median>0 ? (curSite.price.median/beforeSite.price.median-1)*100:null;
            const duration=now-from;
            const rate=m=>m.complete&&m.fromValue>0&&m.toValue>0&&m.lastAt>m.firstAt ? Math.log(m.fromValue/m.toValue)/((m.lastAt-m.firstAt)/HOUR) : null;
            const primaryRate=rate(current.primary), beforePrimaryRate=rate(before.primary);
            const resaleRate=rate(curSite.inventory), beforeResaleRate=rate(beforeSite.inventory);
            const primaryAcceleration=primaryRate!=null&&beforePrimaryRate!=null&&primaryRate>Math.max(0,beforePrimaryRate)*cfg.accelerationRatio+1e-12;
            const resaleAcceleration=resaleRate!=null&&beforeResaleRate!=null&&resaleRate>Math.max(0,beforeResaleRate)*cfg.accelerationRatio+1e-12;
            const enoughTime=duration>cfg.holdHours*HOUR;
            const earlyOK=qualified.length>=cfg.minEarlyShows;
            const beforeAvailable=beforeSite.price.complete && ((current.primary.complete&&before.primary.complete)||(curSite.inventory.complete&&beforeSite.inventory.complete));
            const postOK=strength.supported && beforeAvailable && curSite.price.median >= beforeSite.price.median*(1-cfg.holdTolerancePercent/100) && (priceRisePercent>=cfg.priceRisePercent || primaryAcceleration || resaleAcceleration);
            const earlyAvailable=early.filter(e=>marketStrength(e.window,site,cfg.inventoryDropPercent).adequate).length>=cfg.minEarlyShows;
            const status=!enoughTime?"watching":!earlyAvailable||!strength.adequate?"insufficient_data":earlyOK&&postOK?"later_tour_supported":earlyOK&&strength.supported?"demand_supported":"watching";
            // Equivalent-stage evidence is optional: it never compares different cities' absolute price levels.
            const aligned=measure(histories.get(reference.eventID)||{},reference.eventDate-lead-cfg.windowDays*DAY,reference.eventDate-lead,cfg);
            const laterAligned=measure(row,now-cfg.windowDays*DAY,now,cfg);
            out.evidence.push({site,status,referenceEventID:reference.eventID,qualifyingEarlyEventIDs:qualified.map(e=>e.eventID),early:early.map(e=>({eventID:e.eventID,window:e.window})),
                current,before,aligned,laterAligned,priceRisePercent,primaryAcceleration:!!primaryAcceleration,resaleAcceleration:!!resaleAcceleration,
                marker,primaryRate,beforePrimaryRate,resaleRate,beforeResaleRate,holdingHours:cfg.holdHours,comparisonAvailable:marketStrength(aligned,site,0).adequate&&marketStrength(laterAligned,site,0).adequate});
        }
        const rank=s=>["insufficient_data","watching","demand_supported","later_tour_supported"].indexOf(s);
        const best=out.evidence.reduce((a,b)=>rank(b.status)>rank(a.status)?b:a);
        out.status=best.status;out.referenceEventID=best.referenceEventID;out.referenceSite=best.site;
        out.eventWindows=[{eventID:target.eventID,from:best.current.from,to:best.current.to}];
        out.reasons=[out.status==="later_tour_supported"?"Early tour demand and later-date strengthening after early performances are supported"
            :out.status==="demand_supported"?"Early and later-date demand are supported; post-start strengthening is not confirmed"
            :out.status==="insufficient_data"?"Missing or stale price/count observations or pre-tour coverage":"Waiting for observations or demand thresholds"];
        result.eventResults.push(out);
    }
    const rank=s=>["insufficient_data","watching","demand_supported","later_tour_supported"].indexOf(s);
    const best=result.eventResults.reduce((a,b)=>!a||rank(b.status)>rank(a.status)?b:a,null);
    if(best){result.status=best.status;result.reasons=best.reasons;result.targetEventID=best.eventID;result.referenceEventID=best.referenceEventID;result.referenceSite=best.referenceSite;}
    else result.reasons=["No later tour dates in the configured upcoming window"];
    return result;
}
module.exports={settings,version,marketStrength,evaluateLaterTour};
