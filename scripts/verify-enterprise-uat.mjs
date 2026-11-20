import { randomUUID } from 'node:crypto';

const present=value=>typeof value==='string'&&!!value.trim()&&!/[\r\n]/.test(value);
const enabled=(environment,key)=>environment[key]==='true';
export const enterpriseReadinessChecks=Object.freeze([
  'enterprise-configuration','loopback-readiness','dingtalk-auth-only',
  'anonymous-rejected','development-header-rejected','public-https-web','public-auth-consistency',
]);

// Readiness is deliberately read-only: it never sends messages, creates approvals or signs in a person.
export function validateEnterpriseUatConfig(config) {
  const api=config?.services?.api?.environment??{},worker=config?.services?.worker?.environment??{};
  const migrate=config?.services?.migrate?.environment??{};
  if(api.NODE_ENV!=='production'||worker.NODE_ENV!=='production'||migrate.NODE_ENV!=='production'||
    api.ENABLE_DEV_AUTH!=='false'||api.COOKIE_SECURE!=='true'||migrate.ITSM_SEED_DEV_DATA!=='false'||
    api.NOTIFICATION_MODE!=='dingtalk'||worker.NOTIFICATION_MODE!=='dingtalk')throw new Error('ENTERPRISE_AUTH_ONLY_CONFIG_REQUIRED');
  for(const key of ['DINGTALK_CORP_ID','DINGTALK_APP_KEY','DINGTALK_APP_SECRET'])
    if(!present(api[key])||api[key]!==worker[key])throw new Error('ENTERPRISE_APPLICATION_CONFIG_REQUIRED');
  let publicUrl;
  try {publicUrl=new URL(worker.ITSM_PUBLIC_URL);}
  catch {throw new Error('ENTERPRISE_HTTPS_ENTRY_REQUIRED');}
  if(publicUrl.protocol!=='https:'||publicUrl.username||publicUrl.password||publicUrl.search||publicUrl.hash||
    publicUrl.pathname!=='/'||['localhost','127.0.0.1','[::1]'].includes(publicUrl.hostname))throw new Error('ENTERPRISE_HTTPS_ENTRY_REQUIRED');
  for(const key of ['ENABLE_DIRECTORY_SYNC','DIRECTORY_RETIRE_MISSING','ENABLE_LIVE_OA_APPROVAL','ENABLE_MANUAL_REQUEST_DELIVERY'])
    if(!['true','false'].includes(api[key])||api[key]!==worker[key])throw new Error('ENTERPRISE_MODULE_CONFIG_MISMATCH');
  if(!['true','false'].includes(worker.ENABLE_LIVE_NOTIFICATIONS))throw new Error('ENTERPRISE_MODULE_CONFIG_MISMATCH');
  if(enabled(worker,'ENABLE_LIVE_NOTIFICATIONS')&&!/^\d+$/.test(worker.DINGTALK_AGENT_ID??''))throw new Error('ENTERPRISE_NOTIFICATION_CONFIG_REQUIRED');
  if(enabled(worker,'ENABLE_DIRECTORY_SYNC')&&(!/^[1-9]\d*(,[1-9]\d*)*$/.test(worker.DINGTALK_DIRECTORY_ROOTS??'')||
    api.DINGTALK_DIRECTORY_ROOTS!==worker.DINGTALK_DIRECTORY_ROOTS))throw new Error('ENTERPRISE_DIRECTORY_CONFIG_REQUIRED');
  if(!['true','false'].includes(api.ENABLE_REQUEST_INTAKE)||
    (enabled(api,'ENABLE_REQUEST_INTAKE')&&(!enabled(api,'ENABLE_LIVE_OA_APPROVAL')||!present(api.REQUEST_INTAKE_CATALOG_VERSIONS))))
    throw new Error('ENTERPRISE_REQUEST_CONFIG_REQUIRED');
  for(const [flag,prefix,suffix] of [['ENABLE_VOICE_ASR','VOICE_ASR','/audio/transcriptions'],['ENABLE_INTAKE_AI','INTAKE_AI','/chat/completions']]){
    if(!['true','false'].includes(api[flag]))throw new Error('ENTERPRISE_MODEL_CONFIG_REQUIRED');
    if(!enabled(api,flag))continue;
    let endpoint;
    try{endpoint=new URL(api[`${prefix}_ENDPOINT`]);}catch{throw new Error('ENTERPRISE_MODEL_CONFIG_REQUIRED');}
    if(api[`${prefix}_DATA_BOUNDARY`]!=='internal-approved'||!present(api[`${prefix}_APPROVAL_REF`])||
      !present(api[`${prefix}_TOKEN`])||!present(api[`${prefix}_MODEL`])||endpoint.protocol!=='https:'||
      endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!endpoint.pathname.endsWith(suffix))throw new Error('ENTERPRISE_MODEL_CONFIG_REQUIRED');
  }
  return {publicUrl:publicUrl.origin,corpId:api.DINGTALK_CORP_ID,modules:{
    directory:enabled(worker,'ENABLE_DIRECTORY_SYNC'),notifications:enabled(worker,'ENABLE_LIVE_NOTIFICATIONS'),
    oa:enabled(worker,'ENABLE_LIVE_OA_APPROVAL'),requests:enabled(api,'ENABLE_REQUEST_INTAKE'),
    voice:enabled(api,'ENABLE_VOICE_ASR'),interpreter:enabled(api,'ENABLE_INTAKE_AI'),
  }};
}

async function body(response) {
  if(!response.body)throw new Error('ENTERPRISE_READINESS_RESPONSE_INVALID');
  const reader=response.body.getReader();const chunks=[];let bytes=0;
  try {for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.length;
    if(bytes>65536){await reader.cancel();throw new Error('ENTERPRISE_READINESS_RESPONSE_INVALID');}chunks.push(value);}}
  catch{throw new Error('ENTERPRISE_READINESS_RESPONSE_INVALID');}
  finally{reader.releaseLock();}
  return Buffer.concat(chunks).toString('utf8');
}

export async function verifyEnterpriseUat({config,port,configurationSha256,fetchImpl=fetch,now=Date.now}={}) {
  const expected=validateEnterpriseUatConfig(config);
  if(!Number.isInteger(port)||port<1||port>65535||!/^[a-f0-9]{64}$/.test(configurationSha256??''))throw new Error('ENTERPRISE_READINESS_SELECTION_REQUIRED');
  const base=`http://127.0.0.1:${port}`;
  const get=async(url,headers={})=>{
    try{return await fetchImpl(url,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(10000)});}
    catch{throw new Error('ENTERPRISE_READINESS_UNREACHABLE');}
  };
  const json=async(url)=>{const response=await get(url);if(!response.ok)throw new Error('ENTERPRISE_READINESS_RESPONSE_INVALID');
    try{return JSON.parse(await body(response));}catch{throw new Error('ENTERPRISE_READINESS_RESPONSE_INVALID');}};
  const ready=await json(`${base}/api/v1/health/ready`);
  if(ready?.status!=='ok'||ready?.service!=='itsm-api')throw new Error('ENTERPRISE_READINESS_FAILED');
  const checkAuth=auth=>{
    if(auth?.mode!=='dingtalk'||auth?.configured!==true||auth?.corpId!==expected.corpId)throw new Error('ENTERPRISE_AUTH_RUNTIME_MISMATCH');
  };
  checkAuth(await json(`${base}/api/v1/auth/config`));
  for(const headers of [{},{'x-dev-user':'uat-boundary-probe'}]){
    const response=await get(`${base}/api/v1/auth/me`,headers);await response.body?.cancel();
    if(response.status!==401)throw new Error('ENTERPRISE_ANONYMOUS_BOUNDARY_FAILED');
  }
  const web=await get(`${expected.publicUrl}/`);
  if(!web.ok||!(await body(web)).includes('id="app"'))throw new Error('ENTERPRISE_HTTPS_WEB_FAILED');
  checkAuth(await json(`${expected.publicUrl}/api/v1/auth/config`));
  for(const headers of [{},{'x-dev-user':'uat-boundary-probe'}]){
    const response=await get(`${expected.publicUrl}/api/v1/auth/me`,headers);await response.body?.cancel();
    if(response.status!==401)throw new Error('ENTERPRISE_ANONYMOUS_BOUNDARY_FAILED');
  }
  return {version:1,kind:'enterprise-uat-readiness',status:'passed',runId:randomUUID(),configurationSha256,
    checks:[...enterpriseReadinessChecks],modules:expected.modules,completedAt:new Date(now()).toISOString(),
    userAcceptance:'pending',limitations:['No real-person sign-in, message delivery, OA outcome, model call or user acceptance was verified.']};
}
