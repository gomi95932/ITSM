import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { createFulfillmentFixture, fulfillmentSql as sql, literal as q } from '../support/fulfillment.mjs';

for (const viewport of [{ name:'desktop', width:1440, height:900 }, { name:'mobile', width:390, height:844 }]) {
  test(`structured waiting and scoped reporting on ${viewport.name}`, async ({ page }) => {
    const f = await createFulfillmentFixture({ state:null });
    await sql(`UPDATE tickets SET created_at='2025-05-23 10:00:00+08' WHERE id=${q(f.ticketId)}`);
    const accept = await page.request.post(`/api/v1/tickets/${f.ticketId}/actions`, {
      headers:{ 'X-Dev-User':'agent-1', 'Idempotency-Key':randomUUID() },
      data:{ contentClass:'GENERAL', action:'ACCEPT', expectedVersion:1, comment:'I own the follow-up' } });
    expect(accept.status()).toBe(200);
    await page.setViewportSize({ width:viewport.width, height:viewport.height });
    await page.goto('/');
    await page.getByRole('combobox', { name:'开发身份' }).selectOption('agent-1');
    await expect(page.getByRole('heading', { name:'我提交的工单', exact:true })).toBeVisible();
    await page.goto(`/#/tickets/${f.ticketId}`);
    await page.getByRole('button', { name:'请求补充', exact:true }).click();
    const form = page.locator('.action-form');
    await form.getByRole('textbox', { name:'需要补充的内容', exact:true }).fill('Please confirm a suitable time');
    await form.getByRole('combobox', { name:'等待原因', exact:true }).selectOption('USER_AVAILABILITY');
    expect(await form.getByRole('combobox', { name:'等待原因' }).locator('option[value="VENDOR_PARTS"]').count()).toBe(0);
    await form.getByLabel('补充截止时间', { exact:true }).fill('2099-06-01T10:30');
    await form.getByRole('checkbox', { name:'本次内容不含密码、密钥及安全事件证据' }).check();
    await form.getByRole('button', { name:'请求补充', exact:true }).click();
    const waiting = page.getByRole('region', { name:'等待跟进', exact:true });
    await expect(waiting).toContainText('等待用户配合时间');
    await expect(waiting).toContainText('2099');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path:`test-results/waiting-detail-${viewport.name}.png`, fullPage:true });

    await page.getByRole('combobox', { name:'开发身份' }).selectOption('employee-1');
    await expect(page.getByRole('heading', { name:'我提交的工单', exact:true })).toBeVisible();
    await page.goto(`/#/tickets/${f.ticketId}`);
    await expect(waiting).toContainText('等待用户配合时间');
    await page.getByRole('button', { name:'补充信息', exact:true }).click();
    await form.getByRole('textbox', { name:'回复内容', exact:true }).fill('The time has been confirmed');
    await form.getByRole('checkbox', { name:'本次内容不含密码、密钥及安全事件证据' }).check();
    await form.getByRole('button', { name:'补充信息', exact:true }).click();
    await expect(waiting).toHaveCount(0);

    await page.getByRole('combobox', { name:'开发身份' }).selectOption('agent-1');
    await expect(page.getByRole('heading', { name:'我提交的工单', exact:true })).toBeVisible();
    await page.goto(`/#/tickets/${f.ticketId}`);
    await page.getByRole('button', { name:'等待厂商', exact:true }).click();
    await form.getByRole('textbox', { name:'回复内容', exact:true }).fill('Waiting for a replacement part');
    await form.getByRole('combobox', { name:'等待原因', exact:true }).selectOption('VENDOR_PARTS');
    await form.getByLabel('下次跟进时间', { exact:true }).fill('2099-06-01T10:30');
    await form.getByRole('textbox', { name:'厂商工单号', exact:true }).fill('CI-UI-VENDOR');
    await form.getByRole('textbox', { name:'跟进负责人', exact:true }).fill('Current engineer');
    await form.getByRole('checkbox', { name:'本次内容不含密码、密钥及安全事件证据' }).check();
    await form.getByRole('button', { name:'等待厂商', exact:true }).click();
    await expect(waiting).toContainText('等待备件或物料');
    await expect(waiting).toContainText('2099');
    await page.getByRole('combobox', { name:'开发身份' }).selectOption('employee-1');
    await expect(page.getByRole('heading', { name:'我提交的工单', exact:true })).toBeVisible();
    await page.goto(`/#/tickets/${f.ticketId}`);
    await expect(waiting).toContainText('等待备件或物料');
    await expect(page.getByRole('button', { name:'恢复处理', exact:true })).toHaveCount(0);
    await page.getByRole('combobox', { name:'开发身份' }).selectOption('agent-1');
    await expect(page.getByRole('heading', { name:'我提交的工单', exact:true })).toBeVisible();
    await page.goto(`/#/tickets/${f.ticketId}`);
    await page.getByRole('button', { name:'恢复处理', exact:true }).click();
    const explanation=form.getByRole('textbox', { name:'继续处理说明', exact:true });
    await expect(explanation).toHaveAttribute('required','');
    await explanation.fill('Replacement received; verifying recovery');
    await form.getByRole('checkbox', { name:'本次内容不含密码、密钥及安全事件证据' }).check();
    await form.getByRole('button', { name:'恢复处理', exact:true }).click();
    await expect(waiting).toHaveCount(0);
    await expect(page.getByText('已恢复处理', { exact:true })).toBeVisible();
    await expect(page.getByRole('button', { name:'恢复处理', exact:true })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name:'等待厂商', exact:true }).click();
    await form.getByRole('textbox', { name:'回复内容', exact:true }).fill('A new vendor verification window');
    await form.getByRole('combobox', { name:'等待原因', exact:true }).selectOption('VENDOR_PARTS');
    await form.getByLabel('下次跟进时间', { exact:true }).fill('2099-06-02T10:30');
    await form.getByRole('textbox', { name:'厂商工单号', exact:true }).fill('CI-UI-VENDOR-2');
    await form.getByRole('textbox', { name:'跟进负责人', exact:true }).fill('Current engineer');
    await form.getByRole('checkbox', { name:'本次内容不含密码、密钥及安全事件证据' }).check();
    await form.getByRole('button', { name:'等待厂商', exact:true }).click();
    await expect(waiting).toContainText('等待备件或物料');
    await sql(`UPDATE tickets SET waiting_since=clock_timestamp()-interval '2 hours',waiting_due_at=clock_timestamp()-interval '1 hour'
      WHERE id=${q(f.ticketId)}`);
    await page.getByRole('button', { name:'刷新工单', exact:true }).click();
    await expect(waiting).toContainText('已到期');

    const legacy = await createFulfillmentFixture({ groupId:f.groupId, state:null });
    await sql(`UPDATE tickets SET status='WAITING_USER',created_at='2025-05-23 11:00:00+08' WHERE id=${q(legacy.ticketId)}`);
    await page.getByRole('button', { name:'服务报表', exact:true }).click();
    const group = page.getByRole('combobox', { name:'支持组', exact:true });
    await expect(group).toBeEnabled(); await group.selectOption(f.groupId);
    await page.getByLabel('开始日期').fill('2025-05-23'); await page.getByLabel('结束日期').fill('2025-05-23');
    await page.getByRole('combobox', { name:'工单类型', exact:true }).selectOption('REQ');
    await page.getByRole('button', { name:'查询', exact:true }).click();
    const summary = page.getByRole('table', { name:'等待原因统计', exact:true });
    const vendor = summary.getByRole('row').filter({ hasText:'等待备件或物料' });
    await expect(vendor.getByRole('cell').nth(3)).toHaveText('1');
    const unknown = summary.getByRole('row').filter({ hasText:'待补充' });
    await expect(unknown.getByRole('cell').nth(3)).toHaveText('未记录');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path:`test-results/waiting-reports-${viewport.name}.png`, fullPage:true });
  });
}
