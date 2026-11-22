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
