import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'scope-rusage-test-')),log=join(dir,'usage.jsonl');
assert(process.argv[2], 'Pass the compiled measurement-only wrapper path.');
const wrapper=resolve(process.argv[2]);
const run=(args,options={})=>new Promise(resolve=>execFile(wrapper,[log,...args],{...options,timeout:3000},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
try{
 const out=await run([process.execPath,'-e','process.stdout.write(JSON.stringify({arg:process.argv[1],cwd:process.cwd(),marker:process.env.FIXTURE_MARKER}));process.stderr.write("stderr fixture");','space $ and quote "'],{cwd:dir,env:{PATH:'/usr/bin:/bin',FIXTURE_MARKER:'fixture'}});
 assert.equal(out.error,null); assert.deepEqual(JSON.parse(out.stdout),{arg:'space $ and quote "',cwd:await realpath(dir),marker:'fixture'});assert.equal(out.stderr,'stderr fixture');
 const failure=await run(['/bin/sh','-c','exit 7']);assert.equal(failure.error.code,7);
 const child=spawn(wrapper,[log,'/bin/sh','-c','echo $$; exec sleep 30'],{stdio:['ignore','pipe','pipe']});
 const actual=await new Promise(resolve=>child.stdout.once('data',data=>resolve(Number(String(data).trim()))));
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));child.kill('SIGTERM');
 assert.deepEqual(await closed,{code:null,signal:'SIGTERM'});assert.throws(()=>process.kill(actual,0),{code:'ESRCH'});
 const rows=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows.length,3);assert(rows.every(row=>row.childCpuMicros>=0&&row.wrapperCpuMicros>=0&&row.at>=row.startedAt));
 console.log('PASS: arguments, environment, cwd, stdout/stderr, exit status, signal forwarding, child reaping, and finite CPU records.');
}finally{await rm(dir,{recursive:true,force:true});}
