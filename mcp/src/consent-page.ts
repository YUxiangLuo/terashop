import { createHash } from 'node:crypto';

const scopeLabels: Record<string, string> = {
  'store:read': '读取店铺管理数据',
  'store:write': '修改店铺业务数据',
  'store:payments': '执行支付相关操作',
  'store:privacy': '执行隐私相关操作',
};
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const style = `
*{box-sizing:border-box}body{margin:0;background:#f4f6f5;color:#172a23;font:16px/1.6 system-ui,sans-serif}
main{max-width:620px;margin:48px auto;padding:32px;background:white;border:1px solid #d9e1dc;border-radius:12px}
h1{font-size:26px;margin:8px 0 12px}h2{font-size:18px}p{margin:12px 0}.brand{font-size:13px;letter-spacing:2px;color:#52655b}
dl{background:#f4f6f5;padding:16px;border-radius:8px}dt{font-size:13px;color:#52655b}dd{margin:0 0 12px;overflow-wrap:anywhere}dd:last-child{margin:0}
code{font-size:14px}label{display:block;margin-bottom:8px}input{width:100%;padding:12px;border:1px solid #82978c;border-radius:6px;font:inherit}
button,a{font:inherit}button{padding:11px 18px;border:1px solid #527263;border-radius:6px;background:white;color:#234b38;cursor:pointer}
button.primary{background:#23573f;color:white;border-color:#23573f}button:disabled{opacity:.55;cursor:not-allowed}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}
:focus-visible{outline:3px solid #b5690c;outline-offset:3px}[hidden]{display:none!important}#status{padding:12px 0;min-height:48px}.note{font-size:14px;color:#52655b}a{color:#23573f}
@media(max-width:660px){main{margin:16px;padding:24px}h1{font-size:23px}}
`;

// Static script only: provider-controlled values are escaped HTML, never executable data.
const script = `
(() => {
  const path = location.pathname;
  const key = 'tera-consent:' + path;
  const status = document.getElementById('status');
  const form = document.getElementById('login');
  const approve = document.getElementById('approve');
  const deny = document.getElementById('deny');
  let csrf, busy = false, stopped = false, timer;
  const controls = () => document.querySelectorAll('button, input');
  function message(text) { status.textContent = text; }
  function fail() {
    stopped = true; clearTimeout(timer);
    controls().forEach(el => el.disabled = true);
    try { sessionStorage.removeItem(key); } catch {}
    message('此授权已失效或结果无法确认。请返回 MCP 客户端重新发起连接；不要重复提交批准。');
  }
  async function call(url, options = {}) {
    const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json', ...(csrf ? {'X-CSRF-Token': csrf} : {}), ...options.headers } });
    if (!response.ok) throw new Error('Request rejected');
    return response.json();
  }
  async function start() {
    if (csrf) return;
    const result = await call(path + '/start', {method: 'POST', headers: {'X-Tera-Login': 'start'}});
    csrf = result.csrfToken;
    sessionStorage.setItem(key, csrf);
  }
  async function poll() {
    if (stopped || busy) return;
    try {
      const result = await call('/login/status');
      if (stopped || busy) return;
      if (result.status === 'authenticated') {
        form.hidden = true; approve.hidden = false;
        message('邮箱验证已完成。请核对上述权限，再决定是否批准。');
      } else if (result.status === 'pending') {
        approve.hidden = true;
        message('请在同一浏览器中打开登录邮件，然后回到此页。登录不会自动批准授权。');
      } else throw new Error('Already consumed');
      timer = setTimeout(poll, 2000);
    } catch { if (!busy && !stopped) fail(); }
  }
  async function action(work) {
    if (busy || stopped) return;
    busy = true; clearTimeout(timer); controls().forEach(el => el.disabled = true);
    try { await work(); } catch { fail(); }
    finally { busy = false; if (!stopped) controls().forEach(el => el.disabled = false); }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    void action(async () => {
      await start();
      await call('/login/email', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({email: document.getElementById('email').value})});
      form.hidden = true;
      message('如果该邮箱可用于登录，将收到登录邮件。请在五分钟内完成验证。');
      timer = setTimeout(poll, 2000);
    });
  });
  function decide(decision) {
    void action(async () => {
      await start();
      message(decision === 'approve' ? '正在提交批准，请勿重复操作…' : '正在拒绝授权…');
      const result = await call(path + (decision === 'approve' ? '/approve' : '/cancel'),
        {method:'POST', headers:{'X-Tera-Consent':decision}});
      const target = new URL(result.redirectTo, location.origin);
      if (target.origin !== location.origin) throw new Error('Invalid resume URL');
      sessionStorage.removeItem(key); stopped = true;
      location.assign(target.href);
    });
  }
  approve.addEventListener('click', () => decide('approve'));
  deny.addEventListener('click', () => decide('deny'));
  try {
    csrf = sessionStorage.getItem(key);
    if (csrf) { form.hidden = true; void poll(); }
  } catch {
    stopped = true; controls().forEach(el => el.disabled = true);
    message('需要允许此标签页使用会话存储。请调整浏览器设置后，从 MCP 客户端重新连接。');
  }
})();
`;

function page(title: string, body: string, interactive = false, status = 200) {
  const hash = (value: string) => `'sha256-${createHash('sha256').update(value).digest('base64')}'`;
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Tera MCP</title><style>${style}</style></head><body><main><div class="brand">TERA / MCP</div><h1>${escape(title)}</h1>${body}${interactive ? '<noscript><p>此页面需要 JavaScript。请启用后从 MCP 客户端重新连接。</p></noscript>' : ''}</main>${interactive ? `<script>${script}</script>` : ''}</body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src ${interactive ? hash(script) : "'none'"}; style-src ${hash(style)}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        Vary: 'Accept',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}

export function consentPage(consent: {
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  offlineAccess: boolean;
}) {
  return page(
    '连接店铺管理',
    `<p>此客户端请求通过 MCP 管理你的店铺。仅在信任它时批准。</p>
    <dl><dt>客户端 ID</dt><dd>${escape(consent.clientId)}</dd><dt>店铺资源</dt><dd>${escape(consent.resource)}</dd><dt>返回地址</dt><dd>${escape(consent.redirectUri)}</dd><dt>请求权限</dt><dd>${consent.scopes.map((scope) => `<code>${escape(scope)}</code> — ${escape(scopeLabels[scope] ?? scope)}`).join('<br>')}</dd></dl>
    ${consent.offlineAccess ? '<p class="note">包含离线访问：客户端可在你离开后刷新访问令牌，直至授权失效或被撤销。</p>' : ''}
    <form id="login"><h2>验证管理员邮箱</h2><label for="email">邮箱地址</label><input id="email" type="email" autocomplete="email" maxlength="254" required><div class="actions"><button class="primary" type="submit">发送登录邮件</button></div></form>
    <p id="status" role="status" aria-live="polite">登录后还需单独批准。请在五分钟内完成。</p>
    <div class="actions"><button id="approve" class="primary" type="button" hidden>批准授权</button><button id="deny" type="button">拒绝授权</button></div>`,
    true,
  );
}

export function loginStatusPage(authenticated: boolean, uid: string) {
  return page(
    authenticated ? '邮箱验证已完成' : '等待邮箱验证',
    `<p>${authenticated ? '尚未批准任何权限。' : '验证尚未完成或未能成功，请检查登录邮件。'}请返回原授权标签页继续。</p><p><a href="/interaction/${escape(uid)}">返回授权页面</a></p><p class="note">如果原标签页已关闭，请从 MCP 客户端重新连接。在新标签页无法恢复批准凭证。</p>`,
  );
}

export function consentErrorPage(status = 403) {
  return page(
    '无法继续授权',
    '<p>此请求已失效、已处理或无法验证。请返回 MCP 客户端重新发起连接。</p><p class="note">若刚刚提交过批准，结果可能无法确认；不要重复提交。</p>',
    false,
    status,
  );
}
