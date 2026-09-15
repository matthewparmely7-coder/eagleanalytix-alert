const db=require('services/db');
const moment=require('moment-timezone');
const {hash}=require('./seriesGrouping');
const normalize=value=>String(value||'').trim().toLowerCase().replace(/\s+/g,' ');
function metadata(source,catalog,now=new Date()) {
    const info=source?.eventinfo||{}, rawVenue=info.venues||info._embedded?.venues||{};
    const venue=Array.isArray(rawVenue)?rawVenue[0]||{}:rawVenue;
    const classifications=Array.isArray(info.classifications)?info.classifications:[info.classifications];
    const type=normalize(classifications.find(Boolean)?.segment?.name);
    const attractions=info.attractions||info._embedded?.attractions||[];
    const ids=attractions.map(a=>a.id).filter(Boolean).sort();
    const artist=ids.length?ids.join('|'):catalog?.artistID;
    // Sports require both participants; a team alone can represent very different demand.
    const identity=type==='sports'?(ids.length>=2?'sports:'+ids.join('|'):null)
        :type==='music'&&artist?'music:'+artist+(/\btour\b/i.test(info.name||'')?':'+normalize(info.name):''):null;
    const city=normalize(venue.city?.name), state=normalize(venue.state?.stateCode||venue.state?.name), country=normalize(venue.country?.countryCode);
    const market=city&&country?[city,state,country].join('|'):null;
    const date=source?.UTCEventDate, tz=info.dates?.timezone||catalog?.timezone;
    const day=date&&moment.tz.zone(tz||'')?moment(date).tz(tz).day():null;
    const value={identity,market,venueID:venue.id||null,capacity:Number(venue.capacity)>0?Number(venue.capacity):null,
        dayClass:day==null?null:day===0||day===6?'weekend':'weekday',
        eligible:source ? !['cancelled','canceled','postponed','rescheduled'].includes(normalize(info.dates?.status?.code)) : null,
        soldOut:normalize(info.dates?.status?.code)==='soldout'};
    return {...value,key:hash(value),checkedAt:now};
}
async function refreshDemandMetadata(size=50,check=()=>{}) {
    const model=db.getWatchlistModel(),now=new Date();
    const rows=await model.find({UTCEventDate:{$gte:new Date(+now-90*86400000)},$or:[
        {'demandMetadata.checkedAt':null},{'demandMetadata.checkedAt':{$lt:new Date(+now-86400000)}}
    ]}).sort({'demandMetadata.checkedAt':1,UTCEventDate:1}).limit(size).select('eventID UTCEventDate').lean();
    if(!rows.length)return 0;
    const ids=rows.map(r=>r.eventID);
    const [sources,catalog]=await Promise.all([db.getTmEventsModel().find({eventID:{$in:ids}}).select('eventID eventinfo UTCEventDate active').lean(),
        db.getSeriesEventModel().find({eventID:{$in:ids}}).select('eventID artistID timezone').lean()]);
    const byID=new Map(sources.map(r=>[r.eventID,r])), artists=new Map(catalog.map(r=>[r.eventID,r]));
    for(const row of rows) {check();await model.updateOne({eventID:row.eventID,UTCEventDate:row.UTCEventDate},{$set:{
        demandMetadata:metadata(byID.get(row.eventID),artists.get(row.eventID),now),resaleDemandNextAt:new Date(0),resaleDemandExpiresAt:new Date(0)
    },$inc:{resaleDemandGeneration:1}});
        await model.updateMany({'resaleDemand.peers.eventID':row.eventID},{$set:{resaleDemandNextAt:new Date(0),resaleDemandExpiresAt:new Date(0)},$inc:{resaleDemandGeneration:1}});
    }
    return rows.length;
}
module.exports={metadata,refreshDemandMetadata};
