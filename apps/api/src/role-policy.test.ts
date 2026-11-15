import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roleReviewDenial } from './role-policy.js';

test('role approval requires an independent administrator, not the proposer or subject',()=>{
  assert.equal(roleReviewDenial('admin-a','admin-a','engineer'),'ROLE_INDEPENDENT_REVIEW_REQUIRED');
  assert.equal(roleReviewDenial('engineer','admin-a','engineer'),'ROLE_INDEPENDENT_REVIEW_REQUIRED');
  assert.equal(roleReviewDenial('admin-b','admin-a','engineer'),undefined);
});
