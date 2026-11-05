'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { randomBytes } = require('crypto');

// Resolve a listening IPv4 endpoint to its owning process before sending audio.
// Fail closed if native ownership cannot be checked; a responsive foreign local
// service must never be treated as this application's Whisper instance.
let tcpTable = null;
try {
  tcpTable = require('koffi').load('iphlpapi.dll').func(
    'uint32_t GetExtendedTcpTable(void *table, _Inout_ uint32_t *size, int sorted, uint32_t family, uint32_t kind, uint32_t reserved)');
} catch (_) {}
function listenerOwner(port) {
  if (!tcpTable) return null;
  try {
    let capacity = 65536;
    for (let attempt = 0; attempt < 3; attempt++) {
      const buffer = Buffer.alloc(capacity), size = [capacity];
      const status = tcpTable(buffer, size, 0, 2, 3, 0); // AF_INET / OWNER_PID_LISTENER
      if (status === 122 && size[0] > capacity && size[0] <= 8 * 1024 * 1024) { capacity = size[0]; continue; }
      if (status !== 0 || size[0] < 4) return null;
      const count = buffer.readUInt32LE(0);
      if (count > Math.floor((buffer.length - 4) / 24)) return null;
      for (let row = 0; row < count; row++) {
        const offset = 4 + row * 24;
        if (buffer.readUInt32LE(offset) === 2 && buffer.readUInt16BE(offset + 8) === port &&
            buffer.readUInt32BE(offset + 4) === 0x7f000001) return buffer.readUInt32LE(offset + 20);
      }
    }
  } catch (_) {}
  return null;
}
function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function createManagedAsr({ executable, model, threads, log = () => {}, notify = () => {} }) {
  let child = null, endpoint = null, startPromise = null, disposed = false, generation = 0;
  let restartCount = 0, restartTimer = null, lastError = '本机语音服务正在启动，请稍候';
  let queue = Promise.resolve();
  const requests = new Set();
  const alive = process => !!process && Number.isInteger(process.pid) && !process.killed && process.exitCode === null && process.signalCode === null;
  function localJSON(current, suffix, { method = 'GET', body = null, headers = {}, timeout = 1200 } = {}) {
    return new Promise((resolve, reject) => {
      let complete = false, responseBytes = 0, chunks = [];
      // An explicit connection factory bypasses all proxy/PAC/environment
      // configuration for private audio. Cloud requests use Electron separately.
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => net.createConnection({ host: '127.0.0.1', port: current.port });
      const finish = (error, value) => {
        if (complete) return; complete = true; requests.delete(request); agent.destroy();
        if (error) reject(error); else resolve(value);
      };
      const request = http.request({ hostname: '127.0.0.1', port: current.port,
        path: current.prefix + suffix, method, headers, agent }, response => {
        response.on('data', data => {
          responseBytes += data.length;
          if (responseBytes > 2 * 1024 * 1024) { request.destroy(new Error('本机识别返回内容过大')); return; }
          chunks.push(data);
        });
        response.once('error', error => finish(error));
        response.once('end', () => {
          try { finish(null, { ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch (_) { finish(new Error('本机识别服务返回格式异常')); }
        });
      });
      requests.add(request);
      request.setTimeout(timeout, () => request.destroy(new Error('本机识别等待超时，请重说')));
      request.once('error', error => finish(error));
      if (disposed) request.destroy(new Error('软件正在退出')); else request.end(body);
    });
  }

  async function start() {
    if (disposed || alive(child)) return;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      if (!fs.existsSync(executable) || !fs.existsSync(model)) {
        lastError = '本机语音资源缺失，请重新安装提供者给你的完整安装包';
        log('ASR_MISSING'); notify(lastError); return;
      }
      const port = await allocatePort();
      if (disposed) return;
      const serial = ++generation;
      const prefix = '/ppt-ai-' + randomBytes(16).toString('hex');
      // Relative ASCII model argument avoids a narrow-argv path conversion in
      // the upstream Windows executable. The working directory is Unicode-safe.
      const proc = spawn(executable, ['-m', path.relative(path.dirname(executable), model), '-l', 'zh', '-t', String(threads),
        '--host', '127.0.0.1', '--port', String(port), '--request-path', prefix, '-nt', '-ng'],
      { cwd: path.dirname(executable), windowsHide: true, shell: false });
      child = proc; endpoint = { port, prefix, serial, process: proc };
      log('ASR_START pid=' + (proc.pid || 0));
      proc.stdout.on('data', data => log('ASR_OUT bytes=' + data.length));
      proc.stderr.on('data', data => log('ASR_ERR bytes=' + data.length));
      proc.once('error', () => { lastError = '本机语音服务无法启动，请重新安装完整安装包及其运行库'; log('ASR_START_ERR'); notify(lastError); });
      proc.once('close', (code, signal) => {
        if (child !== proc) return;
        child = null; endpoint = null;
        log('ASR_EXIT code=' + String(code) + ' signal=' + String(signal || 'none'));
        if (disposed) return;
        lastError = '本机语音服务已退出，正在尝试恢复；持续失败请重新安装完整安装包'; notify(lastError);
        if (restartCount < 2) {
          restartCount++;
          restartTimer = setTimeout(() => { restartTimer = null; start().catch(() => { log('ASR_RESTART_ERR'); }); }, restartCount * 1500);
        } else { lastError = '本机语音服务连续启动失败，请退出后重启软件，或重新安装完整安装包'; notify(lastError); }
      });
    })().catch(() => { lastError = '无法准备本机语音服务，请退出后重启软件'; log('ASR_PREPARE_ERR'); notify(lastError); })
      .finally(() => { startPromise = null; });
    return startPromise;
  }
  async function ready(timeout = 30000) {
    if (disposed) throw new Error('软件正在退出');
    if (!alive(child)) await start();
    const started = Date.now();
    while (!disposed && Date.now() - started < timeout) {
      const current = endpoint;
      if (!current || !alive(current.process)) {
        if (!restartTimer && restartCount >= 2) break;
        await pause(250); continue;
      }
      if (listenerOwner(current.port) === current.process.pid) {
        try {
          const response = await localJSON(current, '/health');
          const health = response.ok ? response.data : null;
          if (health?.status === 'ok' && endpoint === current && alive(current.process) && listenerOwner(current.port) === current.process.pid) return current;
        } catch (_) {}
      }
      await pause(300);
    }
    throw new Error(lastError || '本机语音服务未就绪，请稍后重试');
  }
  async function perform(bytes, prompt) {
    const current = await ready();
    if (disposed || endpoint !== current || !alive(current.process) || listenerOwner(current.port) !== current.process.pid) {
      throw new Error('无法确认本机语音服务归属，未发送录音，请重启软件');
    }
    const boundary = 'ppt-ai-' + randomBytes(16).toString('hex');
    const parts = [Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="q.wav"\r\nContent-Type: audio/wav\r\n\r\n'), bytes, Buffer.from('\r\n')];
    // b5454 accepts multipart prompt as UTF-8; do not pass Chinese through ANSI argv.
    for (const [name, value] of [['response_format', 'json'], ['temperature', '0'], ['prompt', prompt]]) {
      parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n', 'utf8'));
    }
    parts.push(Buffer.from('--' + boundary + '--\r\n'));
    const body = Buffer.concat(parts);
    const response = await localJSON(current, '/inference', { method: 'POST', body, timeout: 45000,
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length } });
    if (!response.ok) throw new Error('本机识别失败 HTTP ' + response.status);
    if (endpoint !== current || !alive(current.process)) throw new Error('本机识别服务已重新启动，请重说');
    return response.data;
  }
  return { start, recognize(bytes, prompt) {
    const result = queue.then(() => perform(bytes, prompt)); queue = result.catch(() => {}); return result;
  }, dispose() {
    disposed = true; clearTimeout(restartTimer); restartTimer = null;
    for (const request of requests) request.destroy(new Error('软件正在退出'));
    requests.clear();
    const previous = child; child = null; endpoint = null;
    if (previous && alive(previous)) { try { previous.kill(); } catch (_) {} }
  } };
}
module.exports = { createManagedAsr };
