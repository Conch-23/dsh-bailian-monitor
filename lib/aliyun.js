import { createHmac, randomUUID } from 'node:crypto';

const ENDPOINT = 'https://business.aliyuncs.com/';
const encode = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Alibaba Cloud BSS RPC v1: RFC3986, sorted parameters, HMAC-SHA1(secret + '&').
export function signQuery(parameters, secret) {
  const canonical = Object.keys(parameters).filter(k => k !== 'Signature').sort()
    .map(k => `${encode(k)}=${encode(parameters[k])}`).join('&');
  return createHmac('sha1', `${secret}&`).update(`GET&%2F&${encode(canonical)}`).digest('base64');
}

export class CloudError extends Error {
  constructor(code, requestId = '') {
    // Never forward the response body, request URL, signature, or credentials.
    const safeCode = /^[A-Za-z0-9_.-]{1,100}$/.test(String(code)) ? String(code) : 'CloudError';
    super(safeCode);
    this.code = safeCode;
    this.requestId = /^[A-Za-z0-9-]{1,100}$/.test(String(requestId)) ? String(requestId) : '';
  }
}

export function money(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).replaceAll(',', '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function normalizeCoupons(body, now = Date.now()) {
  const raw = body?.Data?.CashCoupon;
  if (!Array.isArray(raw)) throw new CloudError('InvalidCouponResponse');
  return raw.map(row => {
    const balance = money(row.Balance);
    const nominalValue = money(row.NominalValue);
    const effectiveTime = typeof row.EffectiveTime === 'string' ? row.EffectiveTime : null;
    const expiryTime = typeof row.ExpiryTime === 'string' ? row.ExpiryTime : null;
    const start = effectiveTime ? Date.parse(effectiveTime) : NaN;
    const end = expiryTime ? Date.parse(expiryTime) : NaN;
    const status = String(row.Status ?? 'Unknown');
    const timingKnown = Number.isFinite(start) && Number.isFinite(end);
    const active = timingKnown && status.toLowerCase() === 'available' && start <= now && end > now;
    return {
      no: String(row.CashCouponNo ?? row.CashCouponId ?? ''),
      description: String(row.Description ?? ''),
      status, balance, nominalValue, effectiveTime, expiryTime,
      products: String(row.ApplicableProducts ?? ''),
      scenarios: String(row.ApplicableScenarios ?? ''),
      active, timingKnown,
      availableBalance: !timingKnown || balance === null ? null : active ? balance : 0,
      daysLeft: Number.isFinite(end) ? Math.ceil((end - now) / 86400000) : null,
    };
  });
}

export async function queryCoupons(account, { fetchImpl = globalThis.fetch, now = Date.now(), signal } = {}) {
  const parameters = {
    Action: 'QueryCashCoupons', Version: '2017-12-14', Format: 'JSON',
    AccessKeyId: account.accessKeyId, SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0', SignatureNonce: randomUUID(),
    Timestamp: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  if (account.securityToken) parameters.SecurityToken = account.securityToken;
  const query = new URLSearchParams({ ...parameters, Signature: signQuery(parameters, account.accessKeySecret) });
  let response;
  try {
    response = await fetchImpl(`${ENDPOINT}?${query}`, {
      method: 'GET', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new CloudError('NetworkError');
  }
  let body;
  try { body = await response.json(); } catch { throw new CloudError('InvalidJSON'); }
  if (!response.ok || body.Success !== true) throw new CloudError(body.Code ?? `HTTP${response.status}`, body.RequestId);
  return normalizeCoupons(body, now);
}

export function errorMessage(error) {
  const code = error instanceof CloudError ? error.code : 'InternalError';
  let message = '查询失败，请稍后刷新。';
  if (/NotAuthorized|Forbidden|AccessDenied|NoPermission/i.test(code)) message = '无权查询代金券。请为该 RAM 用户授予 bss:DescribeCoupons，并检查费用中心访问权限。';
  else if (/InvalidAccessKey|SignatureDoesNotMatch|InvalidSecurityToken|ExpiredToken/i.test(code)) message = '阿里云凭证无效或已过期，请在设置中更新。';
  else if (/Network|HTTP5|Throttl/i.test(code)) message = '阿里云暂时无法连接或请求受限，稍后会自动重试。';
  else if (/NotApplicable/i.test(code)) message = '当前账号或站点不支持此查询接口，请核对阿里云中国站账号及代金券类型。';
  else if (/InvalidCouponResponse|InvalidJSON/i.test(code)) message = '阿里云返回的数据格式无法识别，未将缺失数据当作零余额。';
  else if (/InvalidTime|TimeExpired/i.test(code)) message = '请求时间不正确，请检查电脑时间。';
  return { code, message, requestId: error instanceof CloudError ? error.requestId : '' };
}
