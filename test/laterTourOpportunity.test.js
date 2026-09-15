const test=require('node:test'),assert=require('node:assert/strict');
const {groupTours}=require('../services/tourGrouping');
const {evaluateLaterTour}=require('../patterns/laterTourOpportunity');
const H=3600000,D=24*H,now=Date.parse('2026-09-15T12:00:00Z');
const event=(id,days,location)=>({eventID:id,eventDate:new Date(now+days*D),artistID:'artist',artist:'Artist',eventName:'Artist - Example Tour',location,timezone:'UTC',eligible:true});
function fixture(){
 const events=[event('a',-10,'City A'),event('b',-8,'City B'),event('c',-6,'City C'),event('d',30,'City D'),event('e',60,'City E')];
 const histories=new Map();
 for(const e of events){const end=+e.eventDate,later=end>now,history=[];
  for(let t=later?now-25*D:end-7*D;t<=Math.min(end,now);t+=H){
   const h=(t-(later?now-25*D:end-7*D))/H,after=later?Math.max(0,(t-(now-10*D+3*H))/H):0;
   history.push({timestamp:t,primary:later?4000-h*2-after*2:2000-h*7,resale:later?2000-h-after*2:1000-h*3,
    resaleMinPrice:later&&after>0?110:100,minPrice:45,primaryMinPrice:45});
  }histories.set(e.eventID,{history,historyRevision:1});
 }return {group:{revision:1,events,eventIDs:events.map(e=>e.eventID)},histories};
}
test('tour grouping crosses cities, keeps long runs, and excludes unrelated titles and add-ons',()=>{
 const rows=[event('a',0,'A'),event('b',20,'B'),event('c',40,'C'),event('d',60,'D'),
  {...event('vip',10,'E'),eventName:'Artist - Example Tour VIP Package'},
  {...event('other',30,'B'),eventName:'Artist - Different Tour'},
  {...event('artist',10,'B'),artistID:'other'}];
 const groups=groupTours(rows,30);assert.equal(groups.length,1);assert.deepEqual(groups[0].events.map(e=>e.eventID),['a','b','c','d']);
 assert.equal(groupTours([event('a',0,'A'),event('b',40,'B')],30).length,0);
 assert.equal(groupTours([event('a',0,'A'),event('b',1,'A')],30).length,0);
});
test('multiple later dates qualify across cities, including dates more than a month away',()=>{
 const f=fixture(),result=evaluateLaterTour(f.group,f.histories,now);
 assert.equal(result.status,'later_tour_supported');assert.deepEqual(result.eventResults.map(e=>e.eventID),['d','e']);
 assert.ok(result.eventResults.every(e=>e.status==='later_tour_supported'));
 assert.equal(result.socialHype,'not_measured');
});
test('missing resale is insufficient, never replaced by primary prices',()=>{
 const f=fixture();for(const row of f.histories.values())for(const p of row.history)delete p.resaleMinPrice;
 assert.equal(evaluateLaterTour(f.group,f.histories,now).status,'insufficient_data');
});
test('one strong early show does not satisfy the minimum',()=>{
 const f=fixture();for(const id of ['b','c'])for(const p of f.histories.get(id).history){p.primary=2000;p.resale=1000;}
 assert.notEqual(evaluateLaterTour(f.group,f.histories,now).status,'later_tour_supported');
});
test('later sell-through without post-start uplift is not a supported opportunity',()=>{
 const f=fixture();for(const id of ['d','e']){const rows=f.histories.get(id).history;rows.forEach((p,i)=>{p.primary=4000*Math.pow(.998,i);p.resale=2000*Math.pow(.998,i);p.resaleMinPrice=100;});}
 assert.equal(evaluateLaterTour(f.group,f.histories,now).status,'demand_supported');
});
test('stale later data, future tour openings, and cancelled members',()=>{
 const f=fixture();for(const id of ['d','e'])f.histories.get(id).history=f.histories.get(id).history.filter(p=>p.timestamp<now-D);
 assert.equal(evaluateLaterTour(f.group,f.histories,now).status,'insufficient_data');
 const future=fixture();future.group.events.forEach(e=>e.eventDate=new Date(+e.eventDate+20*D));
 assert.equal(evaluateLaterTour(future.group,future.histories,now).status,'watching');
 const groups=groupTours([event('a',0,'A'),{...event('b',1,'B'),eligible:false}],30);assert.equal(groups.length,0);
});
