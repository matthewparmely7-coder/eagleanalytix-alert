const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
require('../path');
const {metadata}=require('../services/resaleDemandMetadata');
test('peer metadata requires an explicit market, participant identity and comparable venue',()=>{
    const source={UTCEventDate:new Date('2026-09-19T20:00:00Z'),eventinfo:{name:'Tour',classifications:[{segment:{name:'Music'}}],
        attractions:[{id:'artist'}],venues:{id:'venue',city:{name:'New York'},country:{countryCode:'US'}},dates:{timezone:'America/New_York',status:{code:'offsale'}}}};
    const m=metadata(source);assert.equal(m.soldOut,false);assert.equal(m.capacity,null);assert.equal(m.dayClass,'weekend');
    source.eventinfo.classifications[0].segment.name='Sports';assert.equal(metadata(source).identity,null);
    source.eventinfo.attractions.push({id:'opponent'});assert.equal(metadata(source).identity,'sports:artist|opponent');
    assert.equal(metadata({}).identity,null);
});
test('Mongo: isolated result, refresh guards, strict resale prices and status filtering', {skip:!process.env.SERIES_TEST_MONGO_URI},async()=>{
    assert.match(process.env.SERIES_TEST_MONGO_URI,/^mongodb:\/\/127\.0\.0\.1:27189\/?$/);
    const mongoose=require('mongoose'),uri=process.env.SERIES_TEST_MONGO_URI+'/resale_demand_test_'+randomUUID().replace(/-/g,'');
    const conn=await mongoose.createConnection(uri).asPromise(),model=conn.model('supplyChangeEvent',require('../models/supplyChangeEvent'));
    const db=require('../services/db');db.getWatchlistModel=()=>model;
    const {evaluateDemandBatch}=require('../services/lowerResaleDemand');let apiDb;
    try {
        const now=Date.now(),H=3600000,history=Array.from({length:29},(_,i)=>({timestamp:now-168*H+i*6*H,
            primary:Math.max(20,400-i*16),resale:150-i*3,resaleMinPrice:100,minPrice:20,primaryMinPrice:20}));
        await model.create([{eventID:'supported',UTCEventDate:new Date(now+86400000),history,historyRevision:1,patterns:{rocket:{tm:{hit:true}}}},
            {eventID:'empty',UTCEventDate:new Date(now+86400000)}]);
        assert.equal(await evaluateDemandBatch(),2);assert.equal(await evaluateDemandBatch(),0);
        assert.equal((await model.findOne({eventID:'supported'}).lean()).patterns.rocket.tm.hit,true);
        // Concurrent invalidation must win over a detector finishing with older inputs.
        await model.updateOne({eventID:'supported'},{$set:{resaleDemandNextAt:new Date(0)}});
        const update=model.updateOne.bind(model);
        model.updateOne=async(filter,change)=>{await update({eventID:'supported'},{$inc:{resaleDemandGeneration:1}});return update(filter,change);};
        assert.equal(await evaluateDemandBatch(),0);model.updateOne=update;assert.equal(await evaluateDemandBatch(),1);
        const backend=require('node:path').resolve(__dirname,'../../eagleanalytix-backend');process.env.ALERT_MONGODB_URI=uri;
        apiDb=require(backend+'/libs/alertDb');const {getLowerResaleDemand}=require(backend+'/services/lowerResaleDemandService');
        let response=await getLowerResaleDemand({demandStatus:'supported',limit:1});
        assert.equal(response.recordsFiltered,1);assert.equal(response.result[0].tm.priceSeries[0].value,100);
        assert.equal(response.result[0].tm.countSeries.at(-1).value,20);
        assert.equal((await getLowerResaleDemand({demandStatus:'supported',offset:1})).result.length,0);
        await model.updateOne({eventID:'supported'},{$inc:{historyRevision:1}});
        assert.equal((await getLowerResaleDemand({demandStatus:'supported'})).recordsFiltered,0);
        response=await getLowerResaleDemand({demandStatus:'insufficient_data'});assert.equal(response.recordsFiltered,2);
    }finally{if(apiDb)await (await apiDb.getSupplyChangeEventModel()).db.close();await conn.dropDatabase();await conn.close();}
});
