const db=require('services/db');
const {hash}=require('./seriesGrouping');
const {settings,version,evaluate}=require('../patterns/lowerResaleDemand');
const DAY=86400000;
async function evaluateDemandBatch(size=10,check=()=>{}) {
    const model=db.getWatchlistModel(), now=Date.now(), cfg=settings(), rules=version(cfg);
    const batch=await model.find({UTCEventDate:{$gt:new Date(now),$lte:new Date(now+cfg.horizonDays*DAY)},$or:[
        {resaleDemandNextAt:null},{resaleDemandNextAt:{$lte:new Date(now)}},{'resaleDemand.ruleVersion':{$ne:rules}}
    ]}).sort({resaleDemandNextAt:1,UTCEventDate:1}).limit(size).lean();
    let processed=0;
    for(const row of batch) {
        check();
        const meta=row.demandMetadata||{};
        const peers=meta.identity && meta.market ? await model.find({eventID:{$ne:row.eventID},
            'demandMetadata.identity':meta.identity,'demandMetadata.market':meta.market,
            UTCEventDate:{$gte:new Date(+row.UTCEventDate-90*DAY),$lte:row.UTCEventDate}
        }).sort({UTCEventDate:-1}).limit(100).lean():[];
        const stamps=peers.map(p=>[p.eventID,p.historyRevision||0,p.demandMetadata?.key,+new Date(p.UTCEventDate)]);
        const inputKey=hash([row.historyRevision||0,meta.key,+row.UTCEventDate,stamps,rules,Math.floor(now/900000)]);
        const result=evaluate(row,peers,now,cfg);
        check();
        // Do not publish a result calculated while a peer's history or membership changed.
        const current=peers.length?await model.find({eventID:{$in:peers.map(p=>p.eventID)}})
            .select('eventID historyRevision demandMetadata.key UTCEventDate').sort({UTCEventDate:-1}).lean():[];
        const canonical=list=>hash(list.map(p=>[p.eventID,p.historyRevision||0,p.demandMetadata?.key,+new Date(p.UTCEventDate)]).sort((a,b)=>a[0].localeCompare(b[0])));
        if(canonical(current)!==canonical(peers)) continue;
        const saved=await model.updateOne({eventID:row.eventID,UTCEventDate:row.UTCEventDate,
            resaleDemandGeneration:row.resaleDemandGeneration==null?{$exists:false}:row.resaleDemandGeneration,
            historyRevision:row.historyRevision==null?{$exists:false}:row.historyRevision,
            'demandMetadata.key':meta.key==null?null:meta.key},{$set:{resaleDemand:result,resaleDemandInputKey:inputKey,
            resaleDemandNextAt:new Date(now+900000),resaleDemandExpiresAt:new Date(now+1800000)}});
        processed+=saved.modifiedCount||0;
    }
    return processed;
}
module.exports={evaluateDemandBatch};
