const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
require('../path');
test('Mongo: cross-city tour membership, history tracking, updates and separate API', {skip:!process.env.SERIES_TEST_MONGO_URI},async()=>{
    const base=process.env.SERIES_TEST_MONGO_URI;assert.match(base,/^mongodb:\/\/127\.0\.0\.1:27189\/?$/);
    const mongoose=require('mongoose'),uri=base+'/tour_test_'+randomUUID().replace(/-/g,'');
    const conn=await mongoose.createConnection(uri).asPromise();
    const tours=conn.model('tourOpportunity',require('../models/tourOpportunity'));
    const catalog=conn.model('seriesEvent',require('../models/seriesEvent'));
    const histories=conn.model('supplyChangeEvent',require('../models/supplyChangeEvent'));
    const db=require('../services/db');db.getTourModel=()=>tours;db.getSeriesEventModel=()=>catalog;db.getWatchlistModel=()=>histories;
    const {runTours}=require('../services/tours'),{evaluateTourBatch}=require('../services/laterTourOpportunity');
    let api;
    try {
        const day=86400000,now=Date.now();
        const event=(id,offset)=>({eventID:id,artistID:'artist',artist:'Artist',eventName:'Artist Example Tour',eligible:true,location:'City '+id,timezone:'UTC',eventDate:new Date(now+offset*day)});
        await catalog.create([event('a',-10),event('b',-8),event('c',-6),event('d',20)]);
        await runTours();let group=await tours.findOne({active:true}).lean();
        assert.equal(group.events.length,4);assert.deepEqual(group.targetEventIDs,['d']);
        assert.equal(await histories.countDocuments({tourTracked:true}),4);
        assert.equal((await histories.findOne({eventID:'a'})).passed,true);
        const id=group.seriesID,rev=group.revision;
        await runTours();assert.equal((await tours.findOne({seriesID:id})).revision,rev);
        assert.equal(await evaluateTourBatch(),1);assert.equal(await evaluateTourBatch(),0);
        await catalog.create(event('e',40));await runTours();group=await tours.findOne({seriesID:id}).lean();
        assert.equal(group.revision,rev+1);assert.equal(group.demand,null);assert.deepEqual(group.targetEventIDs,['d','e']);
        await evaluateTourBatch();
        const backend=require('node:path').resolve(__dirname,'../../eagleanalytix-backend');require('module-alias').addAlias('libs',backend+'/libs');
        process.env.ALERT_MONGODB_URI=uri;api=require(backend+'/libs/alertDb');
        const {getConcertSeries}=require(backend+'/services/concertSeriesService');
        const result=await getConcertSeries({pattern:'later_tour',limit:1});
        assert.equal(result.totalRecords,1);assert.equal(result.result[0].events.length,5);
        assert.equal((await getConcertSeries({pattern:'later_tour',status:'later_tour_supported'})).totalRecords,0);
        assert.equal((await getConcertSeries({pattern:'last_show_effect'})).totalRecords,0,'city series remain separate');
        await catalog.updateMany({},{$set:{eligible:false}});await runTours();
        assert.equal(await tours.countDocuments({active:true}),0);assert.equal(await histories.countDocuments({tourTracked:true}),0);
    }finally{if(api)await(await api.getSupplyChangeEventModel()).db.close();await conn.dropDatabase();await conn.close();}
});
