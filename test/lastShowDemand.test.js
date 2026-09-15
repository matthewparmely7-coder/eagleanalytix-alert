const test = require('node:test'), assert = require('node:assert/strict');
const { evaluateLastShow } = require('../patterns/lastShowDemand');
const H=3600000,D=24*H,now=Date.parse('2026-09-15T12:00:00Z');
function fixture() {
    const early=now-2*D,final=now+D,marker=early+3*H;
    const events=[{eventID:'a',eventDate:new Date(early)},{eventID:'b',eventDate:new Date(final)}];
    const make=(end,isFinal)=>{const history=[];for(let t=end-7*D;t<=Math.min(end,now);t+=H){const h=(t-(end-7*D))/H;
        const after=isFinal?Math.max(0,Math.min(6,(t-marker)/H)):0;
        history.push({timestamp:t,primary:2000-h*7-after*30,resale:1000-h*3-after*18,resaleMinPrice:isFinal&&t>=marker?110:100,primaryMinPrice:45,minPrice:45});}
        return {history,historyRevision:1,historyPulledAt:new Date(now)};};
    return {group:{events,eventIDs:['a','b'],lastEventID:'b',revision:1},rows:new Map([['a',make(early,false)],['b',make(final,true)]])};
}
test('earlier demand, equivalent times and post-performance strengthening',()=>{
    const {group,rows}=fixture(), result=evaluateLastShow(group,rows,now);
    assert.equal(result.status,'last_show_supported');assert.equal(result.referenceEventID,'a');
    const a=result.eventWindows.find(w=>w.eventID==='a'),b=result.eventWindows.find(w=>w.eventID==='b');
    assert.equal(+group.events[0].eventDate-a.to,+group.events[1].eventDate-b.to);
    assert.equal(result.evidence[0].post.marker,+group.events[0].eventDate+3*H);
});
test('primary prices never substitute for missing resale',()=>{
    const {group,rows}=fixture();for(const row of rows.values())for(const p of row.history)delete p.resaleMinPrice;
    assert.equal(evaluateLastShow(group,rows,now).status,'insufficient_data');
});
test('stale endpoints and long gaps cannot support a signal',()=>{
    const {group,rows}=fixture();rows.get('b').history=rows.get('b').history.filter(p=>p.timestamp<now-D);
    assert.equal(evaluateLastShow(group,rows,now).status,'insufficient_data');
    const f=fixture();f.rows.get('a').history=f.rows.get('a').history.filter(p=>p.timestamp<now-5*D||p.timestamp>now-4*D);
    assert.notEqual(evaluateLastShow(f.group,f.rows,now).status,'last_show_supported');
});
test('flat inventory and a single price snapshot cannot qualify',()=>{
    const {group,rows}=fixture();for(const row of rows.values())for(const p of row.history){p.primary=1000;p.resale=500;}
    assert.equal(evaluateLastShow(group,rows,now).status,'watching');
    const f=fixture();for(const row of f.rows.values())row.history.forEach((p,i,a)=>{p.resaleMinPrice=i===a.length-1?200:null;});
    assert.equal(evaluateLastShow(f.group,f.rows,now).status,'insufficient_data');
});
test('demand supported without post-performance price increase',()=>{
    const {group,rows}=fixture();for(const p of rows.get('b').history)p.resaleMinPrice=100;
    assert.equal(evaluateLastShow(group,rows,now).status,'demand_supported');
});
test('new later show becomes target; future earlier performance is watching',()=>{
    const {group,rows}=fixture();group.events.push({eventID:'c',eventDate:new Date(now+2*D)});group.revision++;
    const result=evaluateLastShow(group,rows,now);assert.equal(result.lastEventID,'c');assert.equal(result.seriesRevision,2);assert.equal(result.status,'insufficient_data');
    const f=fixture();f.group.events[0].eventDate=new Date(now+H);
    assert.equal(evaluateLastShow(f.group,f.rows,now).status,'watching');
});
test('Vivid can qualify without TM resale; zero resale is unavailable',()=>{
    const {group,rows}=fixture();for(const row of rows.values()){row.vsHistory=row.history.map(p=>({timestamp:p.timestamp,primary:p.resale,minPrice:p.resaleMinPrice}));for(const p of row.history){p.resale=0;p.resaleMinPrice=null;}}
    const result=evaluateLastShow(group,rows,now);assert.equal(result.status,'last_show_supported');assert.equal(result.referenceSite,'vs');
});
