import { test,expect } from './fixtures';
import { seedIntake } from '../support/request-intake.mjs';

test.skip(process.env.ITSM_REQUEST_INTAKE_CI_ENABLED!=='true','Requires the disposable request intake API');

for(const viewport of [{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844}]){
  test(`employee submits a service request and sees its approval progress on ${viewport.name}`,async({page})=>{
    const service=await seedIntake({browser:true});
    const subject=`试点权限申请 ${viewport.name}`;
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    await page.goto('/');
    await page.getByRole('button',{name:'服务目录',exact:true}).click();
    await page.getByRole('region',{name:'服务申请'}).getByRole('button',{name:new RegExp(service.name)}).click();
    await expect(page.getByRole('heading',{name:'提交服务申请',exact:true})).toBeVisible();
    await page.getByRole('textbox',{name:'申请标题'}).fill(subject);
    await page.getByRole('textbox',{name:'申请说明'}).fill('日常盘点需要查看库存明细');
    await page.getByRole('combobox',{name:'影响范围'}).selectOption('INDIVIDUAL');
    await page.getByRole('combobox',{name:'紧急程度'}).selectOption('LOW');
    await page.getByRole('combobox',{name:'目标系统'}).selectOption('WMS');
    await page.getByRole('textbox',{name:'申请用途'}).fill('库存查询');
    await page.getByRole('spinbutton',{name:'申请有效天数'}).fill('30');
    await page.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await page.getByRole('button',{name:'核对信息',exact:true}).click();
    await expect(page.getByRole('heading',{name:'确认申请信息'})).toBeVisible();
    await expect(page.getByText('30 天',{exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/request-intake-review-${viewport.name}.png`,fullPage:true});

    const response=page.waitForResponse(result=>new URL(result.url()).pathname==='/api/v1/tickets'&&result.request().method()==='POST');
    await page.getByRole('button',{name:'确认提交',exact:true}).click();
    const created=await response;
    expect(created.status()).toBe(201);
    expect(created.request().postDataJSON()).toMatchObject({serviceCode:service.code,formVersion:1,requestedValidityDays:30,fields:{system:'WMS',reason:'库存查询'}});
    await expect(page.getByRole('heading',{name:subject,exact:true})).toBeVisible();
    await expect(page.getByRole('region',{name:'申请进度'})).toContainText('等待发起');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/request-intake-progress-${viewport.name}.png`,fullPage:true});
  });
}
