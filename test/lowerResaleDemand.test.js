const test=require('node:test'),assert=require('node:assert/strict');
const {evaluate,settings,comparable}=require('../patterns/lowerResaleDemand');
const H=3600000,D=24*H,now=Date.UTC(2026,8,15,12),cfg=settings();
function event(id='target',start=now+3*D) {
    const history=[];
    for(let i=0;i<=28;i++) {
        const timestamp=now-7*D+i*6*H;
        history.push({timestamp,primary:Math.max(20,400-i*16),resale:150-i*3,resaleMinPrice:100,primaryMinPrice:20,minPrice:20});
    }
    return {eventID:id,eventName:id,UTCEventDate:new Date(start),history,historyRevision:1,
        demandMetadata:{identity:'music:artist',market:'city',dayClass:'weekend',venueID:'v',key:'key',checkedAt:new Date(now)}};
}
test('persistent primary depletion plus low declining resale and holding resale price supports route one',()=>{
    const r=evaluate(event(),[],now,cfg);assert.equal(r.status,'supported');assert.deepEqual(r.routes,['primary_sellout']);
    assert.equal(r.sites.tm.price.toValue,100);assert.equal(r.sites.tm.priceHeld,true);
});
test('zero TM resale and primary-only prices cannot produce a signal',()=>{
    const row=event();row.history.forEach(p=>{p.resale=0;p.resaleMinPrice=null;p.minPrice=200;});
    assert.equal(evaluate(row,[],now,cfg).status,'insufficient_data');
});
test('one primary low snapshot or constant zero primary is not proof of sellout',()=>{
    const row=event();row.history.forEach(p=>p.primary=400);row.history.at(-1).primary=0;
    assert.equal(evaluate(row,[],now,cfg).routes.length,0);
    row.history.forEach(p=>p.primary=0);assert.equal(evaluate(row,[],now,cfg).routes.length,0);
    row.demandMetadata.soldOut=true;assert.equal(evaluate(row,[],now,cfg).status,'supported');
    row.demandMetadata.checkedAt=new Date(now-2*D);assert.equal(evaluate(row,[],now,cfg).routes.length,0);
});
test('another marketplace with plentiful resale contradicts absolute low supply',()=>{
    const row=event();row.vsHistory=row.history.map(p=>({...p,primary:1000,minPrice:100}));
    assert.equal(evaluate(row,[],now,cfg).routes.length,0);
});
test('stale observations, missing values and gaps cannot support demand',()=>{
    for(const mutate of [r=>r.history=r.history.filter(p=>p.timestamp<now-18*H),
        r=>r.history.at(-3).resaleMinPrice=null,r=>r.history=r.history.filter(p=>p.timestamp<now-30*H||p.timestamp>now-12*H)]) {
        const row=event();mutate(row);assert.equal(evaluate(row,[],now,cfg).status,'insufficient_data');
    }
});
test('a brief price spike without resale depletion does not satisfy a full day hold',()=>{
    const row=event();row.history.forEach(p=>p.resale=60);row.history.at(-1).resaleMinPrice=150;
    assert.equal(evaluate(row,[],now,cfg).routes.length,0);
    row.history.forEach(p=>{if(p.timestamp>=now-D)p.resaleMinPrice=120;});
    assert.equal(evaluate(row,[],now,cfg).status,'supported');
});
function peers() {
    return [1,2,3].map(i=>{const row=event('peer'+i,now+3*D-i*7*D);
        row.history=row.history.map(p=>({...p,timestamp:p.timestamp-i*7*D,resale:p.resale*4}));return row;});
}
test('peer comparison uses matching demand and equivalent lead time without requiring low primary',()=>{
    const row=event();row.history.forEach(p=>p.primary=2000);
    const r=evaluate(row,peers(),now,cfg);assert.deepEqual(r.routes,['comparable_events']);
    assert.equal(r.peers[0].to,now-7*D);assert.equal(r.sites.tm.comparison.peers,3);
});
test('insufficient peers, future peers, duplicate peers and dissimilar peers do not qualify',()=>{
    const row=event();row.history.forEach(p=>p.primary=2000);
    const p=peers();
    for(const list of [p.slice(0,2),[p[0],p[0],p[0]],p.map(r=>({...r,UTCEventDate:new Date(now+5*D)})),
        p.map(r=>({...r,demandMetadata:{...r.demandMetadata,market:'other'}}))]) assert.equal(evaluate(row,list,now,cfg).routes.length,0);
    for(const field of ['identity','market','dayClass','venueID']) {
        const b=event('b');b.demandMetadata[field]='different';assert.equal(comparable(row,b),false);
    }
});
test('peers without strong demand cannot establish a low resale opportunity',()=>{
    const row=event();row.history.forEach(p=>p.primary=2000);
    const p=peers();p.forEach(r=>r.history.forEach(s=>s.resale=500));
    assert.equal(evaluate(row,p,now,cfg).routes.length,0);
});
test('past events never qualify',()=>assert.equal(evaluate(event('old',now-D),[],now,cfg).routes.length,0));
test('cancelled or postponed events and references never qualify',()=>{
    const row=event();row.demandMetadata.eligible=false;assert.equal(evaluate(row,peers(),now,cfg).routes.length,0);
    row.demandMetadata.eligible=true;row.history.forEach(p=>p.primary=2000);
    const p=peers();p[0].demandMetadata.eligible=false;assert.equal(evaluate(row,p,now,cfg).routes.length,0);
});
