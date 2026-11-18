import { test, expect } from './fixtures';
import { createFulfillmentFixture, fulfillmentSql, literal } from '../support/fulfillment.mjs';

for (const viewport of [{ name:'desktop', width:1440, height:900 }, { name:'mobile', width:390, height:844 }]) {
  test(`report separates incidents and requests on ${viewport.name}`, async ({ page }) => {
    const day = viewport.name === 'desktop' ? '2025-05-17' : '2025-05-18';
    const request = await createFulfillmentFixture();
    await fulfillmentSql(`UPDATE tickets SET status='CLOSED',created_at=${literal(`${day} 10:00:00+08`)}
      WHERE id=${literal(request.ticketId)};
      INSERT INTO ticket_feedback(ticket_id,requester_id,rating) VALUES(${literal(request.ticketId)},'employee-1',4)`);
    await page.setViewportSize({ width:viewport.width, height:viewport.height });
    await page.goto('/');
    await page.getByRole('combobox',{ name:'开发身份' }).selectOption('agent-1');
    await page.getByRole('button',{ name:'服务报表', exact:true }).click();
    const group = page.getByRole('combobox',{ name:'支持组' });
    await expect(page.getByText('新增故障',{ exact:true })).toBeVisible();
    await expect(group).toBeEnabled();
    await group.selectOption(request.groupId);
    await page.getByLabel('开始日期').fill(day);
    await page.getByLabel('结束日期').fill(day);
    const type = page.getByRole('combobox',{ name:'工单类型' });
    await type.selectOption('REQ');
    await page.getByRole('button',{ name:'查询', exact:true }).click();
    await expect(page.getByText('新增请求',{ exact:true })).toBeVisible();
    await expect(page.getByText('4 / 5',{ exact:true })).toBeVisible();
    const ticket = page.getByRole('button',{ name:`REQ-${request.ticketId}`, exact:true });
    await expect(ticket).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path:`test-results/reports-requests-${viewport.name}.png`, fullPage:true });
    await type.selectOption('INC');
    await page.getByRole('button',{ name:'查询', exact:true }).click();
    await expect(page.getByText('新增故障',{ exact:true })).toBeVisible();
    await expect(ticket).toHaveCount(0);
  });
}
