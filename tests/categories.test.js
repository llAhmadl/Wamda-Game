const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { PGlite } = require('@electric-sql/pglite');
const { createQuestionStore } = require('../lib/question-store');
const question = i => ({ question:`سؤال محفوظ ${i}`, choices:['أ','ب','ج','د'],correct:i%4 });

test('category migration preserves old questions, CRUD, filtering, binary image persistence and safe deletion', {timeout:30000}, async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'wamda-categories-'));
 let db=new PGlite(path.join(dir,'pg'));
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
 await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;');
 await db.exec(await readFile(path.join(__dirname,'../migrations/001_wamda_banks.sql'),'utf8'));
 const old={revision:7,activeBankId:'kept',banks:[{id:'kept',name:'بنك موجود',questions:Array.from({length:15},(_,i)=>({...question(i),id:`old-${i}`}))}]};
 await db.query('INSERT INTO public.wamda_banks(id,data) VALUES(1,$1)',[JSON.stringify(old)]);
 const create=()=>createQuestionStore({required:20,env:{DATABASE_URL:'local-test'},logger:{info(){},error(){}},connect:async()=>({query:(sql,values)=>db.query(sql,values),end:async()=>{}})});
 const store=create();await store.init();
 let state=store.snapshot();
 assert.equal(state.writable,true);assert.equal(state.imagesWritable,false);
 assert.equal(state.revision,8);assert.equal(state.schemaVersion,2);
 assert.deepEqual(state.banks[0].questions.map(({categoryId,...q})=>q),old.banks[0].questions);
 assert.ok(state.banks[0].questions.every(q=>q.categoryId==='legacy'));
 assert.throws(()=>store.gameQuestions(['legacy']),/كافية/);
 await assert.rejects(store.uploadCategoryImage({data:Buffer.from('fake'),type:'image/png'}),/002/);
 const sql=await readFile(path.join(__dirname,'../migrations/002_wamda_category_images.sql'),'utf8');
 await db.exec(sql);await db.exec(sql);
 const ready=create();await ready.init();state=ready.snapshot();
 assert.equal(state.revision,8,'migration is idempotent');assert.equal(state.imagesWritable,true);
 const image=await sharp({create:{width:80,height:60,channels:3,background:'#73acff'}}).png().toBuffer();
 for(const payload of [{data:Buffer.from('not a PNG'),type:'image/png'},{data:image,type:'image/jpeg'},{data:Buffer.alloc(2*1024*1024+1),type:'image/png'},{data:Buffer.from('<svg/>'),type:'image/svg+xml'}]) await assert.rejects(ready.uploadCategoryImage(payload));
 const uploaded=await ready.uploadCategoryImage({data:image,type:'image/png'});
 const imageId=uploaded.image.split('/').pop().replace('.webp','');
 const binary=await ready.readCategoryImage(imageId);
 assert.equal((await sharp(binary).metadata()).format,'webp');
 const mutate=async payload=>state=await ready.mutate({...payload,revision:state.revision});
 await mutate({action:'createCategory',name:'رياضة',image:uploaded.image});
 const category=state.categories.at(-1);
 await mutate({action:'updateCategory',categoryId:category.id,name:'رياضة جديدة',image:uploaded.image});
 await assert.rejects(mutate({action:'saveQuestion',bankId:'kept',question:question(50)}),/تصنيف/);
 await assert.rejects(mutate({action:'saveQuestion',bankId:'kept',question:{...question(50),categoryId:'missing'}}),/تصنيف/);
 await mutate({action:'importQuestions',bankId:'kept',categoryId:category.id,questions:Array.from({length:20},(_,i)=>question(i+100))});
 assert.ok(ready.publicCategories().find(c=>c.id===category.id));
 const game=ready.gameQuestions([category.id]);
 assert.equal(game.length,20);assert.ok(game.every(q=>q.categoryId===category.id));
 assert.equal(new Set(game.map(q=>q.id)).size,20);
 await assert.rejects(mutate({action:'deleteCategory',categoryId:category.id}),/20/);
 const moved=state.banks[0].questions[0];
 await mutate({action:'saveQuestion',bankId:'kept',questionId:moved.id,question:{...moved,categoryId:'legacy'}});
 assert.throws(()=>ready.gameQuestions([category.id]),/كافية/);
 await mutate({action:'saveQuestion',bankId:'kept',question:{...question(999),categoryId:category.id}});
 await mutate({action:'saveQuestion',bankId:'kept',question:{...question(999),categoryId:category.id}});
 assert.equal(ready.availableQuestionCount([category.id]),20,'duplicate prompts not counted twice');
 assert.equal(new Set(ready.gameQuestions([category.id]).map(q=>q.question)).size,20);
 await mutate({action:'deleteCategory',categoryId:'plants'});
 await db.close();db=new PGlite(path.join(dir,'pg'));
 const restarted=create();await restarted.init();
 assert.equal(restarted.snapshot().categories.find(c=>c.id===category.id).name,'رياضة جديدة');
 assert.equal(restarted.snapshot().categories.some(c=>c.id==='plants'),false,'deleted defaults never reseed');
 assert.deepEqual(await restarted.readCategoryImage(imageId),binary);
 assert.equal(restarted.snapshot().banks[0].questions.filter(q=>q.id.startsWith('old-')).length,15);
 assert.ok(!JSON.stringify(restarted.snapshot()).includes(image.toString('base64')));
 for(const role of ['anon','authenticated']){
  await db.exec(`SET ROLE ${role}`);
  await assert.rejects(db.query('SELECT data FROM public.wamda_category_images'),e=>e.code==='42501');
  await db.exec('RESET ROLE');
 }
});

test('concurrent legacy migration reloads winner and remains writable; local images survive restart',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'wamda-migration-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const old={revision:3,activeBankId:'old',banks:[{id:'old',name:'قديم',questions:[{id:'q',...question(1)}]}]};
 let persisted=structuredClone(old),reads=0,release;
 const barrier=new Promise(r=>release=r);
 const db={async query(sql,args){
  if(sql.startsWith('SELECT data')){
   if(reads++<2){const result={rows:[{data:structuredClone(old)}]};if(reads===2)release();await barrier;return result;}
   return {rows:[{data:structuredClone(persisted)}]};
  }
  if(sql.startsWith('UPDATE')){
   if(String(persisted.revision)!==args[1])return {rows:[]};
   persisted=JSON.parse(args[0]);return {rows:[{id:1}]};
  }
  return {rows:[]};
 },async end(){}};
 const create=()=>createQuestionStore({required:20,env:{DATABASE_URL:'test'},connect:async()=>db,logger:{info(){},error(){}}});
 const a=create(),b=create();await Promise.all([a.init(),b.init()]);
 assert.equal(a.snapshot().writable,true);assert.equal(b.snapshot().writable,true);
 assert.equal(persisted.revision,4);assert.equal(persisted.schemaVersion,2);
 assert.deepEqual(a.snapshot().banks,b.snapshot().banks);
 const opts={required:20,env:{BANKS_FILE:path.join(dir,'banks.json')}};
 const local=createQuestionStore(opts);await local.init();
 const png=await sharp({create:{width:10,height:10,channels:3,background:'#ff6d42'}}).png().toBuffer();
 const {image}=await local.uploadCategoryImage({data:png,type:'image/png'});
 const saved=await local.mutate({revision:0,action:'createCategory',name:'صور دائمة',image});
 const restarted=createQuestionStore(opts);await restarted.init();
 assert.equal(restarted.snapshot().categories.at(-1).image,image);
 const id=image.split('/').pop().replace('.webp','');
 assert.deepEqual(await restarted.readCategoryImage(id),await local.readCategoryImage(id));
});
