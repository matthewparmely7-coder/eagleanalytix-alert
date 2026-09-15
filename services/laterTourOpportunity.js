const { getTourModel, getWatchlistModel } = require("services/db");
const { evaluateLaterTour, settings, version } = require("../patterns/laterTourOpportunity");
const { hash } = require("./seriesGrouping");
const interval = () => Math.max(Number(process.env.LATER_TOUR_RECHECK_MS) || 900000, 1000);
const stamp = rows => rows.map(r=>[r.eventID,r.historyRevision||0,r.historyFingerprint||"",r.historyPulledAt||null]).sort((a,b)=>a[0].localeCompare(b[0]));
async function evaluateTourBatch(batchSize = 10, check = () => {}) {
    const series = getTourModel(), histories = getWatchlistModel(), now = Date.now(), cfg = settings(), rule = version(cfg);
    const groups = await series.find({active:true,candidateWindows:{$elemMatch:{from:{$lte:new Date(now)},to:{$gte:new Date(now)}}}})
        .sort({demandEvaluatedAt:1,seriesID:1}).lean();
    const ids=[...new Set(groups.flatMap(g=>g.eventIDs))];
    const metadata=await histories.find({eventID:{$in:ids}},{eventID:1,historyRevision:1,historyFingerprint:1,historyPulledAt:1}).lean();
    const meta=new Map(metadata.map(r=>[r.eventID,r]));
    let processed=0;
    for (const group of groups) {
        if (processed >= batchSize) break;
        check();
        const inputRows=group.eventIDs.map(id=>meta.get(id)).filter(Boolean);
        const input=hash([group.revision,rule,stamp(inputRows),Math.floor(now/interval())]);
        if (input === group.demandInputKey) continue;
        const rows=await histories.find({eventID:{$in:group.eventIDs}}, {eventID:1,history:1,vsHistory:1,shHistory:1,historyRevision:1,historyFingerprint:1,historyPulledAt:1}).lean();
        if (hash(stamp(rows)) !== hash(stamp(inputRows))) continue;
        const result=evaluateLaterTour(group,new Map(rows.map(r=>[r.eventID,r])),now,cfg);
        const fresh=await histories.find({eventID:{$in:group.eventIDs}},{eventID:1,historyRevision:1,historyFingerprint:1,historyPulledAt:1}).lean();
        if (hash(stamp(fresh)) !== hash(stamp(rows))) continue;
        check();
        const saved=await series.updateOne({seriesID:group.seriesID,active:true,revision:group.revision,
            demandGeneration:group.demandGeneration == null ? {$exists:false} : group.demandGeneration},{$set:{
            demand:result,demandInputKey:input,demandEvaluatedAt:new Date(now),demandExpiresAt:new Date(now+interval()*2)
        }});
        processed+=saved.modifiedCount;
    }
    return processed;
}
module.exports={evaluateTourBatch};
