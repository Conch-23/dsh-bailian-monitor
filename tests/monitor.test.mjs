import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signQuery, money, normalizeCoupons, queryCoupons, CloudError } from '../lib/aliyun.js';
import { createMonitor, createRoute } from '../lib/index.js';

const now = Date.parse('2026-10-26T04:00:00Z');
const rawCoupon = { CashCouponNo: 'test-coupon', Status: 'Available', NominalValue: '300.00', Balance: '218.54', EffectiveTime: '2026-10-01T00:00:00Z', ExpiryTime: '2026-11-01T00:00:00Z', ApplicableProducts: '百炼', ApplicableScenarios: '按量付费' };
const body = { Success: true, Data: { CashCoupon: [rawCoupon] } };
const coupon = normalizeCoupons(body, now)[0];

function store(initial = { accessKeyId: 'test-id', accessKeySecret: 'test-secret' }) {
  let record = initial ? { kind: 'grant', payload: initial } : undefined;
  return { async readRecord() { return record; }, async modifyRecord(key, update) { const next = await update(record); if (next) record = next; return record; }, async deleteRecord() { record = undefined; } };
}

test('RPC signing matches a fixed RFC3986 canonical request, including unicode and punctuation', () => {
  const toSign = 'GET&%2F&A%3Da%2520b%2526%252F%25E4%25B8%25AD%26Z%3D~%2521%252A%2528%2529';
  const reference = createHmac('sha1', 'secret&').update(toSign).digest('base64');
  assert.equal(signQuery({ Z: '~!*()', A: 'a b&/中', Signature: 'excluded' }, 'secret'), reference);
});

test('unknown or malformed money never becomes zero', () => {
  for (const value of [undefined, null, '', 'bad', '-1', true, Infinity]) assert.equal(money(value), null);
  assert.equal(money('1,234.56'), 1234.56);
  assert.equal(money('0.00'), 0);
});

test('coupons preserve actual balances and account for validity', () => {
  assert.equal(coupon.balance, 218.54); assert.equal(coupon.active, true);
  assert.equal(coupon.availableBalance, 218.54); assert.equal(coupon.daysLeft, 6);
  assert.equal(normalizeCoupons(body, Date.parse('2026-11-02'))[0].availableBalance, 0);
  const unknown = normalizeCoupons({ Data: { CashCoupon: [{ ...rawCoupon, Balance: undefined, ExpiryTime: undefined }] } }, now)[0];
  assert.equal(unknown.balance, null); assert.equal(unknown.availableBalance, null); assert.equal(unknown.active, false);
  assert.throws(() => normalizeCoupons({ Data: {} }), /InvalidCouponResponse/);
});

test('only the fixed read-only BSS operation is sent; session secrets never enter the returned data', async () => {
  const result = await queryCoupons({ accessKeyId: 'test-id', accessKeySecret: 'test-secret', securityToken: 'test-sts' }, { now, fetchImpl: async (url, options) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://business.aliyuncs.com');
    assert.equal(u.searchParams.get('Action'), 'QueryCashCoupons');
    assert.equal(u.searchParams.get('SecurityToken'), 'test-sts');
    assert.equal(u.searchParams.get('Timestamp'), '2026-10-26T04:00:00Z');
    assert.equal(u.searchParams.get('Signature'), signQuery(Object.fromEntries(u.searchParams), 'test-secret'));
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => body };
  } });
  assert.equal(result[0].balance, 218.54);
  assert.doesNotMatch(JSON.stringify(result), /test-secret|test-sts|test-id/);
});

test('cloud and transport failures do not forward secret-bearing error bodies', async () => {
  await assert.rejects(queryCoupons({}, { fetchImpl: async () => { throw new Error('SECRET-URL'); } }), e => e instanceof CloudError && e.code === 'NetworkError' && !e.message.includes('SECRET'));
  await assert.rejects(queryCoupons({}, { fetchImpl: async () => ({ ok: false, json: async () => ({ Code: 'NotAuthorized', Message: 'SECRET', RequestId: 'safe-request' }) }) }), e => e.code === 'NotAuthorized' && e.requestId === 'safe-request' && !e.message.includes('SECRET'));
});

test('simultaneous reads coalesce and the minute cache and manual request floor work', async () => {
  let time = now, calls = 0;
  const monitor = createMonitor(store(), { clock: () => time, query: async () => { calls++; return [coupon]; } });
  await Promise.all([monitor.status(), monitor.status(), monitor.status()]);
  assert.equal(calls, 1);
  await monitor.status(true); assert.equal(calls, 1);
  time += 5000; await monitor.status(true); assert.equal(calls, 2);
  time += 59000; await monitor.status(); assert.equal(calls, 2);
  time += 1000; await monitor.status(); assert.equal(calls, 3);
});

test('failed refresh retains the last observed balance with its original timestamp and stale flag', async () => {
  let time = now, calls = 0;
  const monitor = createMonitor(store(), { clock: () => time, query: async () => { if (++calls > 1) throw new CloudError('NotAuthorized'); return [coupon]; } });
  const initial = await monitor.status(); time += 61000;
  const failed = await monitor.status();
  assert.equal(failed.coupons[0].balance, 218.54); assert.equal(failed.fetchedAt, initial.fetchedAt);
  assert.equal(failed.stale, true); assert.equal(failed.error.code, 'NotAuthorized');
  await monitor.status(true); assert.equal(calls, 2);
});

test('rotating credentials fences out old in-flight account responses', async () => {
  let finish;
  const monitor = createMonitor(store(), { clock: () => now, query: account => account.accessKeyId === 'new-id' ? Promise.resolve([{ ...coupon, no: 'new-coupon' }]) : new Promise(resolve => { finish = resolve; }) });
  const old = monitor.status();
  await new Promise(resolve => setImmediate(resolve));
  const updated = await monitor.configure({ accessKeyId: 'new-id', accessKeySecret: 'new-secret', securityToken: '' });
  finish([coupon]);
  const oldResult = await old;
  assert.equal(updated.coupons[0].no, 'new-coupon'); assert.equal(oldResult.coupons[0].no, 'new-coupon');
  assert.doesNotMatch(JSON.stringify(oldResult), /test-secret|new-secret|new-id/);
});

test('selection persists without re-entering credentials; removal clears cached data', async () => {
  const monitor = createMonitor(store(), { clock: () => now, query: async () => [coupon] });
  assert.equal((await monitor.configure({ selectedNo: 'test-coupon' })).selectedNo, 'test-coupon');
  await assert.rejects(monitor.configure({ endpoint: 'https://elsewhere.invalid' }));
  const disconnected = await monitor.disconnect();
  assert.equal(disconnected.configured, false); assert.deepEqual(disconnected.coupons, []);
});

test('external credential-store changes invalidate the cached account', async () => {
  const credentials = store();
  let calls = 0;
  const monitor = createMonitor(credentials, { clock: () => now, query: async account => { calls++; return [{ ...coupon, no: account.accessKeyId }]; } });
  await monitor.status();
  await credentials.modifyRecord('', async () => ({ kind: 'grant', payload: { accessKeyId: 'external-id', accessKeySecret: 'external-secret' } }));
  assert.equal((await monitor.status()).coupons[0].no, 'external-id'); assert.equal(calls, 2);
});

test('a synchronous query error can recover after the retry delay', async () => {
  let time = now, calls = 0;
  const monitor = createMonitor(store(), { clock: () => time, query: () => { if (++calls === 1) throw new CloudError('NetworkError'); return Promise.resolve([coupon]); } });
  assert.equal((await monitor.status()).stale, true);
  time += 10001;
  assert.equal((await monitor.status()).coupons[0].balance, 218.54); assert.equal(calls, 2);
});

test('exact routes validate envelopes and redact unexpected store errors', async () => {
  const route = createRoute(createMonitor({ readRecord: async () => { throw new Error('SECRET'); } }), 'status');
  const request = payload => new Request('http://localhost/api/bailian-monitor/status', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal((await route.fetch(request({}))).status, 400);
  const result = await route.fetch(request({ type: 'client-request', rpcId: 'test-rpc', method: 'bailian-monitor/status', payload: {} }));
  const envelope = await result.json();
  assert.equal(envelope.rpcId, 'test-rpc'); assert.equal(envelope.result.ok, false);
  assert.doesNotMatch(JSON.stringify(envelope), /SECRET/);
});
