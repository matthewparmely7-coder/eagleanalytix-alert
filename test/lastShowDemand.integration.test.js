const test=require('node:test'), assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
require('../path');
test('Mongo: demand cache, invalidation guard, and API filtering before pagination', {skip:!process.env.SERIES_TEST_MONGO_URI}, async()=>{
    const base=process.env.SERIES_TEST_MONGO_URI;
    assert.match(base,/^mongodb:\/\/127\.0\.0\.1:27189\/?$/);
    const mongoose=require('mongoose');
    const uri=base+'/demand_test_'+randomUUID().replace(/-/g,'');
    const conn=await mongoose.createConnection(uri).asPromise();
    const series=conn.model('concertSeries',require('../models/concertSeries'));
    const histories=conn.model('supplyChangeEvent',require('../models/supplyChangeEvent'));
    const db=require('../services/db');db.getSeriesModel=()=>series;db.getWatchlistModel=()=>histories;
    const {evaluateSeriesBatch}=require('../services/lastShowDemand');
    let apiDb;
    try {
        const now=Date.now(), day=86400000;
        const events=[{eventID:'a',eventDate:new Date(now+day),timezone:'UTC'}, {eventID:'b',eventDate:new Date(now+2*day),timezone:'UTC'}];
        await series.create({seriesID:'one',active:true,revision:1,eventIDs:['a','b'],events,lastEventID:'b',lastEventDate:events[1].eventDate,candidateWindows:[{from:new Date(now-day),to:new Date(now+day)}]});
        await histories.create([{eventID:'a',historyRevision:1},{eventID:'b',historyRevision:1}]);
        assert.equal(await evaluateSeriesBatch(),1);
        assert.equal((await series.findOne({seriesID:'one'})).demand.status,'watching');
        assert.equal(await evaluateSeriesBatch(),0,'unchanged inputs skip evaluation');
        await histories.updateOne({eventID:'b'},{$inc:{historyRevision:1}});
        assert.equal(await evaluateSeriesBatch(),1,'changed history reevaluates');
        await histories.updateOne({eventID:'b'},{$inc:{historyRevision:1}});
        const update=series.updateOne.bind(series);
        series.updateOne=async(filter,change)=>{
            await update({seriesID:'one'},{$inc:{demandGeneration:1},$set:{demandExpiresAt:new Date(0)}});
            return update(filter,change);
        };
        assert.equal(await evaluateSeriesBatch(),0,'invalidation during evaluation prevents stale write');
        series.updateOne=update;
        assert.equal(await evaluateSeriesBatch(),1);
        const backend=require('node:path').resolve(__dirname,'../../eagleanalytix-backend');
        require('module-alias').addAlias('libs',backend+'/libs');
        process.env.ALERT_MONGODB_URI=uri;
        apiDb=require(backend+'/libs/alertDb');
        const {getConcertSeries}=require(backend+'/services/concertSeriesService');
        assert.equal((await getConcertSeries({status:'watching',limit:1})).totalRecords,1);
        assert.equal((await getConcertSeries({status:'last_show_supported'})).totalRecords,0);
        await series.updateOne({seriesID:'one'},{$set:{demandExpiresAt:new Date(0)}});
        assert.equal((await getConcertSeries({status:'watching'})).totalRecords,0);
        const result=await getConcertSeries({status:'insufficient_data'});
        assert.equal(result.totalRecords,1);assert.equal(result.result[0].demand.status,'insufficient_data');
    } finally {
        if(apiDb) await (await apiDb.getConcertSeriesModel()).db.close();
        await conn.dropDatabase();await conn.close();
    }
});
