// Drives a throwaway Helium instance over CDP. Uses a temp profile, never the user's.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const EXE = `${process.env.LOCALAPPDATA}\\imput\\Helium\\Application\\chrome.exe`;
const EXT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const OUT = process.argv[2];
const profile = mkdtempSync(join(tmpdir(), 'hts-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`); };

const server = createServer((req, res) => {
  const n = req.url.slice(1) || 'x';
  const color = { a: '#b03030', b: '#2f7d32', c: '#1f5fa8', d: '#7a4fa3' }[n] || '#444';
  res.setHeader('content-type', 'text/html');
  if (n === 'f') return res.end(`<!doctype html><title>Page f</title><iframe srcdoc="<input autofocus>"></iframe>`);
  res.end(`<!doctype html><title>Page ${n}</title><body style="background:${color};color:#fff;font:40px sans-serif"><h1>Page ${n}</h1><a href="/x">link</a>`);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const proc = spawn(EXE, [
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--headless=new', '--no-first-run',
  '--window-size=1280,800', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, 'about:blank',
], { stdio: 'ignore' });

let ws; let id = 0; const pending = new Map();
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject, method });
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });
}
try {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const [port, path] = readFileSync(portFile, 'utf8').split('\n');
  ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
    }
  };
  console.log('browser', (await send('Browser.getVersion')).product);

  let sw;
  for (let i = 0; i < 50 && !sw; i++) {
    const { targetInfos } = await send('Target.getTargets');
    sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('src/background.js'));
    if (!sw) await sleep(100);
  }
  check('extension loads, service worker starts', !!sw, sw?.url);
  if (!sw) throw new Error('no service worker');
  const { sessionId: swS } = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }, swS);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Runtime.enable', {}, swS);
  await send('Runtime.runIfWaitingForDebugger', {}, swS).catch(() => {});
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    ready = await ev(`return typeof chrome !== 'undefined' && !!chrome.commands`).catch(() => false);
    if (!ready) await sleep(100);
  }
  console.log('      chrome API ready:', ready);
  const cmds = await ev(`return chrome.commands.getAll()`);
  for (const c of cmds) console.log(`      command ${c.name}: "${c.shortcut}"`);
  check('all 4 shortcuts registered', cmds.length === 4 && cmds.every((c) => c.shortcut), '');
  const canDispatch = await ev(`return typeof chrome.commands.onCommand.dispatch`);
  console.log('      onCommand.dispatch:', canDispatch);
  const fire = (name) => ev(`chrome.commands.onCommand.dispatch(${JSON.stringify(name)}); return true`);
  const active = () => ev(`const [t]=await chrome.tabs.query({active:true,lastFocusedWindow:true});return t.title`);

  // Open tabs a, b, c, d so that MRU is d, c, b, a. Then discard b.
  const ids = await ev(`
    const out={};
    for (const n of ['a','b','c','d']) {
      const t=await chrome.tabs.create({url:${JSON.stringify(base)}+'/'+n,active:true});
      out[n]=t.id;
      await new Promise(r=>{const f=(id,i)=>{if(id===t.id&&i.status==='complete'){chrome.tabs.onUpdated.removeListener(f);r()}};chrome.tabs.onUpdated.addListener(f)});
      await new Promise(r=>setTimeout(r,700));
    }
    return out;`);
  check('starts on Page d', (await active()) === 'Page d');

  const sess = () => ev(`const s=await chrome.storage.session.get(null);const k=Object.keys(s);return JSON.stringify(k)`);
  console.log('      session keys', await sess());

  // Quick tap goes to previous tab.
  await fire('cycle-next'); await fire('commit'); await sleep(300);
  check('quick tap switches to previous tab', (await active()) === 'Page c', await active());
  await fire('cycle-next'); await fire('commit'); await sleep(300);
  check('second quick tap toggles back', (await active()) === 'Page d', await active());

  // Discarded tab must be excluded. Discard requires it to be inactive.
  const dis = await ev(`const t=await chrome.tabs.discard(${ids.b});return {discarded:t?.discarded,id:t?.id}`);
  check('tab b discarded', dis.discarded === true, JSON.stringify(dis));
  // discard can change the tab id
  await fire('cycle-next'); await sleep(600);
  const { targetInfos } = await send('Target.getTargets');
  const pageD = targetInfos.find((t) => t.type === 'page' && t.url.endsWith('/d'));
  const frames = targetInfos.filter((t) => t.url.includes('switcher.html'));
  console.log('      switcher targets:', frames.map((f) => `${f.type}`).join(',') || 'none');
  const { sessionId: pS } = await send('Target.attachToTarget', { targetId: pageD.targetId, flatten: true });
  await send('Page.enable', {}, pS);
  const shot = await send('Page.captureScreenshot', { format: 'png' }, pS);
  writeFileSync(join(OUT, 'overlay.png'), Buffer.from(shot.data, 'base64'));
  // Session contents, asked as the service worker sees them.
  const stored = await ev(`const s=await chrome.storage.session.get(null);return JSON.stringify(s,(k,v)=>k==='thumbnail'?(v?'[thumb]':null):(typeof v==='string'&&v.length>200?'[long]':v))`);
  console.log('      state', stored.slice(0, 900));
  const titles = [...stored.matchAll(/"title":"(Page [a-z])"/g)].map((m) => m[1]);
  check('held session lists loaded tabs only, MRU order', JSON.stringify(titles) === JSON.stringify(['Page d', 'Page c', 'Page a']), titles.join(', '));
  check('overlay frame exists in page', frames.length > 0);

  // Step and cancel.
  await fire('cycle-next'); await sleep(150);
  const shot2 = await send('Page.captureScreenshot', { format: 'png' }, pS);
  writeFileSync(join(OUT, 'overlay2.png'), Buffer.from(shot2.data, 'base64'));
  await fire('cancel'); await sleep(300);
  check('cancel stays on the same tab', (await active()) === 'Page d', await active());
  const after = (await send('Target.getTargets')).targetInfos.filter((t) => t.url.includes('switcher.html'));
  check('overlay removed after cancel', after.length === 0);

  // Commit with no session is a no-op.
  await fire('commit'); await fire('cancel'); await sleep(150);
  check('commit/cancel with no session do nothing', (await active()) === 'Page d');

  // Real content script keyup path: ctrl-up commits.
  await fire('cycle-next'); await sleep(400);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 }, pS);
  await sleep(400);
  check('Ctrl keyup in page commits to previous tab', (await active()) === 'Page c', await active());
  await ev(`await chrome.tabs.update(${ids.d},{active:true});await new Promise(r=>setTimeout(r,800));`);

  const hasOverlay = async () => (await send('Target.getTargets')).targetInfos.some((t) => t.url.includes('switcher.html'));
  const key = (type, k, vk) => send('Input.dispatchKeyEvent', { type, key: k, code: k === 'Control' ? 'ControlLeft' : k, windowsVirtualKeyCode: vk }, pS);
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, pS);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, pS);
  };
  // Esc in the page cancels.
  await fire('cycle-next'); await sleep(500);
  check('overlay up before Esc', await hasOverlay());
  await key('rawKeyDown', 'Escape', 27); await key('keyUp', 'Escape', 27); await sleep(400);
  check('Esc cancels', !(await hasOverlay()) && (await active()) === 'Page d', await active());
  // Backdrop click cancels.
  await fire('cycle-next'); await sleep(500);
  await click(15, 15); await sleep(400);
  check('backdrop click cancels', !(await hasOverlay()) && (await active()) === 'Page d', await active());
  // Card click switches. Second card in the first row is the previous tab.
  await fire('cycle-next'); await sleep(500);
  const shot3 = await send('Page.captureScreenshot', { format: 'png' }, pS);
  writeFileSync(join(OUT, 'overlay3.png'), Buffer.from(shot3.data, 'base64'));
  await click(628, 270); await sleep(400);
  check('card click switches', !(await hasOverlay()) && (await active()) === 'Page c', await active());
  await ev(`await chrome.tabs.update(${ids.d},{active:true});await new Promise(r=>setTimeout(r,500));`);
  // Orphan overlay, with no session behind it, must clear itself.
  await ev(`await chrome.tabs.sendMessage(${ids.d},{type:'hts:show',sessionId:'orphan'},{frameId:0});`);
  await sleep(600);
  check('overlay with no session clears itself', !(await hasOverlay()));
  // Focus in an about:srcdoc iframe: the fallback content script must see Ctrl release.
  await send('Page.navigate', { url: `${base}/f` }, pS); await sleep(800);
  await send('Runtime.evaluate', { expression: `document.querySelector('iframe').contentWindow.focus()` }, pS);
  await fire('cycle-next'); await sleep(500);
  await key('keyUp', 'Control', 17); await sleep(400);
  check('Ctrl release seen with focus in a srcdoc iframe', (await active()) === 'Page c', await active());
  await ev(`await chrome.tabs.update(${ids.d},{active:true});await new Promise(r=>setTimeout(r,500));`);

  // Thumbnails.
  const thumbs = await ev(`const s=await chrome.storage.session.get(null);return Object.keys(s).filter(k=>/thumb/i.test(k)).length+' keys: '+Object.keys(s).filter(k=>/thumb/i.test(k)).slice(0,6).join(',')`);
  console.log('      thumbs', thumbs);

  // Restricted page: popup fallback.
  await ev(`await chrome.tabs.update(${ids.d},{url:'chrome://version'});await new Promise(r=>setTimeout(r,800));`);
  await fire('cycle-next'); await sleep(900);
  const wins = await ev(`return (await chrome.windows.getAll({populate:true})).map(w=>({type:w.type,url:w.tabs[0]?.url?.replace(/^chrome-extension:\\/\\/[^/]+/,'')}))`);
  console.log('      windows', JSON.stringify(wins));
  check('restricted page opens popup fallback', wins.some((w) => w.type === 'popup' && w.url?.includes('switcher.html')));
  await fire('cancel'); await sleep(400);
  const wins2 = await ev(`return (await chrome.windows.getAll()).map(w=>w.type)`);
  check('popup closes on cancel', !wins2.includes('popup'), wins2.join(','));
} catch (e) {
  fail++; console.log('ERROR', e.message);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  proc.kill(); server.close();
  await sleep(1000);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}
