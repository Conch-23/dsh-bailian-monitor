window.__ModuleLoader__.load({ id: 'dsh-bailian-monitor', factory: require => {
  const React = require('react');
  const { createPortal } = require('react-dom');
  const h = React.createElement;
  const money = n => n === null || n === undefined ? '—' : `¥${Number(n).toFixed(2)}`;
  const count = n => Number(n || 0).toLocaleString('zh-CN');
  const date = s => s && Number.isFinite(new Date(s).getTime()) ? new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未知';
  const STYLE = `
  .blm-trigger{border:1px solid #ccd5d9;border-radius:20px;background:transparent;color:inherit;padding:5px 11px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
  .blm-trigger[data-warn=true]{border-color:#c68137;color:#b66c1e}
  .blm-shade{position:fixed;inset:0;z-index:10000;background:#0007;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
  .blm-dialog{width:620px;max-width:100%;max-height:90vh;overflow:auto;border-radius:18px;border:1px solid #98a8b94a;background:#f7f9fb;color:#1b2e3c;box-shadow:0 24px 90px #0005;font:14px/1.6 system-ui,sans-serif;padding:25px;box-sizing:border-box}
  .blm-dialog *{box-sizing:border-box}.blm-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.blm-head h2{font-size:20px;margin:0}.blm-head small{font-size:12px;color:#617482}.blm-close{font-size:24px;border:0;background:transparent;cursor:pointer;color:inherit;padding:0 6px}
  .blm-balance{padding:20px 0 10px}.blm-balance strong{display:block;font-size:42px;letter-spacing:-1.3px;line-height:1.3}.blm-muted{font-size:12px;color:#617482}.blm-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.blm-row.between{justify-content:space-between}.blm-block{margin-top:18px;padding:16px;border:1px solid #dce3e8;border-radius:12px;background:#fff}.blm-block h3{font-size:14px;margin:0 0 10px}.blm-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.blm-stat{padding:10px;border-radius:8px;background:#f1f5f7}.blm-stat strong{display:block;font-size:19px}.blm-stat span{font-size:11px;color:#617482}.blm-btn{font:inherit;font-size:12px;padding:6px 11px;border:1px solid #c6d2da;border-radius:7px;background:#fff;color:#243f51;cursor:pointer}.blm-btn.primary{background:#235a73;color:#fff;border-color:#235a73}.blm-btn:disabled{opacity:.5;cursor:default}.blm-dialog select,.blm-dialog input{width:100%;font:inherit;border:1px solid #c6d2da;border-radius:7px;background:#fff;color:#243f51;padding:8px;margin:4px 0 12px}.blm-dialog label{font-size:12px;display:block}.blm-dialog p{margin:8px 0}.blm-note{padding:9px 11px;background:#edf3f6;border-radius:8px;font-size:12px}.blm-warn{background:#fff0da;color:#86500d}.blm-error{background:#fce8e7;color:#93382f;overflow-wrap:anywhere}.blm-meta{font-size:12px;overflow-wrap:anywhere}.blm-meter{height:7px;background:#e2e9ee;border-radius:8px;overflow:hidden;margin:10px 0}.blm-meter i{height:100%;display:block;background:#408a86}.blm-dialog a{color:#246c91}.blm-form{margin-top:12px}.blm-footer{margin-top:16px;font-size:11px;color:#617482}
  @media(prefers-color-scheme:dark){.blm-dialog{background:#1b252d;color:#e6edf2}.blm-block,.blm-dialog select,.blm-dialog input,.blm-btn{background:#24323c;color:#e6edf2;border-color:#435460}.blm-stat,.blm-note{background:#2a3d49}.blm-muted,.blm-stat span,.blm-head small,.blm-footer{color:#a4b5c2}.blm-warn{background:#4c3d27;color:#f1c67e}.blm-error{background:#4d2d2d;color:#f2b3ac}.blm-dialog a{color:#8ac6e5}}
  @media(max-width:560px){.blm-shade{padding:10px}.blm-dialog{padding:18px}.blm-grid{grid-template-columns:1fr 1fr}}
  `;

  function makeController(connection) {
    let value = { configured: false, coupons: [], selectedNo: '', fetchedAt: null, stale: false, error: null, loading: true };
    let nextRequest = 0;
    let accepted = 0;
    const listeners = new Set();
    const active = new Set();
    let stopped = false;
    function publish(next) { value = next; for (const f of listeners) f(); }
    async function call(method, payload) {
      const request = ++nextRequest;
      const abort = new AbortController();
      active.add(abort);
      try {
        const result = await connection.rpc.call('/api', `bailian-monitor/${method}`, payload, abort.signal);
        if (stopped || request < accepted) return false;
        accepted = request;
        if (!result.ok) throw new Error(result.error.message);
        publish({ ...result.value, loading: false });
        return true;
      } catch {
        if (!stopped && request >= accepted) {
          accepted = request;
          publish({ ...value, loading: false, stale: true, error: { message: '无法读取百炼数据，请检查插件状态和本地连接后重试。' } });
        }
        return false;
      } finally { active.delete(abort); }
    }
    return {
      subscribe(f) { listeners.add(f); return () => listeners.delete(f); },
      getSnapshot: () => value,
      call,
      stop() { stopped = true; for (const a of active) a.abort(); listeners.clear(); },
    };
  }

  function Setup({ controller, configured, onSaved }) {
    const [id, setId] = React.useState('');
    const [secret, setSecret] = React.useState('');
    const [token, setToken] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    async function save(event) {
      event.preventDefault();
      if (busy) return;
      setBusy(true); setError('');
      const ok = await controller.call('configure', { accessKeyId: id, accessKeySecret: secret, securityToken: token });
      setBusy(false);
      if (ok) { setId(''); setSecret(''); setToken(''); onSaved(); }
      else setError('保存失败，请检查填写内容和本地凭证存储。');
    }
    return h('form', { className: 'blm-form', onSubmit: save },
      h('div', { className: 'blm-note' }, '为阿里云 RAM 用户授予只读权限 bss:DescribeCoupons，再填写它的 AccessKey。百炼 sk- 开头的模型 API Key 不适用于此处。'),
      h('p', { className: 'blm-muted' }, h('a', { href: 'https://ram.console.aliyun.com/users', target: '_blank', rel: 'noreferrer' }, '打开 RAM 用户管理'), ' · ', h('a', { href: 'https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-querycashcoupons', target: '_blank', rel: 'noreferrer' }, '查看接口与权限说明')),
      h('label', null, 'AccessKey ID', h('input', { required: true, value: id, autoComplete: 'off', spellCheck: false, onChange: e => setId(e.target.value), placeholder: 'LTAI…' })),
      h('label', null, 'AccessKey Secret', h('input', { type: 'password', required: true, value: secret, autoComplete: 'new-password', onChange: e => setSecret(e.target.value) })),
      h('label', null, 'Security Token（使用 STS 临时凭证时填写）', h('input', { type: 'password', value: token, autoComplete: 'new-password', onChange: e => setToken(e.target.value) })),
      h('div', { className: 'blm-row' },
        h('button', { className: 'blm-btn primary', type: 'submit', disabled: busy }, busy ? '保存并查询…' : '保存并查询'),
        configured && h('button', { className: 'blm-btn', type: 'button', disabled: busy, onClick: async () => {
          setBusy(true);
          const ok = await controller.call('disconnect', {});
          setBusy(false);
          if (ok) { setId(''); setSecret(''); setToken(''); onSaved(); }
        } }, '移除插件凭证')),
      error && h('p', { className: 'blm-note blm-error', role: 'alert' }, error),
      h('p', { className: 'blm-muted' }, '凭证保存在 DSH 本地凭证库。仅由本机向阿里云账单接口发送签名请求，不会写入对话或返回到用量面板。'));
  }

  function Panel({ state, controller, usage, onClose }) {
    const [settings, setSettings] = React.useState(!state.configured);
    const [busy, setBusy] = React.useState(false);
    const ref = React.useRef();
    React.useEffect(() => {
      const previous = document.activeElement;
      ref.current?.focus();
      function key(event) {
        if (event.key === 'Escape') { event.preventDefault(); onClose(); }
        if (event.key === 'Tab') {
          const items = [...ref.current.querySelectorAll('button:not(:disabled),a[href],input,select,[tabindex="0"]')];
          const first = items[0], last = items.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first?.focus(); }
        }
      }
      const node = ref.current;
      node.addEventListener('keydown', key);
      return () => { node.removeEventListener('keydown', key); previous?.focus?.(); };
    }, []);
    const coupon = state.coupons.find(c => c.no === state.selectedNo);
    const percent = coupon?.nominalValue > 0 && coupon.balance !== null ? Math.max(0, Math.min(100, coupon.balance / coupon.nominalValue * 100)) : null;
    const expired = coupon?.expiryTime && Date.parse(coupon.expiryTime) <= Date.now();
    const low = coupon?.active && coupon.balance !== null && coupon.nominalValue > 0 && coupon.balance / coupon.nominalValue <= .1;
    const expiring = coupon?.daysLeft !== null && coupon?.daysLeft > 0 && coupon?.daysLeft <= 7;
    const knownUsage = usage && ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].every(k => Number.isFinite(usage[k]) && usage[k] >= 0);
    const input = knownUsage ? usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : null;
    const stats = knownUsage ? [
      ['输入 Token', input], ['输出 Token', usage.outputTokens], ['合计 Token', input + usage.outputTokens],
      ['缓存命中 Token', usage.cacheReadTokens], ['未缓存输入', usage.uncachedInputTokens], ['缓存写入 Token', usage.cacheWriteTokens],
    ] : [];
    return createPortal(h('div', { className: 'blm-shade', onMouseDown: e => { if (e.target === e.currentTarget) onClose(); } },
      h('section', { className: 'blm-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'blm-title', tabIndex: -1, ref },
        h('div', { className: 'blm-head' }, h('div', null, h('h2', { id: 'blm-title' }, '百炼用量与代金券'), h('small', null, 'Alibaba Cloud · DSH')), h('button', { className: 'blm-close', type: 'button', 'aria-label': '关闭百炼面板', onClick: onClose }, '×')),
        state.error && h('p', { className: 'blm-note blm-error', role: 'alert' }, state.error.message, state.error.code ? `（${state.error.code}）` : '', state.error.requestId ? ` · RequestId ${state.error.requestId}` : ''),
        !state.configured && !state.loading && h('p', { className: 'blm-note' }, '首次使用，请配置阿里云只读凭证，然后选择要监控的代金券。'),
        state.loading && h('p', { className: 'blm-muted' }, '正在读取…'),
        state.configured && h('div', null,
          h('label', { style: { marginTop: 18 } }, '监控的代金券', h('select', { value: coupon ? state.selectedNo : '', disabled: busy, onChange: async e => {
            if (!e.target.value) return;
            setBusy(true); await controller.call('configure', { selectedNo: e.target.value }); setBusy(false);
          } }, h('option', { value: '' }, '请选择你的 300 元代金券'), state.coupons.map(c => h('option', { key: c.no, value: c.no }, `${c.description || c.products || '代金券'} · 面额 ${money(c.nominalValue)} · 余 ${money(c.balance)} · ${c.no}`)))),
          !state.error && state.fetchedAt && state.coupons.length === 0 && h('p', { className: 'blm-note' }, '接口未返回代金券，请核对所属账号及券类型。'),
          state.selectedNo && !coupon && state.fetchedAt && h('p', { className: 'blm-note blm-warn' }, '当前查询结果中没有之前选择的券，请重新选择。'),
          coupon && h('div', null,
            h('div', { className: 'blm-balance' }, h('span', { className: 'blm-muted' }, state.stale ? '上次查询到的券余额（数据已过时）' : '阿里云返回的券余额'), h('strong', null, money(coupon.balance)), h('span', { className: 'blm-muted' }, `面额 ${money(coupon.nominalValue)} · ${coupon.status}`)),
            percent !== null && h('div', { className: 'blm-meter', role: 'meter', 'aria-label': '券余额比例', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: { width: `${percent}%` } })),
            (expired || !coupon.active) && h('p', { className: 'blm-note blm-warn' }, '该券当前不可用或有效期信息不完整。请结合券状态、生效时间及适用条件核对。'),
            low && h('p', { className: 'blm-note blm-warn' }, '代金券余额已低于或等于面额的 10%。'),
            expiring && h('p', { className: 'blm-note blm-warn' }, `代金券将在约 ${coupon.daysLeft} 天内到期。`),
            h('div', { className: 'blm-meta' }, h('p', null, `生效：${date(coupon.effectiveTime)}`), h('p', null, `到期：${date(coupon.expiryTime)}`), h('p', null, `适用产品：${coupon.products || '请在控制台确认'}`), h('p', null, `适用场景：${coupon.scenarios || '请在控制台确认'}`))),
          h('div', { className: 'blm-row between' }, h('span', { className: 'blm-muted' }, `更新：${state.fetchedAt ? date(state.fetchedAt) : '尚未成功查询'}`), h('button', { className: 'blm-btn', type: 'button', disabled: busy, onClick: async () => { setBusy(true); await controller.call('status', { force: true }); setBusy(false); } }, busy ? '查询中…' : '刷新余额'))),
        h('div', { className: 'blm-block' }, h('h3', null, '当前会话 Token 用量'),
          knownUsage ? h('div', { className: 'blm-grid' }, stats.map(([label, n]) => h('div', { className: 'blm-stat', key: label }, h('strong', null, count(n)), h('span', null, label)))) : h('p', { className: 'blm-muted' }, '当前会话尚无用量数据。'),
          knownUsage && h('p', { className: 'blm-muted' }, `输入缓存命中率：${input > 0 ? (usage.cacheReadTokens / input * 100).toFixed(1) + '%' : '—'}`),
          h('p', { className: 'blm-muted' }, '读取 DSH 当前会话的全部模型用量。切换过提供商时会合并统计；不代表百炼账号全部用量，也不用于推算券余额。')),
        h('div', { className: 'blm-block' }, h('div', { className: 'blm-row between' }, h('h3', null, '阿里云查询凭证'), h('button', { className: 'blm-btn', type: 'button', onClick: () => setSettings(!settings), 'aria-expanded': settings }, settings ? '收起设置' : '设置')), settings && h(Setup, { controller, configured: state.configured, onSaved: () => setSettings(false) })),
        h('p', { className: 'blm-footer' }, '余额约每分钟刷新；阿里云出账、券抵扣可能延迟。券余额与现金余额分别计算，是否可抵扣仍以券适用规则及阿里云账单为准。插件不会在额度耗尽时自动停止模型调用。'))), document.body);
  }

  function Control({ controller, usage }) {
    const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const [open, setOpen] = React.useState(false);
    const coupon = state.coupons.find(c => c.no === state.selectedNo);
    const expired = coupon?.expiryTime && Date.parse(coupon.expiryTime) <= Date.now();
    const warn = Boolean(state.stale || expired || (coupon && (!coupon.active || (coupon.nominalValue > 0 && coupon.balance !== null && coupon.balance / coupon.nominalValue <= .1) || (coupon.daysLeft !== null && coupon.daysLeft <= 7))));
    const label = coupon ? `百炼 ${money(coupon.balance)}${state.stale ? ' · 旧数据' : expired ? ' · 已到期' : !coupon.active ? ' · 不可用' : ''}` : '百炼用量';
    return h(React.Fragment, null,
      h('button', { className: 'blm-trigger', type: 'button', onClick: () => setOpen(true), 'data-warn': String(warn), 'aria-label': '打开百炼用量与代金券', title: label, 'aria-haspopup': 'dialog' }, label),
      open && h(Panel, { state, controller, usage, onClose: () => setOpen(false) }));
  }

  function HeaderControl({ controller, useProjection }) {
    const usage = useProjection('tokenUsage');
    return h(Control, { controller, usage });
  }

  function apply(ctx) {
    const controller = makeController(ctx.connection);
    ctx.effect(() => {
      const style = document.createElement('style');
      style.dataset.owner = 'dsh-bailian-monitor'; style.textContent = STYLE; document.head.appendChild(style);
      void controller.call('status', {});
      const timer = setInterval(() => { void controller.call('status', {}); }, 15000);
      return () => { clearInterval(timer); controller.stop(); style.remove(); };
    }, 'bailian-monitor: data and styles');
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
      name: 'conversation.session.header.utilities', id: 'bailian-monitor', order: -15,
      inject: () => ({ controller }),
    }, HeaderControl));
  }
  return { name: 'bailian-monitor-ui', inject: ['slots', 'connection'], apply };
} });
