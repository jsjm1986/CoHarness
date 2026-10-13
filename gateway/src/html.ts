/** Escape one value before inserting it into Gateway-owned HTML. */
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/** The two languages the gateway-owned gate pages can render. */
export type GatePageLanguage = 'zh' | 'en'

/** Cookie the admin language selector writes so pre-auth pages can follow the same choice. */
export const GATE_LANG_COOKIE = 'hgw_lang'

/**
 * Read the admin display language off a request's Cookie header.
 * @param cookieHeader - the raw Cookie header value.
 * @returns `'en'` when the cookie selects English, else the default `'zh'`.
 */
export function gateLanguage(cookieHeader: string | undefined): GatePageLanguage {
  return (cookieHeader ?? '').split(';').some(part => part.trim() === `${GATE_LANG_COOKIE}=en`) ? 'en' : 'zh'
}

const GATE_COPY = {
  zh: {
    loginTitle: '登录 - COHARNESS', username: '用户名', password: '密码', signIn: '登录',
    passwordTitle: '修改密码 - COHARNESS', passwordHeading: '请设置新密码',
    newPassword: '新密码（至少 8 位）', saveContinue: '保存并继续',
    loginLocked: '尝试过于频繁，请 10 分钟后再试', loginInvalid: '用户名或密码错误',
    passwordTooShort: '密码至少 {min} 位',
    waitingTitle: '正在启动 - COHARNESS', waitingHeading: '正在启动您的工作台…',
    waitingBody: '正在准备工作台服务，页面会自动连接。', waitingProgress: '工作台启动进度',
    waitingHint: '通常需要几秒钟，页面会自动刷新。',
    stoppedTitle: '工作台已停止 - COHARNESS', stoppedHeading: '工作台已手动停止',
    stoppedBody: '后台请求不会自动启动。您可以主动启动并打开工作台。', stoppedStart: '启动并打开',
  },
  en: {
    loginTitle: 'Sign in - COHARNESS', username: 'Username', password: 'Password', signIn: 'Sign in',
    passwordTitle: 'Change password - COHARNESS', passwordHeading: 'Set a new password',
    newPassword: 'New password (at least 8 characters)', saveContinue: 'Save and continue',
    loginLocked: 'Too many attempts; try again in 10 minutes.', loginInvalid: 'Incorrect username or password.',
    passwordTooShort: 'Password must be at least {min} characters.',
    waitingTitle: 'Starting - COHARNESS', waitingHeading: 'Starting your workbench…',
    waitingBody: 'Preparing the workbench service; this page connects automatically.', waitingProgress: 'Workbench startup progress',
    waitingHint: 'This usually takes a few seconds; the page refreshes itself.',
    stoppedTitle: 'Workbench stopped - COHARNESS', stoppedHeading: 'The workbench was stopped manually',
    stoppedBody: 'Background requests will not start it. Start it yourself to open the workbench.', stoppedStart: 'Start and open',
  },
} as const

/**
 * The CoHarness firefly mark inlined for gate pages. Ink rides `currentColor`;
 * wing and face cutouts use the card white; the lamp, halo, and ember dots use
 * the brand accent.
 */
const BRAND_MARK = '<svg viewBox="0 0 64 64" fill="none" aria-hidden="true" width="28" height="28">'
  + '<ellipse cx="20" cy="26" rx="10.5" ry="5.5" fill="#fff" stroke="currentColor" stroke-width="2.6" transform="rotate(-28 20 26)"/>'
  + '<ellipse cx="44" cy="20" rx="10.5" ry="5.5" fill="#fff" stroke="currentColor" stroke-width="2.6" transform="rotate(-36 44 20)"/>'
  + '<path d="M26 14 q-3.5-6-9.5-7.5 M30.5 12.5 q-.5-7-4.5-11" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>'
  + '<circle cx="41" cy="44.5" r="13" fill="#2563eb" opacity=".14"/>'
  + '<circle cx="29" cy="19" r="6.8" fill="currentColor"/>'
  + '<ellipse cx="33.5" cy="30.5" rx="7" ry="10" fill="currentColor" transform="rotate(16 33.5 30.5)"/>'
  + '<ellipse cx="40" cy="44" rx="6.4" ry="7.2" fill="#2563eb" transform="rotate(16 40 44)"/>'
  + '<circle cx="38.5" cy="42.5" r="1.8" fill="#fff" opacity=".8"/>'
  + '<circle cx="52" cy="38.5" r="1.7" fill="#2563eb"/><circle cx="53.5" cy="47" r="1.3" fill="#2563eb"/><circle cx="47" cy="53.5" r="1.5" fill="#2563eb"/>'
  + '<circle cx="26.6" cy="18.5" r="1.5" fill="#fff"/></svg>'

/** The gate-page brand lockup: firefly mark plus the COHARNESS wordmark. */
const BRAND_LOCK = `${BRAND_MARK}<span class="brand-word">COHARNESS</span>`

/** The gate-page dictionary keys; `zh` is the source of truth. */
export type GateCopyKey = keyof (typeof GATE_COPY)['zh']

/**
 * Bind the gate-page dictionary to one language.
 * @param language - the display language to read.
 * @returns a translate seat; `{name}` placeholders interpolate from the parameters.
 */
export function gateCopy(language: GatePageLanguage): (key: GateCopyKey, parameters?: Record<string, string>) => string {
  const dictionary: Record<GateCopyKey, string> = GATE_COPY[language]
  return (key, parameters) => Object.entries(parameters ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), dictionary[key])
}

/**
 * Render the small Gateway-owned document shell.
 * @param title - document title, escaped before insertion
 * @param body - trusted Gateway-owned body markup
 * @param head - trusted Gateway-owned metadata placed inside `head`
 * @param language - the gate-page display language.
 * @returns complete HTML document
 */
export function layout(title: string, body: string, head = '', language: GatePageLanguage = 'zh'): string {
  return `<!doctype html><html lang="${language === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${head}
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#f5f5f7;color:#1d1d1f}
main{max-width:960px;margin:48px auto;padding:0 24px}
.card{background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:24px}
h1{font-size:22px;margin:0 0 16px}h2{font-size:17px;margin:0 0 12px}
input,select{font:inherit;padding:8px 10px;border:1px solid #d2d2d7;border-radius:8px;margin:4px 8px 4px 0}
button{font:inherit;padding:8px 16px;border:0;border-radius:8px;background:#0071e3;color:#fff;cursor:pointer}
button.danger{background:#d70015}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e5e5ea}
.error{color:#d70015;margin:8px 0}.muted{color:#86868b;font-size:13px}
nav a{margin-right:16px;color:#0071e3;text-decoration:none}
.brand{display:flex;align-items:center;gap:10px;margin:0 0 18px;font-size:15px}
.brand svg{display:block}
.brand .brand-word{font-weight:600;letter-spacing:.05em}
.brand.center{justify-content:center}
</style></head><body><main>${body}</main></body></html>`
}

export function loginPage(error = '', language: GatePageLanguage = 'zh'): string {
  const t = gateCopy(language)
  return layout(t('loginTitle'), `<div class="card" style="max-width:380px;margin:80px auto">
<h1 class="brand">${BRAND_LOCK}</h1>
${error === '' ? '' : `<p class="error">${escapeHtml(error)}</p>`}
<form method="post" action="/login">
<p><input name="username" placeholder="${t('username')}" autocomplete="username" required style="width:100%"></p>
<p><input name="password" type="password" placeholder="${t('password')}" autocomplete="current-password" required style="width:100%"></p>
<p><button style="width:100%">${t('signIn')}</button></p>
</form></div>`, '', language)
}

export function passwordPage(error = '', language: GatePageLanguage = 'zh'): string {
  const t = gateCopy(language)
  return layout(t('passwordTitle'), `<div class="card" style="max-width:380px;margin:80px auto">
<div class="brand">${BRAND_LOCK}</div>
<h1>${t('passwordHeading')}</h1>
${error === '' ? '' : `<p class="error">${escapeHtml(error)}</p>`}
<form method="post" action="/account/password">
<p><input name="password" type="password" placeholder="${t('newPassword')}" autocomplete="new-password" required style="width:100%"></p>
<p><button style="width:100%">${t('saveContinue')}</button></p>
</form></div>`, '', language)
}

/** Render the retry page shown while a personal or project runtime starts. */
export function waitingPage(language: GatePageLanguage = 'zh'): string {
  const t = gateCopy(language)
  return layout(t('waitingTitle'), `<div class="card" style="max-width:380px;margin:80px auto;text-align:center">
<div role="status" aria-live="polite" aria-busy="true">
<div class="brand center">${BRAND_LOCK}</div>
<div class="startup-spinner" aria-hidden="true"></div>
<h1>${t('waitingHeading')}</h1>
<p class="muted">${t('waitingBody')}</p>
<div class="startup-progress" role="progressbar" aria-label="${t('waitingProgress')}"><span></span></div>
<p class="muted startup-wait">${t('waitingHint')}</p>
</div></div>`,
  `<meta http-equiv="refresh" content="2"><style>
.startup-spinner{width:28px;height:28px;margin:0 auto 18px;border:3px solid #d2d2d7;border-top-color:#0071e3;border-radius:50%;animation:startup-spin .8s linear infinite}
.startup-progress{height:6px;margin:18px 0 10px;overflow:hidden;border-radius:3px;background:#e5e5ea}
.startup-progress span{display:block;width:38%;height:100%;border-radius:inherit;background:#0071e3;animation:startup-progress 1.4s ease-in-out infinite}
.startup-wait{margin-bottom:0}
@keyframes startup-spin{to{transform:rotate(360deg)}}
@keyframes startup-progress{0%{transform:translateX(-110%)}60%,100%{transform:translateX(290%)}}
@media (prefers-reduced-motion:reduce){.startup-spinner,.startup-progress span{animation-duration:2.4s}}
</style>`, language)
}

/**
 * Render an explicit, same-origin restart action without a polling refresh.
 * @param target - authenticated runtime selected by the Gateway request context.
 * @returns a page whose form is reauthorized when the user submits it.
 */
export function stoppedPage(target: { kind: 'user' | 'project'; id: number }, language: GatePageLanguage = 'zh'): string {
  const t = gateCopy(language)
  return layout(t('stoppedTitle'), `<div class="card">
<div class="brand">${BRAND_LOCK}</div>
<h1>${t('stoppedHeading')}</h1><p>${t('stoppedBody')}</p>
<form method="post" action="/account/runtime/start">
<input type="hidden" name="kind" value="${target.kind === 'user' ? 'personal' : 'project'}">
${target.kind === 'project' ? `<input type="hidden" name="projectId" value="${escapeHtml(String(target.id))}">` : ''}
<button type="submit">${t('stoppedStart')}</button></form></div>`, '', language)
}
