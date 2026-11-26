import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installFakeBotmux} from './test-botmux-fixture.mjs';
import {canonicalContext} from './test-result-context-fixture.mjs';
const root=mkdtempSync(join(tmpdir(),'data-mcp-model-modes-'));
const pluginRoot=dirname(dirname(fileURLToPath(import.meta.url)));
let runs=0,models=0;const requests=[];
const columns=[{name:'synthetic_value',type:'String'}];
const row='PURE_SYNTHETIC_MODE_VALUE';
const service=createServer((req,res)=>{let data='';req.on('data',b=>data+=b);req.on('end',()=>{
 const body=JSON.parse(data);requests.push(body);res.writeHead(200,{'content-type':'application/json'});
 if(req.url==='/validate'){res.end(JSON.stringify({status:'success',query_plan_id:'qplan_modes',normalized_sql:body.sql}));return;}
 if(req.url==='/run'){runs++;res.end(JSON.stringify({status:'success',query_id:'q_modes',columns,rows:[{synthetic_value:row}],row_count:1,truncated:false,truncation_uncertain:false,result_context:canonicalContext(columns)}));return;}
 models++;res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'mode_analysis',type:'function',function:{name:'create_analysis',arguments:JSON.stringify({analysis_markdown:'{{fact_0}}',facts:[{row_index:0,column:'synthetic_value',label:'合成值'}]})}}]}}]}));
 });});
await new Promise(r=>service.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${service.address().port}`,fake=installFakeBotmux(root);
const host=join(root,'host.env');writeFileSync(host,[`DATA_MCP_RESULT_MODEL_ENDPOINT=${base}/model`,'DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS=127.0.0.1','DATA_MCP_RESULT_MODEL=synthetic-model','DATA_MCP_RESULT_BINDING_HMAC_KEY=synthetic_modes_binding_0123456789abcdef'].join('\n'),{mode:0o600});
const caller={requestUserOpenId:'ou_modes',requestUserUnionId:'on_modes',requestLarkAppId:'cli_synthetic',senderType:'user',turnId:'om_modes'};
const children=[];
function start(mode){
 const env=fake.env();for(const k of Object.keys(env))if(k.startsWith('DATA_MCP_')||k==='KSHER_AGENT_DATA_MCP_ENV_FILE')delete env[k];
 Object.assign(env,{BOTMUX_SESSION_ID:`mode_${mode??'default'}`,BOTMUX_PLUGIN_HOME:join(root,`home_${mode??'default'}`),KSHER_AGENT_DATA_MCP_ENV_FILE:host,DATA_MCP_SERVICE_SOCKET_PATH:'disabled',DATA_MCP_VALIDATE_SQL_ENDPOINT:`${base}/validate`,DATA_MCP_RUN_QUERY_ENDPOINT:`${base}/run`,FAKE_BOTMUX_LOG:join(root,'sends.jsonl')});
 if(mode!==undefined)env.DATA_MCP_MODEL_MODE=mode;
 const child=spawn(process.execPath,[join(pluginRoot,'dist/mcp/server.js')],{cwd:pluginRoot,env,stdio:['pipe','pipe','pipe']});children.push(child);
 let seq=0,buffer='',stderr='';const pending=new Map();child.stderr.on('data',b=>stderr+=b);
 child.stdout.on('data',b=>{buffer+=b;for(;;){const i=buffer.indexOf('\n');if(i<0)break;const v=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);pending.get(v.id)?.(v);pending.delete(v.id);}});
 const ended=new Promise(r=>child.once('close',code=>r({code,stderr})));
 return {async rpc(method,params={}){const id=++seq;const result=new Promise((r,j)=>{const timer=setTimeout(()=>j(new Error('synthetic_mode_rpc_timeout')),10000);pending.set(id,v=>{clearTimeout(timer);r(v);});});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return result;},async call(name,args={},identity=caller){return this.rpc('tools/call',{name,arguments:args,_meta:{botmuxTrustedCaller:identity}});},async close(){child.stdin.end();assert.equal((await ended).code,0);}};
}
const payload=r=>JSON.parse(r.result.content[0].text);
try{
 for(const mode of [undefined,'single']){
  const p=start(mode);const names=(await p.rpc('tools/list')).result.tools.map(t=>t.name);
  assert(names.includes('run_query_for_user'));assert(!names.includes('deliver_query_result_for_user'));assert(!names.includes('continue_query_result_for_user'));assert(!names.includes('get_query_delivery_status_for_user'));
  assert.equal(payload(await p.call('data_mcp_identity_probe')).modelMode,'single');
  const sql='SELECT synthetic_value FROM synthetic.events';assert.equal(payload(await p.call('validate_sql_for_user',{sql})).status,'success');
  const before=runs;assert(JSON.stringify(await p.call('run_query_for_user',{sql,query_plan_id:'qplan_modes'})).includes(row));assert.equal(runs,before+1);assert.equal(models,0);
  assert.equal(requests.at(-1).request_user_union_id,caller.requestUserUnionId);assert.equal(requests.at(-1).sql,sql);
  const beforeHidden=runs;for(const tool of ['deliver_query_result_for_user','continue_query_result_for_user'])assert((await p.call(tool,{sql,query_plan_id:'qplan_modes'})).error.message.includes('unknown_tool'));
  assert(JSON.stringify(await p.call('get_query_delivery_status_for_user')).includes('invalid_delivery_status_request'));
  assert.equal(runs,beforeHidden);
  const beforeUntrusted=runs;const denied=await p.call('run_query_for_user',{sql,query_plan_id:'qplan_modes'},{});assert(!JSON.stringify(denied).includes(row));assert.equal(runs,beforeUntrusted);
  await p.close();
 }
 const p=start('dual');const names=(await p.rpc('tools/list')).result.tools.map(t=>t.name);assert(names.includes('deliver_query_result_for_user'));assert(names.includes('continue_query_result_for_user'));
 assert.equal(payload(await p.call('data_mcp_identity_probe')).modelMode,'dual');
 const before=runs;const denied=await p.call('run_query_for_user',{sql:'SELECT synthetic_value FROM synthetic.events',query_plan_id:'qplan_modes'});assert(JSON.stringify(denied).includes('isolated_delivery_required'));assert.equal(runs,before);assert(!JSON.stringify(denied).includes(row));
 const delivered=await p.call('deliver_query_result_for_user',{sql:'SELECT synthetic_value FROM synthetic.events',query_plan_id:'qplan_modes',question:'Synthetic mode test',requested_outputs:['analysis']});assert.equal(payload(delivered).status,'delivered');assert(!JSON.stringify(delivered).includes(row));assert.equal(runs,before+1);assert.equal(models,1);await p.close();
 const invalid=start('invalid');const invalidReply=await invalid.call('data_mcp_identity_probe');assert(JSON.stringify(invalidReply).includes('data_mcp_model_mode_invalid'));await invalid.close();
 console.log('model mode validation passed: default/explicit single, opt-in dual, hidden tools, no implicit model invocation, trusted identity, invalid mode fail-closed');
}finally{for(const c of children)c.kill();service.closeAllConnections();await new Promise(r=>service.close(r));rmSync(root,{recursive:true,force:true});}
