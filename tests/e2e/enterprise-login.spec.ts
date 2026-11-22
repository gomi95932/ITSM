import {test,expect} from './fixtures';
test('independent enterprise entry offers a fixed login and never a development identity',async({page})=>{
  await page.route('**/api/v1/auth/config',route=>route.fulfill({json:{mode:'dingtalk',corpId:'',configured:false,oidcConfigured:true}}));
  await page.route('**/api/v1/auth/me',route=>route.fulfill({status:401,json:{code:'LOGIN_REQUIRED'}}));
  await page.goto('/?login=failed');
  await expect(page.getByRole('link',{name:'企业账号登录'})).toHaveAttribute('href','/api/v1/auth/oidc/start');
  await expect(page.getByRole('combobox',{name:'开发身份'})).toBeHidden();
  await expect(page.getByRole('alert')).toContainText('身份关联');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/enterprise-login-390.png',fullPage:true});
});
test('ordinary browser offers DingTalk authorization with no workbench restriction',async({page})=>{
  await page.route('**/api/v1/auth/config',route=>route.fulfill({json:{mode:'dingtalk',corpId:'fixture-corp',configured:true,oidcConfigured:false,dingtalkWebConfigured:true}}));
  await page.route('**/api/v1/auth/me',route=>route.fulfill({status:401,json:{code:'LOGIN_REQUIRED'}}));
  await page.goto('/');
  await expect(page.getByRole('link',{name:'钉钉扫码登录'})).toHaveAttribute('href','/api/v1/auth/dingtalk-web/start');
  await expect(page.getByText('请从钉钉工作台进入 IT 服务台。')).toBeHidden();
  await expect(page.getByRole('combobox',{name:'开发身份'})).toBeHidden();
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.getByRole('link',{name:'钉钉扫码登录'})).toBeVisible();
    await page.screenshot({path:`test-results/dingtalk-browser-login-${width}.png`,fullPage:true});
  }
});
