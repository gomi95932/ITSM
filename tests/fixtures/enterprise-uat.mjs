import { enterpriseReadinessChecks } from '../../scripts/verify-enterprise-uat.mjs';

export function enterpriseConfig() {
  const shared={NODE_ENV:'production',NOTIFICATION_MODE:'dingtalk',DINGTALK_CORP_ID:'fixture-corp',
    DINGTALK_APP_KEY:'fixture-app',DINGTALK_APP_SECRET:'fixture-app-secret',ENABLE_DIRECTORY_SYNC:'true',
    DIRECTORY_RETIRE_MISSING:'false',DINGTALK_DIRECTORY_ROOTS:'11,12',ENABLE_LIVE_OA_APPROVAL:'true',
    ENABLE_MANUAL_REQUEST_DELIVERY:'true'};
  return {services:{api:{environment:{...shared,ENABLE_DEV_AUTH:'false',COOKIE_SECURE:'true',
    ENABLE_REQUEST_INTAKE:'true',REQUEST_INTAKE_CATALOG_VERSIONS:'fixture-catalog-v1',
    ENABLE_VOICE_ASR:'false',ENABLE_INTAKE_AI:'false'}},worker:{environment:{...shared,
    ENABLE_LIVE_NOTIFICATIONS:'true',DINGTALK_AGENT_ID:'123',ITSM_PUBLIC_URL:'https://itsm.example.test'}},
    migrate:{environment:{NODE_ENV:'production',ITSM_SEED_DEV_DATA:'false'}}}};
}

export function enterpriseEvidence(configurationSha256='f'.repeat(64),completedAt='2026-11-15T03:00:00.000Z') {
  return {version:1,kind:'enterprise-uat-readiness',status:'passed',
    runId:'f25c5229-94d7-463e-86f6-24f18cb4dad3',configurationSha256,
    checks:[...enterpriseReadinessChecks],modules:{directory:true,notifications:true,oa:true,requests:true,voice:false,interpreter:false},
    completedAt,userAcceptance:'pending',limitations:['Fixture only; no enterprise integration or acceptance was performed.']};
}
