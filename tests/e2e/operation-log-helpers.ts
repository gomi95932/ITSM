import type {Page} from '@playwright/test';
import {expect} from './fixtures';

export async function operationLogRows(page:Page,module:string,reason:string,object?:string){
  await page.getByRole('button',{name:'操作日志',exact:true}).click();
  await expect(page.getByRole('heading',{name:'操作日志',exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'模块',exact:true}).selectOption(module);
  await page.getByRole('combobox',{name:'结果',exact:true}).selectOption('APPLIED');
  await page.getByLabel('关键词',{exact:true}).fill(reason);
  if(object)await page.getByLabel('操作对象 ID').fill(object);
  const response=page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname==='/api/v1/admin/operation-logs'&&url.searchParams.get('q')===reason&&response.ok();
  });
  await page.getByRole('button',{name:'查询',exact:true}).click();
  await response;
  return page.getByRole('row').filter({hasText:reason});
}

export async function recordedOperation(page:Page,module:string,reason:string,object?:string){
  const rows=await operationLogRows(page,module,reason,object);
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('已生效');
  return rows;
}
