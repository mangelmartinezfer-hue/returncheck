import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runCheck} from '../src/engine.mjs';
import {windowBasisFromClause} from '../src/decision.mjs';
import {validateRequest} from '../src/contract.mjs';
import {recoverOpenedBranch} from '../src/condition-branch.mjs';

const closed = 'If you’re not totally satisfied with your IKEA purchase you can return new and unopened products within 365 days, together with your proof of purchase, for a full refund.';
const opened = 'You may also return open products within 180 days, with your proof of purchase, for a full refund.';
const source = 'https://www.ikea.com/us/en/customer-service/returns-claims/';
const request = {product_url:'https://www.ikea.com/us/en/p/billy-bookcase-white-20522046/',buyer_country:'US',merchant:'IKEA',item_condition:'opened',reason:'changed_mind',page_source_url:source,page_text:closed+' '+opened,__no_corpus:true};
const answer = () => ({verdict:'YES_WITH_CONDITIONS',confidence:0.95,answer_human:'Yes, within 365 days.',reason:'changed_mind',policy:{return_category:'FiniteReturnWindow',merchant_return_days:365,window_basis:'purchase_date',return_method:['ReturnByMail'],item_conditions_accepted:['UsedCondition'],exceptions:['changed_mind']},evidence:{source_url:request.product_url,exact_clause:closed},merchant_resolved:{name:'IKEA',domain:'ikea.com'}});
const env = () => ({AI:{run:async()=>({response:answer()})},DB:{prepare:()=>({bind:()=>({run:async()=>({}),first:async()=>null,all:async()=>({results:[]})})})}});

test('proof of purchase is not a temporal anchor; genuine and ambiguous dates survive',()=>{
 for(const text of [closed,opened,'with your proof of purchase','with confirmation of delivery'])assert.equal(windowBasisFromClause(text),null);
 assert.equal(windowBasisFromClause('Return within 30 days of delivery with proof of purchase.'),'delivery_date');
 assert.equal(windowBasisFromClause('Return within 30 days of purchase with proof of purchase.'),'purchase_date');
 assert.equal(windowBasisFromClause('Return within 30 days of purchase or delivery.'),null);
});
test('full engine: wrong sealed clause recovers explicit adjacent opened branch',async()=>{
 const r=await runCheck(env(),request);
 assert.equal(r.verdict,'YES_WITH_CONDITIONS');assert.equal(r.policy.merchant_return_days,180);
 assert.equal(r.evidence.exact_clause,opened);assert.equal(r.evidence.source_url,source);
 assert.equal(r.policy.window_basis,null);assert.equal(r.policy.deadline_date,null);
 assert.deepEqual(r.policy.return_method,[]);assert.deepEqual(r.policy.item_conditions_accepted,[]);
 assert.deepEqual(r.policy.exceptions,[]);assert.ok(!r.missing_input?.includes('purchase_date'));
 assert.ok(!r.answer_human.includes('365'));assert.equal(r.meta.condition_branch_recovered,true);
});
test('sealed variant keeps 365 but does not infer purchase date or used condition',async()=>{
 const r=await runCheck(env(),{...request,item_condition:'unopened',purchase_date:'2020-01-01'});
 assert.equal(r.policy.merchant_return_days,365);assert.equal(r.policy.window_basis,null);
 assert.equal(r.policy.deadline_date,null);assert.notEqual(r.verdict,'NO');
 assert.deepEqual(r.policy.item_conditions_accepted,['NewCondition']);assert.deepEqual(r.policy.exceptions,[]);
});
test('no recovery for used, intervening scope, conflicts, duplicates or shortened quotes',async()=>{
 for(const [condition,text] of [['used',request.page_text],['opened',closed+' Cosmetics. '+opened],['opened',request.page_text+' Opened products cannot be returned.'],['opened',request.page_text+' '+request.page_text],['opened',closed+' Open products may be returned if approved by the manager.']]){
  assert.equal(recoverOpenedBranch(answer(),{...request,item_condition:condition},text),false);
 }
 const r=await runCheck(env(),{...request,page_text:closed+' Refunds go to the original payment method.'});
 assert.equal(r.verdict,'UNKNOWN');assert.equal(r.meta.guard.name,'opened_item_unverified');
});
test('source URL validation is additive and rejects non-HTTP/credentials/missing content',()=>{
 assert.equal(validateRequest(request).value.page_source_url,source);
 for(const value of ['javascript:alert(1)','https://user:pass@example.com',42,'invalid']) assert.equal(validateRequest({...request,page_source_url:value}).ok,false);
 assert.equal(validateRequest({...request,page_text:undefined}).ok,false);
 assert.equal(validateRequest({...request,page_source_url:undefined}).ok,true);
});

test('captured full IKEA policy: both branches, restrictions and source survive the engine',async()=>{
 const page_text=await readFile(new URL('./fixtures/ikea-policy-2026-10-02.txt',import.meta.url),'utf8');
 assert.ok(page_text.includes('custom countertops'));
 for(const [item_condition,days] of [['unopened',365],['opened',180]]){
  const r=await runCheck(env(),{...request,page_text,item_condition});
  assert.equal(r.verdict,'YES_WITH_CONDITIONS');assert.equal(r.policy.merchant_return_days,days);
  assert.equal(r.policy.window_basis,null);assert.equal(r.evidence.source_url,source);
  assert.ok(!r.missing_input?.includes('purchase_date'));
 }
});
test('legacy source fallback remains explicit and validation preserves the new field into the engine',async()=>{
 const validated=validateRequest(request);
 const r=await runCheck(env(),{...validated.value,__no_corpus:true});
 assert.equal(r.evidence.source_url,source);
 const old=await runCheck(env(),{...request,page_source_url:undefined});
 assert.equal(old.evidence.source_url,request.product_url);
});
