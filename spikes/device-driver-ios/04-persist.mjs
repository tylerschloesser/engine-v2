import { newSession, sleep } from './wd.mjs'
const [u, phase] = process.argv.slice(2)
const s = await newSession()
try {
  await s.get(u + '/device.html'); await sleep(3000)
  if (phase === 'write') {
    console.log(await s.jsAsync(`const done=arguments[arguments.length-1];(async()=>{localStorage.setItem('spike','1');const d=await navigator.storage.getDirectory();const f=await d.getFileHandle('spike.txt',{create:true});const w=await f.createWritable();await w.write('hello');await w.close();document.cookie='spike=1;max-age=999;secure;samesite=none';done('written')})().catch(e=>done('ERR '+e))`))
  } else {
    console.log(await s.jsAsync(`const done=arguments[arguments.length-1];(async()=>{let o=await navigator.storage.getDirectory();let names=[];for await(const [n] of o.entries())names.push(n);done(JSON.stringify({ls:localStorage.getItem('spike'),opfs:names,cookie:document.cookie,persisted:await navigator.storage.persisted(),est:await navigator.storage.estimate()}))})().catch(e=>done('ERR '+e))`))
  }
} finally { await s.end().catch(()=>{}) }
