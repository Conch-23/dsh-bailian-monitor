import { queryCoupons, errorMessage } from './aliyun.js';

export const name = 'bailian-monitor';
export const inject = ['connection', 'credentials'];
const KEY = 'bailian-monitor/account';
const PREFIX = 'bailian-monitor/';

function payloadObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数格式错误。');
  return value;
}

export function createMonitor(credentials, { query = queryCoupons, clock = Date.now } = {}) {
  let cache = null;
  let inFlight = null;
  let generation = 0;
  let retryAt = 0;
  let lastError = null;
  let accountKey = null;
  const read = async () => (await credentials.readRecord(KEY))?.payload ?? {};
  const clear = () => { generation++; cache = null; inFlight = null; retryAt = 0; lastError = null; accountKey = null; };
  const configured = a => Boolean(a.accessKeyId && a.accessKeySecret);

  async function status(force = false) {
    const a = await read();
    if (!configured(a)) { clear(); return { configured: false, coupons: [], selectedNo: '', fetchedAt: null, stale: false, error: null }; }
    const key = JSON.stringify([a.accessKeyId, a.accessKeySecret, a.securityToken]);
    if (key !== accountKey) { clear(); accountKey = key; }
    const now = clock();
    // Even manual refreshes coalesce and respect a five-second request floor.
    if (now >= retryAt && (!cache || (now - cache.fetchedAt >= (force ? 5000 : 60000)))) {
      if (!inFlight) {
        const gen = generation;
        const job = Promise.resolve().then(async () => {
          try {
            const coupons = await query(a);
            if (gen === generation) { cache = { coupons, fetchedAt: clock() }; lastError = null; retryAt = 0; }
          } catch (error) {
            if (gen === generation) { lastError = errorMessage(error); retryAt = clock() + 10000; }
          } finally { if (gen === generation) inFlight = null; }
        });
        inFlight = job;
      }
      await inFlight;
    }
    // A save/delete during the remote request must never return the previous account's data.
    const current = await read();
    if (a.accessKeyId !== current.accessKeyId || a.accessKeySecret !== current.accessKeySecret || a.securityToken !== current.securityToken) return status(false);
    return {
      configured: true, selectedNo: current.selectedNo ?? '',
      coupons: cache?.coupons ?? [], fetchedAt: cache?.fetchedAt ?? null,
      stale: Boolean(lastError) || Boolean(cache && clock() - cache.fetchedAt > 90000),
      error: lastError,
    };
  }

  async function configure(raw) {
    const input = payloadObject(raw);
    const allowed = ['accessKeyId', 'accessKeySecret', 'securityToken', 'selectedNo'];
    if (Object.keys(input).some(k => !allowed.includes(k))) throw new Error('存在不支持的设置项。');
    for (const [key, value] of Object.entries(input)) {
      if (typeof value !== 'string' || value.length > 10000 || (key !== 'securityToken' && !value.trim())) throw new Error('设置项不能为空或格式不正确。');
    }
    const changesKeys = 'accessKeyId' in input || 'accessKeySecret' in input || 'securityToken' in input;
    if (changesKeys && (!input.accessKeyId?.trim() || !input.accessKeySecret?.trim())) throw new Error('请同时填写 AccessKey ID 和 Secret。');
    await credentials.modifyRecord(KEY, async previous => ({
      kind: 'grant',
      payload: { ...(previous?.payload ?? {}), ...Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v.trim()])) },
    }));
    if (changesKeys) clear();
    return status(false);
  }

  return {
    status, configure,
    async disconnect() { await credentials.deleteRecord(KEY); clear(); return status(false); },
  };
}

export function createRoute(monitor, action) {
  const endpoint = PREFIX + action;
  return {
    path: '/api/' + endpoint, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let envelope;
      try { envelope = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
      if (!envelope || envelope.type !== 'client-request' || envelope.method !== endpoint || typeof envelope.rpcId !== 'string' || envelope.rpcId.length > 200) return new Response('Invalid request', { status: 400 });
      const { payload } = envelope;
      let result;
      try {
        if (request.signal.aborted) throw new Error('请求已取消。');
        let value;
        switch (action) {
          case 'status': {
            const input = payloadObject(payload);
            if (Object.keys(input).some(k => k !== 'force') || ('force' in input && typeof input.force !== 'boolean')) throw new Error('参数格式错误。');
            value = await monitor.status(input.force === true); break;
          }
          case 'configure': value = await monitor.configure(payload); break;
          case 'disconnect': value = await monitor.disconnect(); break;
          default: throw new Error('不支持的操作。');
        }
        result = { ok: true, value };
      } catch {
        // Validation/store exceptions may include secret-bearing input. Return a fixed diagnostic.
        result = { ok: false, error: { code: 'bailian/request-failed', message: '操作失败，请检查填写内容或本地凭证存储状态。', details: {} } };
      }
      return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result });
    },
  };
}

export function apply(ctx) {
  const monitor = createMonitor(ctx.credentials);
  // Exact Connection Fetch routes work over Desktop IPC and Web HTTP, and
  // Connection admits only owner Peers before invoking their fetch handlers.
  // The shared RPC interceptor belongs exclusively to the built-in Gateway.
  for (const action of ['status', 'configure', 'disconnect']) {
    ctx.effect(() => ctx.connection.fetch.register(createRoute(monitor, action)), `bailian-monitor: ${action}`);
  }
}
