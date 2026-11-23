import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./tests/e2e',workers:1,retries:0,use:{baseURL:process.env.ITSM_E2E_BASE_URL??'http://127.0.0.1:8088',browserName:'chromium',trace:'retain-on-failure'},reporter:'list'});
