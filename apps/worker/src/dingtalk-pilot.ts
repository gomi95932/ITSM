export function dingtalkPilotUsers(env:NodeJS.ProcessEnv):string[]|undefined {
  const raw=env.DINGTALK_PILOT_USER_IDS;
  if(raw===undefined||raw==='')return undefined;
  const ids=raw.split(',').map(value=>value.trim());
  if(ids.length>30||ids.some(value=>!/^[^\s,\x00-\x1f\x7f]{1,200}$/.test(value))||new Set(ids).size!==ids.length)
    throw new Error('DINGTALK_PILOT_CONFIG_INVALID');
  return ids;
}
