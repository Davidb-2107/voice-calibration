import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startCalibrationUi} from '../../dist/calibration/http-server.js';

for (const linkType of ['invite', 'recovery']) {
test(`served ${linkType} HTML explains password refusal and supports activation without provider execution`, async () => {
  let starts=0;
  const api=await startCalibrationUi({
    browserAuth:{url:'https://fixture.supabase.co',publishableKey:'fixture-public'},
    resolveApplication:async()=>{starts++;throw new Error('No business engine may start in this browser fixture');},
    closeApplications:async()=>{},
  });
  let browser;
  try {
    browser=await chromium.launch();
    const page=await browser.newPage();
    const failures=[];let updates=0;let reads=0;let refusal='same_password';
    page.on('pageerror',error=>failures.push(error.message));
    await page.route('https://fixture.supabase.co/auth/v1/user',async route=>{
      if(route.request().method()==='PUT') {
        updates++;
        if(refusal) {
          await route.fulfill({status:422,json:{code:422,error_code:refusal,msg:'Private upstream diagnostic'}});
          return;
        }
      }
      await route.fulfill({json:{email:'invitation@example.invalid'}});
    });
    await page.route('**/api/v1/**',async route=>{
      assert.equal(route.request().method(),'GET');
      assert.equal(route.request().headers().authorization,'Bearer fixture-access');
      reads++;
      await route.fulfill({json:route.request().url().endsWith('/bootstrap')?
        {sessionNonce:'fixture',config:{configured:true},profiles:[],recentRuns:[]}:{items:[]}});
    });
    await page.goto(api.url+'/#access_token=fixture-access&refresh_token=fixture-refresh&expires_in=3600&type='+linkType);
    await page.locator('#password-setup').waitFor({state:'visible'});
    assert.equal(new URL(page.url()).hash,'');
    assert.equal(reads,0);
    await page.reload();
    await page.locator('#password-setup').waitFor({state:'visible'});
    await page.locator('#new-password').fill('safe-fixture-password');
    await page.locator('#confirm-password').fill('mismatched-password');
    await page.locator('#password-submit').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('identiques'));
    assert.equal(updates,0);
    await page.locator('#confirm-password').fill('safe-fixture-password');
    await page.locator('#password-submit').click();
    await page.waitForFunction(()=>!document.querySelector('#password-submit').disabled);
    assert.equal(await page.locator('#status').textContent(),
      'Ce mot de passe est déjà celui de votre compte. Choisissez-en un différent, ou connectez-vous avec ce mot de passe.');
    assert.equal(updates,1);
    assert.equal(reads,0);
    assert.equal(await page.locator('#new-password').inputValue(),'');
    assert.equal(await page.locator('#confirm-password').inputValue(),'');
    refusal='unrecognized_error';
    await page.locator('#new-password').fill('safe-fixture-password');
    await page.locator('#confirm-password').fill('safe-fixture-password');
    await page.locator('#password-submit').click();
    await page.waitForFunction(()=>!document.querySelector('#password-submit').disabled);
    assert.equal(await page.locator('#status').textContent(),
      'Impossible de définir le mot de passe. Réessayez ou demandez une nouvelle invitation.');
    assert.equal(updates,2);
    assert.equal(reads,0);
    refusal='';
    await page.locator('#new-password').fill('safe-fixture-password');
    await page.locator('#confirm-password').fill('safe-fixture-password');
    await page.locator('#password-submit').click();
    await page.locator('#workspace').waitFor({state:'visible'});
    assert.equal(updates,3);
    assert.equal(starts,0);
    assert.deepEqual(failures,[]);
    const stored=await page.evaluate(()=>Object.values(sessionStorage).join());
    assert.ok(!stored.includes('safe-fixture-password'));
  } finally {await browser?.close();await api.close();}
});
}
