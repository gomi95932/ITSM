import { test as base,expect } from '@playwright/test';

export const test=base.extend<{lanCrypto:void}>({
  lanCrypto:[async({page},use)=>{
    const errors:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));
    // Reproduce LAN HTTP's missing secure-context UUID API on the loopback CI stack.
    await page.addInitScript(()=>{
      Object.defineProperty(Crypto.prototype,'randomUUID',{configurable:true,value:undefined});
    });
    await use();
    expect(errors,'Business pages must not throw uncaught errors without native randomUUID').toEqual([]);
  },{auto:true}],
});

export { expect };
