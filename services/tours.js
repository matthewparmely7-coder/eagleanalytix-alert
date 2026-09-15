const { randomUUID }=require("crypto");
const { getSeriesEventModel,getTourModel,getWatchlistModel }=require("services/db");
const { groupTours }=require("./tourGrouping");
const { hash }=require("./seriesGrouping");
const { settings }=require("../patterns/laterTourOpportunity");
async function runTours(check=()=>{}) {
    const cfg=settings(), model=getTourModel(), now=Date.now();
    const catalog=await getSeriesEventModel().find({eligible:true}).lean();
    const runs=groupTours(catalog,cfg.gapDays), old=await model.find({}).lean(), available=new Map(old.map(g=>[g.seriesID,g]));
    const keep=[], tracked=new Map();
    for(const run of runs){
        check();const ids=run.events.map(e=>e.eventID), set=new Set(ids);
        let previous=null, overlap=0;
        for(const g of available.values()){if(g.groupKey!==run.groupKey)continue;const count=g.eventIDs.filter(id=>set.has(id)).length;if(count>overlap){previous=g;overlap=count;}}
        if(previous)available.delete(previous.seriesID);
        const seriesID=previous?.seriesID||randomUUID(), references=run.events.slice(0,cfg.earlyShows), later=run.events.slice(cfg.earlyShows);
        const targets=later.filter(e=>+new Date(e.eventDate)>now && +new Date(e.eventDate)<=now+cfg.candidateDays*86400000);
        const view=targets.length?[...references,...targets]:[];
        for(const e of view)tracked.set(e.eventID,e);
        const events=run.events.map(e=>({eventID:e.eventID,eventName:e.eventName,artist:e.artist,location:e.location,venue:e.venue,eventDate:e.eventDate,timezone:e.timezone}));
        const fingerprint=hash(["tour-v1",cfg.gapDays,cfg.earlyShows,cfg.candidateDays,events,view.map(e=>e.eventID)]);
        const changed=!previous||previous.fingerprint!==fingerprint||!previous.active;
        const update={$set:{checkedAt:new Date(now),active:true}};
        if(changed){Object.assign(update.$set,{groupKey:run.groupKey,tourName:events[0].eventName,artistID:run.events[0].artistID,artist:events[0].artist,
            membership:"inferred_artist_and_tour_title",coverage:"inferred_tour",events,eventIDs:ids,
            referenceEventIDs:references.map(e=>e.eventID),targetEventIDs:targets.map(e=>e.eventID),viewEventIDs:view.map(e=>e.eventID),
            firstEventDate:events[0].eventDate,lastEventDate:events[events.length-1].eventDate,lastEventID:ids[ids.length-1],
            candidateWindows:later.map(e=>({from:new Date(+new Date(e.eventDate)-cfg.candidateDays*86400000),to:e.eventDate})),
            fingerprint,updatedAt:new Date(now),demand:null,demandInputKey:null,demandExpiresAt:new Date(0)});update.$inc={revision:1};}
        await model.updateOne({seriesID},update,{upsert:true});keep.push(seriesID);
    }
    check();await model.updateMany({active:true,seriesID:{$nin:keep}},{$set:{active:false,demandExpiresAt:new Date(0)},$inc:{revision:1}});
    const histories=getWatchlistModel(), ids=[...tracked.keys()];
    await histories.updateMany({tourTracked:true,eventID:{$nin:ids}},{$set:{tourTracked:false}});
    for(let start=0;start<ids.length;start+=200){check();await histories.bulkWrite(ids.slice(start,start+200).map(id=>{const e=tracked.get(id);return {updateOne:{filter:{eventID:id},update:{$set:{tourTracked:true,eventName:e.eventName,UTCEventDate:e.eventDate,timezone:e.timezone,venue:e.venue,passed:+new Date(e.eventDate)<now},$setOnInsert:{pulledAt:new Date(now),historyUpdated:false}},upsert:true}};}));}
    console.log(`[tours] groups=${keep.length}, tracked histories=${ids.length}`);
}
module.exports={runTours};
