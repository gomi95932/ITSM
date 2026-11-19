type Settings = Record<string, string | undefined>;
export type RequestIntakePolicy = { corpId: string; approvalTimeoutMinutes: number };

// Publishing a new form does not carry forward acceptance of its previous OA binding.
export function requestIntakePolicy(settings: Settings, code: string, version: number): RequestIntakePolicy | null {
  if (settings.ENABLE_REQUEST_INTAKE !== 'true' || settings.ENABLE_LIVE_OA_APPROVAL !== 'true'
    || settings.ENABLE_MANUAL_REQUEST_DELIVERY !== 'true'
    || ![settings.DINGTALK_CORP_ID, settings.DINGTALK_APP_KEY, settings.DINGTALK_APP_SECRET].every(value =>
      typeof value === 'string' && value.trim().length > 0 && !/[\x00-\x1f]/.test(value))) return null;
  const timeout = settings.REQUEST_APPROVAL_TIMEOUT_MINUTES;
  if (!timeout || !/^[1-9]\d{0,5}$/.test(timeout) || Number(timeout) > 525600) return null;
  const accepted = settings.REQUEST_INTAKE_CATALOG_VERSIONS?.split(',').map(item => item.trim());
  if (!accepted?.length || accepted.length > 100 || new Set(accepted).size !== accepted.length
    || accepted.some(item => !/^REQ-[A-Z0-9-]{1,36}@[1-9]\d{0,8}$/.test(item))
    || !accepted.includes(`${code}@${version}`)) return null;
  return { corpId: settings.DINGTALK_CORP_ID!, approvalTimeoutMinutes: Number(timeout) };
}
