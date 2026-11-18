import { test, expect } from './fixtures';
import { createFulfillmentFixture, fulfillmentSql, literal } from '../support/fulfillment.mjs';

for (const viewport of [{ name:'desktop', width:1440, height:900 }, { name:'mobile', width:390, height:844 }]) {
  test(`report shows current personal responsibility without claiming offered candidates on ${viewport.name}`, async ({ page }) => {
    const day = viewport.name === 'desktop' ? '2025-05-19' : '2025-05-20';
    const owned = await createFulfillmentFixture();
    const offered = await createFulfillmentFixture({ groupId:owned.groupId });
    await fulfillmentSql(`UPDATE tickets SET created_at=${literal(`${day} 10:00:00+08`)},assignee_id='agent-1'
      WHERE id=${literal(owned.ticketId)};
      UPDATE tickets SET created_at=${literal(`${day} 11:00:00+08`)},pending_group_id=owner_group_id,pending_assignee_id='agent-2',
        assignment_kind='OFFER',assignment_state='PENDING',assignment_offered_at=now()
      WHERE id=${literal(offered.ticketId)}`);
    await page.setViewportSize({ width:viewport.width, height:viewport.height });
    await page.goto('/');
    await page.getByRole('combobox',{ name:'开发身份' }).selectOption('agent-1');
    await page.getByRole('button',{ name:'服务报表', exact:true }).click();
    const group = page.getByRole('combobox',{ name:'支持组' });
    await expect(group).toBeEnabled();
    await group.selectOption(owned.groupId);
    await page.getByLabel('开始日期').fill(day);
    await page.getByLabel('结束日期').fill(day);
    await page.getByRole('combobox',{ name:'工单类型' }).selectOption('REQ');
    await page.getByRole('button',{ name:'查询', exact:true }).click();
    const owner = page.getByRole('combobox',{ name:'当前负责人' });
    const detail = page.getByRole('table',{ name:'工单指标明细' });
    await expect(page.getByRole('region',{ name:'当前责任分布' })).toBeVisible();
    await expect(detail.getByRole('button',{ name:`REQ-${owned.ticketId}`, exact:true })).toBeVisible();
    await expect(detail.getByRole('button',{ name:`REQ-${offered.ticketId}`, exact:true })).toBeVisible();
    await expect(owner.locator('option[value="PERSON:agent-1"]')).toHaveCount(1);
    await expect(owner.locator('option[value="PERSON:agent-2"]')).toHaveCount(0);
    await owner.selectOption('UNASSIGNED');
    await expect(detail).toHaveCount(0);
    await page.getByRole('button',{ name:'查询', exact:true }).click();
    await expect(detail.getByRole('button',{ name:`REQ-${owned.ticketId}`, exact:true })).toHaveCount(0);
    await expect(detail.getByRole('button',{ name:`REQ-${offered.ticketId}`, exact:true })).toBeVisible();
    await expect(detail.getByText(/派单待接收/)).toBeVisible();
    await owner.selectOption('PERSON:agent-1');
    await expect(detail).toHaveCount(0);
    await page.getByRole('button',{ name:'查询', exact:true }).click();
    await expect(detail.getByRole('button',{ name:`REQ-${owned.ticketId}`, exact:true })).toBeVisible();
    await expect(detail.getByRole('button',{ name:`REQ-${offered.ticketId}`, exact:true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path:`test-results/reports-personal-${viewport.name}.png`, fullPage:true });
    await page.getByRole('combobox',{ name:'工单类型' }).selectOption('INC');
    await expect(owner).toHaveValue('ALL');
    await expect(detail).toHaveCount(0);
    await page.getByRole('button',{ name:'查询', exact:true }).click();
    await expect(page.getByText('新增故障',{ exact:true })).toBeVisible();
    await expect(detail.getByRole('button',{ name:`REQ-${owned.ticketId}`, exact:true })).toHaveCount(0);
  });

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
