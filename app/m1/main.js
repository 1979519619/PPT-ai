const { app, BrowserWindow, ipcMain, screen, globalShortcut, session, desktopCapturer, safeStorage, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');

const ASR_THREADS = Math.min(12, Math.max(4, Math.floor(os.cpus().length * 0.75)));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

const ASR_DIR = app.isPackaged ? path.join(process.resourcesPath, 'asr') : path.resolve(__dirname, '..', 'asr');
const ASR_EXE = path.join(ASR_DIR, 'Release', 'whisper-server.exe');
const ASR_MODEL_FULL = path.join(ASR_DIR, 'ggml-small.bin');
const ASR_MODEL = ASR_MODEL_FULL;
const OUT = app.isPackaged ? path.join(app.getPath('userData'), 'out') : path.join(__dirname, 'out');
const DETECTOR = app.isPackaged ? path.join(process.resourcesPath, 'detector.ps1') : (fs.existsSync(path.join(__dirname, 'detector.ps1')) ? path.join(__dirname, 'detector.ps1') : path.join(__dirname, '..', 'detector.ps1'));
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'm1.log');

function settingsFile() { return path.join(app.getPath('userData'), 'settings.json'); }
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch (e) { return {}; }
}
function saveSettings(obj) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(obj, null, 2), 'utf8');
}
function getApiKey() {
  try {
    const s = loadSettings();
    if (s.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(s.apiKeyEnc, 'base64')).trim();
    }
  } catch (e) { log('KEY_DECRYPT_ERR'); }
  return '';
}

const OpenCC = require('opencc-js');
const t2s = OpenCC.Converter({ from: 'tw', to: 'cn' });

const SYSTEM_PROMPT = '你是课堂助教。只使用简体中文和必要的数学符号；结论先行；默认不超过 150 字，最多 3 条要点；公式用 KaTeX 行内写法 $...$；不要输出颜文字、表情或繁体字；不编造，不确定就直说；不评价学生。';
const ASR_PROMPT = '以下是普通话数理化课堂提问。常见词：二次函数、求根公式、判别式、导数、积分、化学方程式、摩尔、向量、牛顿定律。请只输出简体中文和数学符号，不要输出表情、颜文字或繁体字。';

const ALLOW_CH = /[\u4e00-\u9fffA-Za-z0-9\s，。、；：？！“”‘’（）《》【】—…·+\-*/=<>±×÷≠≈≤≥∞√∫∑πΠΔδθαβγμωΩ°′″%.,:;!?()\[\]{}]/;
const HALLU = /(字幕|点赞|订阅|转发|打赏|明镜|栏目|感谢观看|请不吝|视频|频道|音乐|♪|orz)/i;
const CN_NUM = '一二三四五六七八九';

function cleanAsr(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = t2s(s);
  s = Array.from(s).filter(ch => ALLOW_CH.test(ch)).join('');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/([1-9])(?=次|元|角|边|项|维|倍|分之)/g, (_m, d) => CN_NUM[Number(d) - 1]);
  return s;
}
function cjkCount(s) { return (s.match(/[\u4e00-\u9fff]/g) || []).length; }

let pet = null, panel = null, detector = null, asrProc = null;
let showing = false, lastShowHwnd = 0, currentAbort = null;
let lassoWin = null, pendingImages = [];
let settingsWin = null;
let SetForegroundWindow = null, koffiErr = '';
try {
  const koffi = require('koffi');
  const u32 = koffi.load('user32.dll');
  SetForegroundWindow = u32.func('bool SetForegroundWindow(intptr_t hwnd)');
} catch (e) { koffiErr = e.message; }

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
}

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
});

function makePet() {
  pet = new BrowserWindow({
    width: 96, height: 96, frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, focusable: false, resizable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  pet.setAlwaysOnTop(true, 'screen-saver');
  pet.loadFile(path.join(__dirname, 'pet.html'));
  const d = screen.getPrimaryDisplay();
  pet.setPosition(d.workArea.x + d.workArea.width - 120, d.workArea.y + 40);
  pet.showInactive();
}

function makePanel() {
  panel = new BrowserWindow({
    width: 620, height: 560, frame: false, alwaysOnTop: true, skipTaskbar: true,
    show: false, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  panel.setAlwaysOnTop(true, 'screen-saver');
  panel.loadFile(path.join(__dirname, 'panel.html'));
  const d = screen.getPrimaryDisplay();
  panel.setPosition(d.workArea.x + d.workArea.width - 650, d.workArea.y + 80);
}

function showPanel() {
  panel.show();
  panel.focus();
  setTimeout(() => { if (panel && !panel.isDestroyed()) { panel.focus(); log('PANEL_FOCUS ' + panel.isFocused()); } }, 150);
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.setAlwaysOnTop(true); settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 780, height: 700, title: 'PPT-AI 设置', resizable: false, minimizable: false, maximizable: false,
    autoHideMenuBar: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
  log('SETTINGS open');
}

function focusShow() {  if (!SetForegroundWindow || !lastShowHwnd) { log('FOCUS_SHOW unavailable hwnd=' + lastShowHwnd + ' api=' + (SetForegroundWindow ? 'ok' : 'missing ' + koffiErr)); return false; }
  try { const ok = SetForegroundWindow(lastShowHwnd); log('FOCUS_SHOW ' + lastShowHwnd + ' -> ' + ok); return ok; }
  catch (e) { log('FOCUS_SHOW_ERR ' + e.message); return false; }
}

async function capture(hideSelf = true) {
  const petWas = pet.isVisible(), panelWas = panel.isVisible();
  try {
    if (hideSelf) { if (petWas) pet.hide(); if (panelWas) panel.hide(); await new Promise(r => setTimeout(r, 150)); }
    const d = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) } });
    const src = sources.find(s => String(s.display_id) === String(d.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) throw new Error('Empty screen capture');
    log('CAPTURE memory');
    return src.thumbnail.toDataURL();
  } catch (e) { log('CAPTURE_ERR ' + e.message); return null; }
  finally { if (petWas) pet.showInactive(); if (panelWas) panel.showInactive(); }
}

async function openLasso() {
  if (lassoWin) return;
  log('LASSO open');
  const dataUrl = await capture();
  if (!dataUrl) { log('LASSO capture failed'); return; }
  pendingImages = [];
  if (pet.isVisible()) pet.hide();
  if (panel.isVisible()) panel.hide();
  const d = screen.getPrimaryDisplay();
  lassoWin = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
    frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, show: false,
    movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  lassoWin.setAlwaysOnTop(true, 'screen-saver');
  lassoWin.setMenuBarVisibility(false);
  lassoWin.loadFile(path.join(__dirname, 'lasso.html'));
  lassoWin.once('ready-to-show', () => {
    if (!lassoWin) return;
    lassoWin.setBounds({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height });
    lassoWin.show();
    lassoWin.focus();
    log('LASSO bounds=' + JSON.stringify(lassoWin.getBounds()) + ' content=' + JSON.stringify(lassoWin.getContentBounds()));
    lassoWin.webContents.send('m1:lassoInit', { dataUrl });
  });
  lassoWin.on('closed', () => { lassoWin = null; });
}

function lassoDone(payload) {
  if (!lassoWin) return;
  try {
    if (payload && Array.isArray(payload.images)) {
      pendingImages = payload.images.slice(0, 5).map(x => x.dataUrl).filter(Boolean);
      log('LASSO done count=' + pendingImages.length + ' maxArea=' + payload.areaRatio);
    }
  } catch (e) { log('LASSO_ERR ' + e.message); }
  const w = lassoWin; lassoWin = null; try { w.close(); } catch (e) {}
  if (showing) pet.showInactive();
  if (pendingImages.length) {
    showPanel();
    panel.webContents.send('m1:lasso', { imageDataUrls: pendingImages, areaRatio: payload ? payload.areaRatio : 1 });
  }
}

function lassoCancel() {
  if (!lassoWin) return;
  const w = lassoWin; lassoWin = null; try { w.close(); } catch (e) {}
  if (showing) pet.showInactive();
  log('LASSO cancel');
}

function onState(s) {
  const isShow = !!s.show;
  if (isShow) {
    lastShowHwnd = s.showHwnd;
    if (!showing) { showing = true; log('SHOW pet hwnd=' + s.showHwnd); if (!pet.isVisible() && !lassoWin) pet.showInactive(); }
  } else if (showing && !lassoWin) {
    showing = false; log('HIDE pet'); pet.hide();
  }
  if (s.evt === 'lassoDown' && !lassoWin) { log('LASSO hotkey'); openLasso(); }
  if (s.evt === 'voiceDown' && !lassoWin) {
    log('VOICE_DOWN');
    showPanel();
    panel.webContents.send('m1:rec', true);
  } else if (s.evt === 'voiceUp' && !lassoWin) {
    log('VOICE_UP');
    panel.webContents.send('m1:rec', false);
  }
  if (panel && !panel.isDestroyed()) panel.webContents.send('m1:state', { showing, own: s.pid === process.pid });
}

function startDetector() {
  detector = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DETECTOR]);
  let buf = '';
  detector.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { onState(JSON.parse(line)); } catch (e) {}
    }
  });
  detector.stderr.on('data', d => log('DET_ERR ' + d.toString().trim().slice(0, 200)));
  detector.on('exit', c => log('DET_EXIT ' + c));
}

function startAsr() {
  if (!fs.existsSync(ASR_EXE)) { log('ASR_MISSING exe'); return; }
  if (!fs.existsSync(ASR_MODEL)) { log('ASR_MISSING model'); return; }
  asrProc = spawn(ASR_EXE, ['-m', ASR_MODEL, '-l', 'zh', '-t', String(ASR_THREADS), '--host', '127.0.0.1', '--port', '18080', '-nt', '--prompt', ASR_PROMPT], { cwd: path.dirname(ASR_EXE) });
  log('ASR_MODEL ' + ASR_MODEL + ' sizeMB=' + Math.round(fs.statSync(ASR_MODEL).size / 1048576) + ' threads=' + ASR_THREADS);
  asrProc.stdout.on('data', d => log('ASR_OUT bytes=' + d.length));
  asrProc.stderr.on('data', d => log('ASR_ERR bytes=' + d.length));
  asrProc.on('exit', c => log('ASR_EXIT ' + c));
}

function waitAsr(ms = 10000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const tryOnce = () => {
      const s = net.connect(18080, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - t0 > ms) resolve(false);
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

async function handleAsr(wavB64) {
  if (typeof wavB64 !== 'string' || wavB64.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(wavB64)) {
    return { ok: false, error: '录音格式无效或过大，请缩短录音' };
  }
  try {
    const ready = await waitAsr();
    if (!ready) return { ok: false, error: '识别服务未就绪（模型加载中或启动失败）' };
    const wav = Buffer.from(wavB64, 'base64');
    log('ASR_WAV bytes=' + wav.length);
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'q.wav');
    fd.append('response_format', 'json');
    fd.append('temperature', '0');
    const r = await fetch('http://127.0.0.1:18080/inference', { method: 'POST', body: fd });
    const body = await r.text();
    if (!r.ok) { log('ASR_HTTP ' + r.status); return { ok: false, error: '识别失败 HTTP ' + r.status }; }
    let j = {};
    try { j = JSON.parse(body); } catch (e) {}
    const rawText = String(j.text || '').trim();
    const text = cleanAsr(rawText);
    log('ASR_TEXT len=' + text.length);
    if (HALLU.test(rawText) || HALLU.test(text) || cjkCount(text) < 2) {
      return { ok: false, error: '没听清，请重说' };
    }
    return { ok: true, text };
  } catch (e) {
    log('ASR_EXC ' + e.message);
    return { ok: false, error: '识别异常：' + e.message };
  }
}

async function handleAsk(text, imageDataUrls) {
  if (typeof text !== 'string' && text != null) return { ok: false, error: '问题格式无效' };
  if (String(text || '').length > 2000) return { ok: false, error: '问题请限制在 2000 字以内' };
  if (!Array.isArray(imageDataUrls) || imageDataUrls.length > 5 || imageDataUrls.some(x => typeof x !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(x) || x.length > 12 * 1024 * 1024)) {
    return { ok: false, error: '圈选图片无效、过大或超过 5 张' };
  }
  const cleanText = String(text || '').trim();
  const imgs = (Array.isArray(imageDataUrls) ? imageDataUrls : []).filter(x => /^data:image\//.test(x)).slice(0, 5);
  const key = getApiKey();
  if (!key) { panel.webContents.send('m1:error', '未配置 API Key，请按 Ctrl+Alt+S 在设置中保存'); return { ok: false }; }
  if (currentAbort) currentAbort.abort();
  const ctrl = new AbortController(); currentAbort = ctrl;
  const sender = panel.webContents;
  const prefix = imgs.length > 1 ? `老师圈选了 ${imgs.length} 个区域（图片按顺序给出），请分别回答。` : '';
  const parts = [{ type: 'text', text: (prefix + (cleanText || '请讲解我圈出的内容。')).trim() }];
  for (let i = 0; i < imgs.length; i++) {
    const b64 = imgs[i].split(',')[1] || '';
    if (b64.length > 14 * 1024 * 1024) { sender.send('m1:error', '圈选图片过大，请缩小范围'); return { ok: false }; }
    parts.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64, detail: 'high' } });
  }
  log('DS_IMAGES count=' + imgs.length + ' lens=' + imgs.map(x => x.length).join(','));
  const userContent = parts.length > 1 ? parts : parts[0].text;
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userContent }],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 1024,
        temperature: 0.4,
        thinking: { type: 'disabled' }
      }),
      signal: ctrl.signal
    });
    if (!res.ok) {
      log('DS_HTTP ' + res.status);
      sender.send('m1:error', `请求失败 HTTP ${res.status}，请检查连接、Key 和余额后重试`);
      return { ok: false };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', usage = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const t = j.choices && j.choices[0] && j.choices[0].delta ? j.choices[0].delta.content : null;
          if (t) sender.send('m1:delta', { text: t });
          if (j.usage) usage = j.usage;
        } catch (e) {}
      }
    }
    sender.send('m1:done', { usage });
    log('DS_DONE usage=' + JSON.stringify(usage));
    return { ok: true };
  } catch (e) {
    if (ctrl.signal.aborted) { sender.send('m1:done', { aborted: true }); log('DS_ABORT'); }
    else { sender.send('m1:error', '网络/请求异常：' + e.message); log('DS_ERR ' + e.message); }
    return { ok: false };
  } finally {
    if (currentAbort === ctrl) currentAbort = null;
  }
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media'));
  makePet(); makePanel(); startDetector(); startAsr();
  globalShortcut.register('CommandOrControl+Alt+F', () => focusShow());
  globalShortcut.register('CommandOrControl+Alt+H', () => { log('TOGGLE panel'); panel.isVisible() ? panel.hide() : showPanel(); });
  globalShortcut.register('CommandOrControl+Alt+S', () => openSettings());
  globalShortcut.register('CommandOrControl+Alt+Q', () => { log('QUIT hotkey'); app.quit(); });
  log('M1_READY pid=' + process.pid + ' focusApi=' + (SetForegroundWindow ? 'ok' : 'missing') + ' koffiErr=' + koffiErr);
});

ipcMain.handle('m1:asr', async (_e, b64) => handleAsr(b64));
ipcMain.handle('m1:ask', async (_e, payload) => {
  if (typeof payload === 'string') return handleAsk(payload, []);
  const p = payload || {};
  return handleAsk(p.text, p.imageDataUrls || []);
});
ipcMain.handle('m1:startLasso', async () => { openLasso(); return true; });
ipcMain.handle('m1:openSettings', async () => { openSettings(); return true; });
ipcMain.handle('m1:settingsInfo', async () => {
  const s = loadSettings();
  return {
    hasKey: !!getApiKey(),
    encrypted: !!s.apiKeyEnc,
    model: 'deepseek-flash',
    asrModel: path.basename(ASR_MODEL),
    asrMB: fs.existsSync(ASR_MODEL) ? Math.round(fs.statSync(ASR_MODEL).size / 1048576) : 0,
    asrThreads: ASR_THREADS,
    logsPath: OUT,
    settingsPath: settingsFile(),
    hotkeys: { voice: 'Ctrl+Alt+Space', lasso: 'Ctrl+Alt+X', panel: 'Ctrl+Alt+H', settings: 'Ctrl+Alt+S', quit: 'Ctrl+Alt+Q' }
  };
});
ipcMain.handle('m1:saveKey', async (_e, key) => {
  const k = String(key || '').trim();
  if (k.length < 10 || k.length > 512 || /[\r\n]/.test(k)) return { ok: false, error: 'Key 长度或格式无效' };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: '系统加密不可用，无法安全保存' };
  try {
    const s = loadSettings();
    s.apiKeyEnc = safeStorage.encryptString(k).toString('base64');
    s.keySavedAt = new Date().toISOString();
    saveSettings(s);
    log('KEY saved encrypted');
    return { ok: true };
  } catch (e) { log('KEY_SAVE_ERR ' + e.message); return { ok: false, error: e.message }; }
});
ipcMain.handle('m1:testKey', async (_e, key) => {
  const k = String(key || '').trim() || getApiKey();
  if (!k) return { ok: false, error: '未配置 Key' };
  try {
    const r = await fetch('https://api.deepseek.com/models', { headers: { Authorization: 'Bearer ' + k } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}，请检查 Key、余额和网络连接` };
    const ids = (body.data || []).map(x => x.id);
    log('KEY test ok models=' + ids.join(','));
    return { ok: true, models: ids, hasFlash: ids.includes('deepseek-flash') };
  } catch (e) { return { ok: false, error: '网络异常：' + e.message }; }
});
ipcMain.handle('m1:openLogs', async () => { await shell.openPath(OUT); return true; });
ipcMain.handle('m1:lassoDone', async (_e, payload) => { lassoDone(payload); return true; });
ipcMain.handle('m1:lassoCancel', async () => { lassoCancel(); return true; });
ipcMain.handle('m1:abort', async () => { if (currentAbort) currentAbort.abort(); return true; });
ipcMain.handle('m1:focusShow', async () => focusShow());
ipcMain.handle('m1:focusPanel', async () => { showPanel(); return true; });
ipcMain.handle('m1:hidePanel', async () => { panel.hide(); return true; });
ipcMain.handle('m1:quit', async () => { app.quit(); return true; });

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (detector) detector.kill();
  if (asrProc) asrProc.kill();
  log('M1_QUIT');
});
