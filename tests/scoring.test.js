const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {mkdtemp,rm}=require('node:fs/promises');
const path=require('node:path'),os=require('node:os');
const {io}=require('../node_modules/socket.io/client-dist/socket.io.js');
const sharp=require('sharp');
const defaults=require('../lib/default-questions.json');
function event(s,name,predicate=()=>true){return new Promise((resolve,reject)=>{const handler=d=>{if(!predicate(d))return;clearTimeout(timer);s.off(name,handler);resolve(d)};const timer=setTimeout(()=>{s.off(name,handler);reject(Error('Timeout '+name))},5000);s.on(name,handler);});}
function request(s,name,payload={}){return new Promise((resolve,reject)=>s.timeout(5000).emit(name,payload,(e,r)=>e?reject(e):resolve(r)));}
test('first 3/4 races, wrong and repeated answers, authorization, live catalog, uploads and two cumulative rounds',{timeout:20000},async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'wamda-scoring-'));
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:'0',ADMIN_CODE:'only-tests',DATABASE_URL:'',RENDER:'',BANKS_FILE:path.join(dir,'banks.json')},stdio:['ignore','pipe','pipe']});
 const clients=[];t.after(async()=>{clients.forEach(s=>s.disconnect());proc.kill();await rm(dir,{recursive:true,force:true});});
 const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('start timeout')),5000);proc.stdout.on('data',d=>{const m=String(d).match(/http:\/\/localhost:\d+/);if(m){clearTimeout(timer);resolve(m[0])}});});
 async function connect(){const s=io(url,{transports:['websocket'],autoConnect:false,reconnection:false});clients.push(s);const ready=event(s,'connect');s.connect();await ready;return s;}
 const admin=await connect();
 const unauth=await connect();
 assert.equal((await request(unauth,'adminUploadCategoryImage',{data:Buffer.from('fake'),type:'image/png'})).unauthorized,true);
 let state=await request(admin,'adminLogin',{code:'only-tests'});
 const mutate=async payload=>{const response=await request(admin,'adminMutate',{...payload,revision:state.revision});assert.equal(response.ok,true,response.message);state=response;return response;};
 for(const mode of [3,4]) {
  const players=await Promise.all(Array.from({length:5},connect));const host=players[0];
  const room=(await request(host,'createRoom',{name:'المضيف'})).code;
  for(let i=1;i<5;i++)await request(players[i],'joinRoom',{name:`لاعب ${i}`,code:room});
  const live=event(players[1],'lobbyUpdate',d=>d.scoringMode===mode);
  await request(host,'updateRoomSettings',{code:room,categoryIds:['legacy','islamic'],scoringMode:mode});
  const snapshot=await live;assert.deepEqual(snapshot.selectedCategoryIds,['legacy','islamic']);assert.equal(snapshot.scoringMode,mode);
  assert.equal(JSON.stringify(snapshot).includes('correct'),false);
  for(const bad of [null,{code:room,categoryIds:['missing'],scoringMode:3},{code:room,categoryIds:['legacy'],scoringMode:2},{code:room,categoryIds:['legacy','legacy'],scoringMode:1}])assert.equal((await request(host,'updateRoomSettings',bad)).ok,false);
  assert.equal((await request(players[1],'updateRoomSettings',{code:room,categoryIds:['legacy'],scoringMode:1})).ok,false);
  if(mode===3){
   const catalogUpdate=event(players[1],'lobbyUpdate',d=>d.categories.some(c=>c.name==='رياضة'));
   const png=await sharp({create:{width:20,height:20,channels:3,background:'#73ACFF'}}).png().toBuffer();
   const upload=await request(admin,'adminUploadCategoryImage',{data:png,type:'image/png'});assert.equal(upload.ok,true,upload.message);
   const image=await fetch(url+upload.image);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/webp');
   await mutate({action:'createCategory',name:'رياضة',image:upload.image});
   assert.ok((await catalogUpdate).categories.some(c=>c.name==='رياضة'));
   const sports=state.categories.at(-1);
   const nextUpload=await request(admin,'adminUploadCategoryImage',{data:png,type:'image/png'});
   await mutate({action:'updateCategory',categoryId:sports.id,name:'رياضة معدلة',image:nextUpload.image});
   await mutate({action:'deleteCategory',categoryId:sports.id});
   assert.equal((await request(admin,'adminUploadCategoryImage',{data:Buffer.from('<script>'),type:'image/png'})).ok,false);
  }
  let next=event(host,'question');assert.equal((await request(host,'startGame',{code:room})).ok,true);
  const totals=new Map(players.map(p=>[p.id,0]));const seen=new Set();
  for(let index=0;index<20;index++){
   const q=await next;assert.ok(!seen.has(q.question));seen.add(q.question);
   assert.equal(q.round,Math.floor(index/10)+1);assert.equal(q.number,index%10+1);
   const answer=defaults.find(x=>x.question===q.question).correct;
   if(index===0){
    for(const action of ['leaveRoom','createRoom','joinRoom'])assert.equal((await request(host,action,{code:room,name:'تغيير'})).ok,false);
    assert.equal((await request(host,'updateRoomSettings',{code:room,categoryIds:['legacy'],scoringMode:1})).ok,false);
    assert.equal((await request(unauth,'joinRoom',{name:'تحديث الصفحة',code:room})).ok,false);
   }
   const closed=event(host,'questionClosed');
   const wrong=event(host,'answerResult');host.emit('submitAnswer',{code:room,questionId:index,answerIndex:(answer+1)%4,points:999});assert.equal((await wrong).awardedPoints,0);
   host.emit('submitAnswer',{code:room,questionId:index,answerIndex:answer});
   const first=event(players[1],'answerResult');players[1].emit('submitAnswer',{code:room,questionId:index,answerIndex:answer,points:999});
   const result=await first;assert.equal(result.awardedPoints,2);assert.equal(result.rank,1);
   players[1].emit('submitAnswer',{code:room,questionId:index,answerIndex:answer});
   for(const p of players.slice(2))p.emit('submitAnswer',{code:room,questionId:index,answerIndex:answer});
   const end=await closed;assert.equal(end.winners.length,mode);assert.equal(end.winners[0].id,players[1].id);
   assert.equal(new Set(end.winners.map(p=>p.id)).size,mode);
   assert.deepEqual(end.winners.map(p=>p.awardedPoints),[2,...Array(mode-1).fill(1)]);
   end.winners.forEach(p=>totals.set(p.id,totals.get(p.id)+p.awardedPoints));
   if(index===9||index===19){
    const resultEvent=event(host,index===19?'gameOver':'roundOver');host.emit('nextQuestion',{code:room,questionId:index});
    const ranking=await resultEvent;ranking.ranking.forEach(p=>assert.equal(p.score,totals.get(p.id)));
    assert.equal(ranking.ranking.reduce((n,p)=>n+p.score,0),(index+1)*(mode+1));
    if(index===9){assert.equal((await request(host,'leaveRoom')).ok,false);next=event(host,'question');host.emit('nextRound',{code:room,round:1});}
   }else{next=event(host,'question');host.emit('nextQuestion',{code:room,questionId:index});}
  }
  assert.equal((await request(host,'leaveRoom')).ok,true);
  players.forEach(p=>p.disconnect());
 }
});
