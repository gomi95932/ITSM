import { test,expect } from './fixtures';
import type { Page } from '@playwright/test';

async function recorder(page:Page){
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'userAgent',{configurable:true,value:'DingTalk Android ITSM-browser-fixture'});
    const track={stop(){}};
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>({getTracks:()=>[track]})}});
    class Recorder {
      static isTypeSupported(){return true;}
      state='inactive';ondataavailable:((event:{data:Blob})=>void)|null=null;onstop:(()=>void)|null=null;onerror:(()=>void)|null=null;
      start(){this.state='recording';}
      stop(){if(this.state!=='recording')return;this.state='inactive';queueMicrotask(()=>{
        this.ondataavailable?.({data:new Blob(['synthetic-browser-fixture'],{type:'audio/webm'})});this.onstop?.();});}
    }
    Object.defineProperty(window,'MediaRecorder',{configurable:true,value:Recorder});
  });
  await page.route('**/api/v1/voice/config',route=>route.fulfill({json:{recordingEnabled:true,maxSeconds:30,maxBytes:2000000}}));
  await page.goto('/');
  await page.getByRole('button',{name:'提交报障',exact:true}).first().click();
  await page.getByRole('button',{name:'语音输入',exact:true}).click();
}

test('approved recording requires consent, produces an editable draft and never submits automatically',async({page})=>{
  let creates=0,transcriptions=0;
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/tickets')creates++;});
  await recorder(page);
  await page.route('**/api/v1/voice/transcribe',async route=>{
    const body=route.request().postDataJSON();assertRequest(body);transcriptions++;
    await route.fulfill({json:{text:'WMS 无法登录，请协助排查'}});
  });
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('button',{name:'开始录音'})).toBeDisabled();
  await dialog.getByRole('checkbox',{name:'同意将本次录音发送至公司批准的内部转写服务'}).check();
  await expect(dialog.getByRole('button',{name:'开始录音'})).toBeDisabled();
  await dialog.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).first().check();
  await dialog.getByRole('button',{name:'开始录音'}).click();
  await expect(dialog.getByRole('status')).toContainText('已录音');
  await dialog.getByRole('button',{name:'停止录音'}).click();
  await expect(dialog.getByRole('textbox',{name:'问题描述',exact:true})).toHaveValue('WMS 无法登录，请协助排查');
  expect(transcriptions).toBe(1);expect(creates).toBe(0);
  await dialog.getByRole('textbox',{name:'问题描述',exact:true}).fill('WMS 无法登录，已确认不是密码错误');
  await expect(dialog.getByRole('button',{name:'整理为草稿'})).toBeDisabled();
  await dialog.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).last().check();
  for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const){
    await page.setViewportSize({width,height});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/voice-${name}.png`,fullPage:true});
  }
  await dialog.getByRole('button',{name:'整理为草稿'}).click();
  await expect(dialog).toHaveCount(0);await expect(page.getByRole('textbox',{name:'问题标题'})).toHaveValue('WMS 无法登录，已确认不是密码错误');
  expect(creates).toBe(0);
});
function assertRequest(body:Record<string,unknown>){expect(body.consent).toBe(true);expect(body.contentClass).toBe('GENERAL');expect(body.mimeType).toBe('audio/webm');expect(typeof body.audio).toBe('string');}

test('cancelled audio never uploads and failed transcription preserves typed text',async({page})=>{
  let calls=0;
  await recorder(page);
  await page.route('**/api/v1/voice/transcribe',route=>{calls++;return route.fulfill({status:503,json:{code:'ASR_UNAVAILABLE'}});});
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('textbox',{name:'问题描述',exact:true}).fill('已经输入的描述需要保留');
  await dialog.getByRole('checkbox',{name:'同意将本次录音发送至公司批准的内部转写服务'}).check();
  await dialog.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).first().check();
  await dialog.getByRole('button',{name:'开始录音'}).click();await dialog.getByRole('button',{name:'取消本次录音'}).click();
  await expect(dialog.getByRole('button',{name:'开始录音'})).toBeEnabled();expect(calls).toBe(0);
  await dialog.getByRole('button',{name:'开始录音'}).click();await dialog.getByRole('button',{name:'停止录音'}).click();
  await expect(dialog.getByRole('alert')).toContainText('暂时无法转写');
  await expect(dialog.getByRole('textbox',{name:'问题描述',exact:true})).toHaveValue('已经输入的描述需要保留');expect(calls).toBe(1);
});

test('microphone denial preserves text and delayed permission after cancel stops capture',async({page})=>{
  await recorder(page);
  await page.evaluate(()=>{
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{throw new Error('permission denied');}}});
  });
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('textbox',{name:'问题描述',exact:true}).fill('保留这段输入');
  await dialog.getByRole('checkbox',{name:'同意将本次录音发送至公司批准的内部转写服务'}).check();
  await dialog.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).first().check();
  await dialog.getByRole('button',{name:'开始录音'}).click();
  await expect(dialog.getByRole('alert')).toContainText('未获得麦克风权限');
  await expect(dialog.getByRole('textbox',{name:'问题描述',exact:true})).toHaveValue('保留这段输入');
  await page.evaluate(()=>{
    const state=window as unknown as {resolveMic?:()=>void;stopped?:boolean};state.stopped=false;
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>new Promise(resolve=>{
      state.resolveMic=()=>resolve({getTracks:()=>[{stop(){state.stopped=true;}}]});
    })}});
  });
  let uploads=0;page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/voice/transcribe'))uploads++;});
  await dialog.getByRole('button',{name:'开始录音'}).click();
  await expect(dialog.getByRole('status')).toContainText('正在等待麦克风授权');
  await dialog.getByRole('button',{name:'取消本次录音'}).click();
  await page.evaluate(()=>(window as unknown as {resolveMic:()=>void}).resolveMic());
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {stopped:boolean}).stopped)).toBe(true);
  await expect(dialog.getByRole('button',{name:'开始录音'})).toBeEnabled();expect(uploads).toBe(0);
});

test('semantic draft suggestions stay editable and low confidence requires manual service selection',async({page})=>{
  let creates=0;
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/tickets')creates++;});
  await recorder(page);
  const dialog=page.getByRole('dialog');
  await page.route('**/api/v1/voice/interpret',route=>route.fulfill({json:{id:'synthetic-browser-draft',candidate:{
    serviceCode:'INC-BIZ',subject:'WMS 登录后无响应',description:'三楼 WMS 登录后一直转圈',fields:{system:'WMS'},
    requiresReview:true,interpreter:'internal-model',confidence:0.9,missingFields:['impact','urgency'],
  }}}));
  await dialog.getByRole('textbox',{name:'问题描述',exact:true}).fill('三楼 WMS 登录后一直转圈');
  await dialog.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).last().check();
  await dialog.getByRole('button',{name:'整理为草稿'}).click();
  await expect(page.getByRole('textbox',{name:'问题标题'})).toHaveValue('WMS 登录后无响应');
  await expect(page.getByRole('combobox',{name:'服务类型'})).toHaveValue('INC-BIZ');
  await expect(page.getByRole('combobox',{name:'影响范围'})).toHaveValue('');
  await expect(page.getByRole('combobox',{name:'紧急程度'})).toHaveValue('');
  await page.getByRole('textbox',{name:'问题标题'}).fill('WMS 登录后无响应，已重试');expect(creates).toBe(0);
  await page.getByRole('button',{name:'语音输入',exact:true}).click();
  await page.route('**/api/v1/voice/interpret',route=>route.fulfill({json:{id:'synthetic-browser-low-draft',candidate:{
    serviceCode:null,subject:'现场问题需要协助',description:'现场问题需要协助',fields:{},requiresReview:true,
    confidence:0.4,fallbackReason:'INTAKE_LOW_CONFIDENCE',
  }}}));
  await dialog.getByRole('textbox',{name:'问题描述',exact:true}).fill('现场问题需要协助');
  await dialog.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).last().check();
  await dialog.getByRole('button',{name:'整理为草稿'}).click();
  await expect(page.getByRole('combobox',{name:'服务类型'})).toHaveValue('');
  await expect(page.getByRole('status')).toContainText('暂时无法确定服务');
  await expect(page.getByRole('textbox',{name:'详细情况'})).toHaveValue('现场问题需要协助');expect(creates).toBe(0);
});
