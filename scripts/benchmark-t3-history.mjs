// Synthetic client-side benchmark: 32 keys, 20 active threads, 30 measured updates.
// Run with Node 24: node scripts/benchmark-t3-history.mjs
// Excludes server queries, transport, JSON parsing and physical Stream Deck I/O.
import {T3Runtime} from '../src/t3/t3-runtime.ts';
import {normalizeTaskKeySettings} from '../src/settings/task-key-settings.ts';
const results=[];
for(const count of [170,1000,5000,10000]) {
 let receive,ready;const started=new Promise(r=>ready=r);
 const client={environmentId:'env',version:'test',async connect(){},close(){},subscribe(tag,payload,fn){if(tag==='orchestration.subscribeShell'){receive=fn;ready();}},async rpc(){return {providers:[]}},async http(){return {}}};
 const runtime=new T3Runtime(async()=>{}, {notify(){},async customSoundAvailable(){return false}}, {async loadCredentials(){return {origin:'http://localhost',token:'test'}},createClient(){return client}});
 for(let i=1;i<=32;i++)runtime.attachAction({id:String(i),async setImage(){},async showAlert(){}},normalizeTaskKeySettings({backend:'t3',taskPosition:i}));
 await started;
 const base={projectId:'p',status:'completed',createdAt:'2026-01-01T00:00:00Z',lastVisitedAt:'2026-02-01T00:00:00Z',latestRunCompletedAt:'2026-01-02T00:00:00Z'};
 const threads=Array.from({length:count},(_,i)=>({...base,id:`settled-${i}`,title:`Settled ${i}`,settledAt:'2026-02-01T00:00:00Z',settledOverride:'settled'}));
 for(let i=0;i<20;i++)threads.push({...base,id:`active-${i}`,title:`Active ${i}`,status:'running'});
 let start=performance.now();receive({kind:'snapshot',snapshot:{threads,projects:[]}});const snapshotMs=performance.now()-start;
 const samples=[];
 for(let i=0;i<35;i++){start=performance.now();receive({kind:'thread.updated',location:'active',thread:{...threads.at(-1),updatedAt:new Date().toISOString()}});if(i>=5)samples.push(performance.now()-start); await new Promise(r=>setImmediate(r));}
 samples.sort((a,b)=>a-b);results.push({settled:count,keys:32,snapshotMs:+snapshotMs.toFixed(2),updateMedianMs:+samples[15].toFixed(2),updateP95Ms:+samples[28].toFixed(2)});runtime.shutdown();
}
console.log(JSON.stringify(results,null,2));
