<script setup lang="ts">
import { computed,nextTick,onBeforeUnmount,onMounted,ref,watch } from 'vue';
import { ArrowLeft,ArrowRight,Check,LoaderCircle,Mic,Square,X } from 'lucide-vue-next';
import type { CatalogItem,CreateTicketInput,DelegationView,Impact,TicketReceipt,Urgency,PriorityEvidence } from '@itsm/contracts';
import { api,errorText } from '../api';
import { createRequestKey } from '../request-key';
import ContentBoundary from './ContentBoundary.vue';

const props=defineProps<{ catalog:CatalogItem[]; initialCode?:string }>();
const emit=defineEmits<{ close:[]; created:[id:string] }>();
const serviceCode=ref(props.initialCode ?? ''),subject=ref(''),description=ref(''),fields=ref<Record<string,string>>({});
const impact=ref<Impact | ''>(''),urgency=ref<Urgency | ''>(''),error=ref(''),busy=ref(false),review=ref(false),draftId=ref<string>();
const service=computed(()=>props.catalog.find(item=>item.code===serviceCode.value));
const requestedValidityDays=ref<number | ''>('');
const isRequest=computed(()=>service.value?.type==='REQ');
const requestKey=ref(createRequestKey());
const contentSafe=ref(false),voiceSafe=ref(false);
const draftNotice=ref('');
const priorityEvidence=ref<PriorityEvidence>(),evidenceText=ref('');
function adoptPriorityEvidence(){
  if(!priorityEvidence.value||description.value!==evidenceText.value)return;
  if(priorityEvidence.value.impact)impact.value=priorityEvidence.value.impact;
  if(priorityEvidence.value.urgency)urgency.value=priorityEvidence.value.urgency;
}
const delegationId=ref(''),delegations=ref<DelegationView[]>([]);
onMounted(async()=>{try{const list=await api<{items:DelegationView[]}>('/delegations');delegations.value=list.items.filter(item=>item.active&&item.delegateId!==item.requesterId);const me=await api<{id:string}>('/auth/me');delegations.value=delegations.value.filter(item=>item.delegateId===me.id);}catch(e){error.value=errorText(e);}});
watch([serviceCode,subject,description,impact,urgency,fields,delegationId,requestedValidityDays],()=>{ requestKey.value=createRequestKey(); review.value=false; contentSafe.value=false; },{ deep:true });
watch(serviceCode,()=>{ fields.value={};requestedValidityDays.value=''; });
const voiceOpen=ref(false),transcript=ref(''),recording=ref(false),voiceBusy=ref(false),consent=ref(false),recordingSafe=ref(false),canRecord=ref(false),voiceError=ref(''),recordedSeconds=ref(0);
const requestingMic=ref(false),voiceTranscribing=ref(false);
watch(transcript,()=>{voiceSafe.value=false;});
let recorder:MediaRecorder | undefined,stream:MediaStream | undefined,timeout:ReturnType<typeof setTimeout> | undefined;
let clock:ReturnType<typeof setInterval>|undefined,voiceRequest:AbortController|undefined,recordingGeneration=0;
let disposed=false;
function cleanup() { if(timeout) clearTimeout(timeout);if(clock)clearInterval(clock);timeout=undefined;clock=undefined;stream?.getTracks().forEach(track=>track.stop());recording.value=false; }
function cancelRecording() {recordingGeneration++;voiceRequest?.abort();if(recorder?.state==='recording')recorder.stop();cleanup();voiceBusy.value=false;requestingMic.value=false;voiceTranscribing.value=false;}
onBeforeUnmount(()=>{ disposed=true;cancelRecording(); });
async function openVoice() {
  voiceOpen.value=true;voiceError.value='';
  try { const config=await api<{ recordingEnabled:boolean }>('/voice/config');
    const mobileDingTalk=/DingTalk/i.test(navigator.userAgent)&&(/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)||(/Macintosh/i.test(navigator.userAgent)&&navigator.maxTouchPoints>1));
    canRecord.value=config.recordingEnabled && mobileDingTalk && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder!=='undefined'; }
  catch(e) {voiceError.value=errorText(e);}
}
async function record() {
  if(recording.value) {recorder?.stop();return;}
  if(!consent.value||!recordingSafe.value||voiceBusy.value||requestingMic.value)return;
  const generation=++recordingGeneration;
  voiceError.value='';
  requestingMic.value=true;
  try {
    const acquired=await navigator.mediaDevices.getUserMedia({audio:true});
    if(disposed||generation!==recordingGeneration) {acquired.getTracks().forEach(track=>track.stop());return;}
    stream=acquired;
    requestingMic.value=false;
    const mime=['audio/webm','audio/mp4','audio/ogg'].find(value=>MediaRecorder.isTypeSupported(value));
    if(!mime) {cleanup();voiceError.value='当前客户端不支持录音格式，请使用文字。';return;}
    recorder=new MediaRecorder(stream,{mimeType:mime,audioBitsPerSecond:48000});
    const chunks:BlobPart[]=[];let bytes=0,tooLarge=false;
    recorder.ondataavailable=event=>{if(generation!==recordingGeneration)return;bytes+=event.data.size;
      if(bytes>2000000){tooLarge=true;if(recorder?.state==='recording')recorder.stop();}else chunks.push(event.data);};
    recorder.onerror=()=>{if(generation!==recordingGeneration)return;cancelRecording();voiceError.value='录音中断，请使用文字。';};
    recorder.onstop=async()=>{
      if(disposed||generation!==recordingGeneration)return;cleanup();
      if(tooLarge){voiceError.value='录音过大，请缩短录音或使用文字。';return;}
      voiceBusy.value=true;voiceTranscribing.value=true;voiceRequest=new AbortController();
      try {
        const blob=new Blob(chunks,{type:mime});if(blob.size>2000000)throw new Error('Audio size');
        const audio=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob);});
        if(disposed||generation!==recordingGeneration)return;
        const result=await api<{text:string}>('/voice/transcribe',{method:'POST',body:{audio,mimeType:mime,consent:true,contentClass:'GENERAL'},signal:voiceRequest.signal});
        if(disposed||generation!==recordingGeneration)return;
        transcript.value=result.text;
      }catch(e){if(!disposed&&generation===recordingGeneration)voiceError.value=errorText(e);}finally{if(generation===recordingGeneration){voiceBusy.value=false;voiceTranscribing.value=false;}}
    };
    recorder.start(500);recording.value=true;recordedSeconds.value=0;
    const started=Date.now();clock=setInterval(()=>{recordedSeconds.value=Math.min(30,Math.floor((Date.now()-started)/1000));},250);
    timeout=setTimeout(()=>recorder?.state==='recording' && recorder.stop(),29500);
  }catch{if(!disposed&&generation===recordingGeneration){requestingMic.value=false;cleanup();voiceError.value='未获得麦克风权限，请继续使用文字。';}}
}
async function interpret() {
  if(!voiceSafe.value){voiceError.value='请先确认内容安全声明。';return;}
  voiceBusy.value=true;voiceError.value='';
  try {
    const result=await api<{id:string;candidate:{serviceCode:string|null;subject:string;description:string;fields:Record<string,string>;fallbackReason?:string;priorityEvidence?:PriorityEvidence}}>('/voice/interpret',{method:'POST',body:{text:transcript.value,contentClass:'GENERAL'}});
    const candidate=result.candidate;
    if(candidate.serviceCode && props.catalog.some(item=>item.code===candidate.serviceCode && item.available))serviceCode.value=candidate.serviceCode;
    else serviceCode.value='';
    await nextTick();
    subject.value=candidate.subject;description.value=candidate.description;fields.value=candidate.fields;draftId.value=result.id;
    priorityEvidence.value=candidate.priorityEvidence;evidenceText.value=candidate.description;
    draftNotice.value=candidate.fallbackReason==='INTAKE_LOW_CONFIDENCE'?'暂时无法确定服务，请选择服务并核对信息。':candidate.fallbackReason?'已保留问题描述，请核对服务和必填信息。':'';
    voiceOpen.value=false;
  }catch(e){voiceError.value=errorText(e);}finally{voiceBusy.value=false;}
}
function check() {
  error.value='';
  if(!contentSafe.value){error.value='请先确认内容安全声明。';return;}
  if(!service.value?.available || !subject.value.trim() || !description.value.trim() || !impact.value || !urgency.value || service.value.fields.some(field=>field.required&&!fields.value[field.key]?.trim())) {
    error.value='请补全必填信息。';return;
  }
  if(isRequest.value&&(!Number.isInteger(requestedValidityDays.value)||Number(requestedValidityDays.value)<1
    ||Number(requestedValidityDays.value)>(service.value.maxValidityDays??0))){error.value='请填写服务允许范围内的申请有效天数。';return;}
  review.value=true;
}
async function submit() {
  if(!review.value || !contentSafe.value || busy.value || !service.value || !impact.value || !urgency.value)return;
  busy.value=true;error.value='';
  const allowed=Object.fromEntries(Object.entries(fields.value).filter(([key])=>service.value!.fields.some(field=>field.key===key)));
  const body:CreateTicketInput={contentClass:'GENERAL',serviceCode:serviceCode.value,formVersion:service.value.formVersion,subject:subject.value,description:description.value,impact:impact.value,urgency:urgency.value,fields:allowed,...(isRequest.value?{requestedValidityDays:Number(requestedValidityDays.value)}:{}),...(draftId.value?{draftId:draftId.value}:{}),...(delegationId.value?{delegationId:delegationId.value}:{})};
  try{const result=await api<TicketReceipt>('/tickets',{method:'POST',body,key:requestKey.value});emit('created',result.id);}
  catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
</script>

<template>
  <section class="request-page">
    <button class="text-button" @click="emit('close')"><ArrowLeft :size="17"/> 返回</button>
    <div class="page-title"><div><p class="eyebrow">IT 服务台</p><h1>{{isRequest?'提交服务申请':'提交报障'}}</h1></div><button class="icon-button" title="语音输入" aria-label="语音输入" @click="openVoice"><Mic :size="20"/></button></div>
    <p v-if="review&&delegationId" class="muted">申请人：{{delegations.find(item=>item.id===delegationId)?.requesterName}}（授权代报）</p>
    <p v-if="draftNotice&&!review" role="status" class="muted">{{draftNotice}}</p>
    <form v-if="!review" class="request-form" @submit.prevent="check">
      <label v-if="delegations.length">申请人<select v-model="delegationId" aria-label="申请人"><option value="">本人</option><option v-for="item in delegations" :key="item.id" :value="item.id">{{item.requesterName}}（已授权代报）</option></select></label>
      <label>服务类型 <span class="required">*</span><select v-model="serviceCode" required aria-label="服务类型"><option value="" disabled>请选择</option><option v-for="item in catalog.filter(item=>item.available)" :key="item.code" :value="item.code">{{ item.name }}</option></select></label>
      <label>{{isRequest?'申请标题':'问题标题'}} <span class="required">*</span><input v-model="subject" required maxlength="200" :placeholder="isRequest?'例如：申请 WMS 出库查询权限':'例如：WMS 登录后无法打开出库页面'"/></label>
      <label>{{isRequest?'申请说明':'详细情况'}} <span class="required">*</span><textarea v-model="description" required maxlength="10000" rows="5" :placeholder="isRequest?'说明申请用途及所需范围':'遇到了什么问题？从什么时候开始？'"/></label>
      <div class="form-grid"><label>影响范围 <span class="required">*</span><select v-model="impact" required aria-label="影响范围"><option value="" disabled>请选择</option><option value="INDIVIDUAL">仅我一人</option><option value="DEPARTMENT">部门 / 多人</option><option value="COMPANY">全公司 / 核心生产</option></select></label><label>紧急程度 <span class="required">*</span><select v-model="urgency" required aria-label="紧急程度"><option value="" disabled>请选择</option><option value="LOW">可正常工作，部分受影响</option><option value="MEDIUM">工作明显受影响</option><option value="HIGH">工作中断，暂无替代方式</option></select></label></div>
      <div v-if="priorityEvidence&&description===evidenceText" class="detail-section"><strong>分级待核对</strong><p v-if="priorityEvidence.impactQuote">{{priorityEvidence.impact==='COMPANY'?'全公司 / 核心生产':priorityEvidence.impact==='DEPARTMENT'?'部门 / 多人':'单人'}} · 依据：{{priorityEvidence.impactQuote}}</p><p v-if="priorityEvidence.urgencyQuote">{{priorityEvidence.urgency==='HIGH'?'工作中断':priorityEvidence.urgency==='MEDIUM'?'明显影响':'可计划'}} · 依据：{{priorityEvidence.urgencyQuote}}</p><p v-if="!priorityEvidence.impact||!priorityEvidence.urgency" class="muted">影响范围或中断情况仍需补充。</p><button type="button" class="secondary" :disabled="!priorityEvidence.impact&&!priorityEvidence.urgency" @click="adoptPriorityEvidence"><Check :size="16"/>确认采用建议</button></div>
      <label v-for="field in service?.fields ?? []" :key="field.key">{{field.label}} <span v-if="field.required" class="required">*</span><select v-if="field.options" v-model="fields[field.key]" :required="field.required" :aria-label="field.label"><option value="">请选择</option><option v-for="option in field.options" :key="option">{{option}}</option></select><input v-else v-model="fields[field.key]" :required="field.required" :aria-label="field.label" maxlength="500"/></label>
      <label v-if="isRequest">申请有效天数 <span class="required">*</span><input v-model.number="requestedValidityDays" type="number" min="1" :max="service?.maxValidityDays??1" step="1" required aria-label="申请有效天数"/></label>
      <p v-if="error" role="alert" class="error-banner">{{error}}</p>
      <ContentBoundary v-model="contentSafe"/>
      <div class="form-footer"><button type="button" class="secondary" @click="emit('close')">取消</button><button class="primary" type="submit">核对信息 <ArrowRight :size="17"/></button></div>
    </form>
    <div v-else class="review-page">
      <h2>{{isRequest?'确认申请信息':'确认报障信息'}}</h2>
      <dl class="fact-list"><dt>服务</dt><dd>{{service?.name}}</dd><dt>标题</dt><dd>{{subject}}</dd>
        <dt>{{isRequest?'申请说明':'详细情况'}}</dt><dd class="multiline">{{description}}</dd>
        <dt>影响范围</dt><dd>{{({INDIVIDUAL:'仅我一人',DEPARTMENT:'部门 / 多人',COMPANY:'全公司 / 核心生产'})[impact || 'INDIVIDUAL']}}</dd>
        <dt>紧急程度</dt><dd>{{({LOW:'可正常工作，部分受影响',MEDIUM:'工作明显受影响',HIGH:'工作中断，暂无替代方式'})[urgency || 'LOW']}}</dd>
        <template v-for="field in service?.fields ?? []" :key="field.key"><dt>{{field.label}}</dt><dd>{{fields[field.key] || '未填写'}}</dd></template>
        <template v-if="isRequest"><dt>申请有效天数</dt><dd>{{requestedValidityDays}} 天</dd></template>
      </dl>
      <p class="muted">{{isRequest?'提交后进入审批，审批通过后安排交付。':'提交后由服务台受理。'}}</p>
      <p v-if="error" role="alert" class="error-banner">{{error}}</p>
      <div class="form-footer"><button class="secondary" :disabled="busy" @click="review=false">返回修改</button><button class="primary" :disabled="busy" @click="submit"><LoaderCircle v-if="busy" :size="17" class="spin"/><Check v-else :size="17"/> 确认提交</button></div>
    </div>
    <div v-if="voiceOpen" class="modal-backdrop" @click.self="!recording&&!voiceBusy&&!requestingMic&&(voiceOpen=false)">
      <section role="dialog" aria-modal="true" aria-labelledby="voice-title" class="modal">
        <header class="section-heading"><h2 id="voice-title">一句话描述问题</h2><button class="icon-button" aria-label="关闭语音输入" title="关闭" :disabled="recording||voiceBusy||requestingMic" @click="voiceOpen=false"><X :size="20"/></button></header>
        <p v-if="!canRecord" class="muted">录音暂未开放，可先输入问题描述。</p>
        <template v-else>
          <label class="checkbox-label"><input v-model="consent" type="checkbox" :disabled="recording||voiceBusy||requestingMic"/> 同意将本次录音发送至公司批准的内部转写服务</label>
          <ContentBoundary v-if="!recording&&!voiceBusy&&!requestingMic" v-model="recordingSafe"/>
          <button class="record-button" :class="{recording}" :disabled="(!recording&&(!consent||!recordingSafe))||voiceBusy||requestingMic" @click="record"><Square v-if="recording" :size="24"/><Mic v-else :size="24"/>{{recording?'停止录音':'开始录音'}}</button>
          <p v-if="recording" role="status">已录音 {{recordedSeconds}} 秒 / 30 秒</p>
          <p v-else-if="voiceTranscribing" role="status">正在转写…</p>
          <p v-else-if="requestingMic" role="status">正在等待麦克风授权…</p>
          <button v-if="recording||voiceTranscribing||requestingMic" class="secondary" type="button" @click="cancelRecording">取消本次录音</button>
        </template>
        <label>问题描述<textarea v-model="transcript" rows="5" maxlength="4000" :disabled="recording||voiceBusy||requestingMic"/></label>
        <ContentBoundary v-model="voiceSafe"/>
        <p v-if="voiceError" class="error-banner" role="alert">{{voiceError}}</p>
        <button class="primary full" :disabled="!voiceSafe||!transcript.trim()||recording||voiceBusy||requestingMic" @click="interpret"><LoaderCircle v-if="voiceBusy" :size="17" class="spin"/> 整理为草稿</button>
      </section>
    </div>
  </section>
</template>
