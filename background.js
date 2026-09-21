// ============================================================
// 全局
// ============================================================
const DICT_FILE_START = 1;
const DICT_FILE_END = 608;
const BATCH_SIZE = 20;
const ONLINE_TIMEOUT_MS = 8000;

const DEFAULT_DICT_BASE = 'https://cdn.jsdelivr.net/gh/Esslooooo/gloss@main/dict/';

const ONLINE_SOURCES = {
  youdao: 'https://dict.youdao.com/jsonapi?q=',
  freedict: 'https://api.dictionaryapi.dev/api/v2/entries/en/'
};

console.log('[Gloss BG] background.js 已执行');

// ============================================================
// IndexedDB
// ============================================================
const DB_NAME = 'glossDictDB';
const DB_VERSION = 1;
const STORE_NAME = 'words';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbPutBatch(entries) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const [k, v] of entries) store.put(v, k);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function dbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}


async function dbDestroy() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => { console.log('[Gloss BG] DB 已删除'); resolve(); };
      req.onerror = () => { console.log('[Gloss BG] DB 删除错误'); resolve(); };
      req.onblocked = () => {
        console.log('[Gloss BG] DB 删除被阻止（有活动连接），等待...');
        setTimeout(resolve, 500);
      };
    } catch (e) {
      console.error('[Gloss BG] DB 删除异常:', e);
      resolve();
    }
  });
}

async function dbCount() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

// ============================================================
// 判断词典是否安装
// ============================================================
let dictInstalledCache = null; // null = 未知, true = 已装, false = 未装


(async function initCache() {
  try {
    const r = await chrome.storage.local.get(['_dictInstalled']);
    if (r._dictInstalled === true) {
      dictInstalledCache = true;
      console.log('[Gloss BG] 从 storage 恢复词典状态：已安装');
    } else if (r._dictInstalled === false) {
      dictInstalledCache = false;
    }
  } catch (e) {}
})();

async function isDictInstalled() {
  // 有缓存直接用
  if (dictInstalledCache !== null) return dictInstalledCache;

  try {
    // 探针：查 "the" 是否存在
    const probe = await dbGet('the');
    dictInstalledCache = !!probe;
    console.log('[Gloss BG] 词典探针检查: ' + (dictInstalledCache ? '已安装' : '未安装'));
    return dictInstalledCache;
  } catch (e) {
    dictInstalledCache = false;
    return false;
  }
}

async function getDictRealStatus() {
  try {
    const probe = await dbGet('the');
    const installed = !!probe;
    dictInstalledCache = installed;

    if (!installed) {
      return { installed: false, count: 0 };
    }

    // 词条数从 storage 缓存里读，不扫描
    const r = await chrome.storage.local.get(['_dictCount']);
    return { installed: true, count: r._dictCount || 0 };
  } catch (e) {
    dictInstalledCache = false;
    return { installed: false, count: 0 };
  }
}

// ============================================================
// Offscreen 音频
// ============================================================
let offscreenCreating = null;
async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('不支持 offscreen API');
  try {
    const has = await chrome.offscreen.hasDocument();
    if (has) return;
  } catch (e) {}
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: '播放单词发音音频'
  }).then(() => { offscreenCreating = null; }).catch((err) => { offscreenCreating = null; throw err; });
  return offscreenCreating;
}

async function playAudio(url) {
  await ensureOffscreen();
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'PLAY_AUDIO_OFFSCREEN', url }, (response) => {
      if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
      else resolve(response || { success: false, error: '无响应' });
    });
  });
}

// ============================================================
// 保活
// ============================================================
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dictKeepAlive') console.log('[Gloss BG] 词典下载保活 ping');
});

// ============================================================
// 下载词典
// ============================================================
async function startDictionaryDownload() {
  const r = await chrome.storage.local.get(['_dictStatus']);
  if (r._dictStatus === 'downloading') {
    return { success: true, alreadyRunning: true };
  }

  await chrome.storage.local.set({
    _dictStatus: 'downloading',
    _dictProgress: { current: 0, total: DICT_FILE_END, loaded: 0, startedAt: Date.now() },
    _dictError: null,
    _dictBytes: 0,
    _dictBytesTotal: 0
  });

  chrome.alarms.create('dictKeepAlive', { periodInMinutes: 0.5 });

  runDictionaryDownload().catch(async (err) => {
    console.error('[Gloss BG] 下载任务失败:', err);
    await chrome.storage.local.set({
      _dictStatus: 'failed',
      _dictError: err.message || String(err)
    });
    chrome.alarms.clear('dictKeepAlive');
  });

  return { success: true, started: true };
}

async function runDictionaryDownload() {
  let baseUrl = DEFAULT_DICT_BASE;
  let isLocal = false;

  try {
    const r = await chrome.storage.local.get('_dictBaseUrl');
    if (r._dictBaseUrl && r._dictBaseUrl.trim()) {
      const val = r._dictBaseUrl.trim();
      if (val === 'local' || val.startsWith('local://')) isLocal = true;
      else {
        baseUrl = val;
        if (!baseUrl.endsWith('/')) baseUrl += '/';
      }
    }
  } catch (e) {}

  await dbDestroy();
  dictInstalledCache = null;

  let totalLoaded = 0;
  let failed = 0;
  let totalBytes = 0;
  const startTime = Date.now();

  for (let start = DICT_FILE_START; start <= DICT_FILE_END; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, DICT_FILE_END);
    const promises = [];
    for (let i = start; i <= end; i++) promises.push(downloadOneFile(baseUrl, i, isLocal));
    const results = await Promise.all(promises);

    for (const r of results) {
      if (r.count > 0) totalLoaded += r.count;
      if (!r.ok) failed++;
      totalBytes += r.bytes || 0;
    }

    await chrome.storage.local.set({
      _dictProgress: {
        current: end,
        total: DICT_FILE_END,
        loaded: totalLoaded,
        failed,
        bytes: totalBytes,
        startedAt: startTime
      },
      _dictBytes: totalBytes
    });
  }

  await chrome.storage.local.set({
    _dictStatus: 'installed',
    _dictInstalled: true,
    _dictCount: totalLoaded,
    _dictInstalledAt: Date.now(),
    _dictProgress: null,
    _dictError: null,
    _dictBytes: totalBytes,
    _dictBytesTotal: totalBytes
  });


  dictInstalledCache = totalLoaded > 0;

  chrome.alarms.clear('dictKeepAlive');
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('[Gloss BG] 词典下载完成: ' + totalLoaded + ' 词条, ' + (totalBytes / 1024 / 1024).toFixed(1) + ' MB');
}

async function downloadOneFile(baseUrl, num, isLocal) {
  const fileName = String(num).padStart(4, '0') + '.json';
  try {
    const url = isLocal ? chrome.runtime.getURL('dict/' + fileName) : (baseUrl + fileName);
    const resp = await fetch(url);
    if (!resp.ok) return { ok: false, count: 0, bytes: 0 };

    const text = await resp.text();
    if (!text) return { ok: false, count: 0, bytes: 0 };
    const bytes = text.length;

    const entries = [];
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (!entry || !entry.word) continue;
        const key = entry.word.toLowerCase();
        entries.push([key, entry]);
        if (entry.sw && entry.sw !== key) entries.push([entry.sw, entry]);
      } catch (e) {}
    }

    if (entries.length > 0) await dbPutBatch(entries);
    return { ok: true, count: entries.length, bytes };
  } catch (err) {
    return { ok: false, count: 0, bytes: 0, error: err.message };
  }
}

// ============================================================
// 本地查词
// ============================================================
function parseMultiLine(text) {
  if (!text) return [];
  if (Array.isArray(text)) {
    const out = [];
    for (const item of text) {
      const sub = parseMultiLine(item);
      for (const s of sub) out.push(s);
    }
    return out;
  }
  if (typeof text !== 'string') return [String(text)];
  return text.split('\n').map(s => s.trim()).filter(Boolean);
}

function formatLocalPhonetic(ph) {
  if (!ph || typeof ph !== 'string') return '';
  const parts = ph.split('|').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) return '英 /' + parts[0] + '/  美 /' + parts[1] + '/';
  return parts[0] ? '/' + parts[0] + '/' : '';
}

const POS_REGEX = /^(n\.|v\.|vt\.|vi\.|adj\.|adv\.|prep\.|conj\.|pron\.|int\.|art\.|num\.|aux\.|abbr\.|modal\.|det\.|excl\.|interj\.)\s*/;

function groupDefinitionsByPos(rawLines) {
  const groups = new Map();
  const order = [];
  for (const line of rawLines) {
    if (!line) continue;
    let text = line.trim();
    let pos = '';
    const pm = text.match(POS_REGEX);
    if (pm) { pos = pm[1]; text = text.slice(pm[0].length).trim(); }
    if (!groups.has(pos)) { groups.set(pos, { pos, items: [] }); order.push(pos); }
    const bucket = groups.get(pos).items;
    if (bucket.indexOf(text) === -1) bucket.push(text);
  }
  const result = [];
  for (const key of order) {
    const g = groups.get(key);
    if (g && g.items.length > 0) result.push(g);
  }
  return result;
}

function buildMeaningsFromGroups(groups) {
  return groups.map(g => ({ partOfSpeech: g.pos || '', definitions: [{ definition: g.items.join('；') }] }));
}

async function lookupWordLocal(word) {
  const lower = word.toLowerCase();
  const compressed = lower.replace(/[\s\-_]/g, '');
  let entry = await dbGet(lower) || await dbGet(compressed);

  if (!entry && lower.endsWith('s')) entry = await dbGet(lower.slice(0, -1));
  if (!entry && lower.endsWith('es')) entry = await dbGet(lower.slice(0, -2));
  if (!entry && lower.endsWith('ed')) entry = await dbGet(lower.slice(0, -2));
  if (!entry && lower.endsWith('ing')) entry = await dbGet(lower.slice(0, -3));

  if (!entry) return null;

  let rawLines = parseMultiLine(entry.translation);
  if (rawLines.length === 0) rawLines = parseMultiLine(entry.definition);
  if (rawLines.length === 0) rawLines = ['无释义'];

  const groups = groupDefinitionsByPos(rawLines);
  const meanings = buildMeaningsFromGroups(groups);

  return { word, phonetic: formatLocalPhonetic(entry.phonetic), meanings, examples: [], phrases: [] };
}

// ============================================================
// 有道
// ============================================================
function extractYoudaoPhonetic(json) {
  let uk = '', us = '';
  if (json.ec && Array.isArray(json.ec.word) && json.ec.word[0]) {
    uk = json.ec.word[0].ukphone || '';
    us = json.ec.word[0].usphone || '';
  }
  let p = '';
  if (uk) p += '英 /' + uk + '/';
  if (us) p += (p ? '  ' : '') + '美 /' + us + '/';
  return p;
}

function extractYoudaoRawLines(json) {
  const rawLines = [];
  if (json.ec && Array.isArray(json.ec.word) && json.ec.word[0]) {
    const w = json.ec.word[0];
    if (Array.isArray(w.trs)) {
      for (const t of w.trs) {
        if (t.tr && Array.isArray(t.tr)) {
          for (const tr of t.tr) {
            if (tr.l && tr.l.i !== undefined) {
              const arr = Array.isArray(tr.l.i) ? tr.l.i : [tr.l.i];
              for (const line of arr) if (typeof line === 'string' && line.trim()) rawLines.push(line.trim());
            }
          }
        }
      }
    }
  }
  if (rawLines.length === 0 && json.expand_ec && Array.isArray(json.expand_ec.word) && json.expand_ec.word[0]) {
    const tl = json.expand_ec.word[0].transList;
    if (Array.isArray(tl)) for (const item of tl) {
      const pos = (item.pos || '').trim();
      let trans = '';
      if (item.content && item.content.trans) trans = item.content.trans;
      if (!trans && item.trans) trans = item.trans;
      if (trans) rawLines.push((pos ? pos + ' ' : '') + trans);
    }
  }
  if (rawLines.length === 0 && json.collins && Array.isArray(json.collins.collins_entries)) {
    for (const entry of json.collins.collins_entries) {
      if (entry.entries && entry.entries.entry) {
        for (const e of entry.entries.entry) {
          if (Array.isArray(e.tran_entry)) {
            for (const t of e.tran_entry) {
              const pos = t.pos_entry ? (t.pos_entry.pos || '') : '';
              if (t.tran) rawLines.push((pos ? pos + ' ' : '') + t.tran);
            }
          }
        }
      }
    }
  }
  return rawLines;
}

function extractYoudaoExamples(json) {
  const examples = [];
  if (json.blng_sents_part && Array.isArray(json.blng_sents_part['sentence-pair'])) {
    for (const p of json.blng_sents_part['sentence-pair']) {
      const en = (p.sentence || '').trim();
      const zh = (p['sentence-translation'] || '').trim();
      if (en) examples.push({ en, zh });
      if (examples.length >= 3) break;
    }
  }
  if (examples.length === 0 && json.auth_sents_part && Array.isArray(json.auth_sents_part.sent)) {
    for (const s of json.auth_sents_part.sent) {
      if (s.s) examples.push({ en: s.s, zh: s.t || '' });
      if (examples.length >= 3) break;
    }
  }
  return examples;
}

function extractYoudaoPhrases(json) {
  const phrases = [];
  if (json.phrs && Array.isArray(json.phrs.phrs)) {
    for (const item of json.phrs.phrs) {
      const phr = item.phr;
      if (!phr) continue;
      let hw = '';
      if (phr.headword && phr.headword.l && phr.headword.l.i !== undefined) {
        const arr = Array.isArray(phr.headword.l.i) ? phr.headword.l.i : [phr.headword.l.i];
        hw = arr[0] || '';
      }
      let trans = '';
      if (Array.isArray(phr.trs) && phr.trs[0] && phr.trs[0].tr && phr.trs[0].tr.l && phr.trs[0].tr.l.i !== undefined) {
        const arr = Array.isArray(phr.trs[0].tr.l.i) ? phr.trs[0].tr.l.i : [phr.trs[0].tr.l.i];
        trans = arr[0] || '';
      }
      if (hw && trans) phrases.push({ phrase: hw, translation: trans });
      if (phrases.length >= 8) break;
    }
  }
  return phrases;
}

function extractYoudaoAudio(json, word) {
  if (json.ec && Array.isArray(json.ec.word) && json.ec.word[0]) {
    const item = json.ec.word[0];
    const us = item.usspeech || '';
    if (us) return 'https://dict.youdao.com/dictvoice?audio=' + us;
    const uk = item.ukspeech || '';
    if (uk) return 'https://dict.youdao.com/dictvoice?audio=' + uk;
  }
  return 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(word) + '&type=2';
}

async function lookupWordYoudao(word) {
  const url = ONLINE_SOURCES.youdao + encodeURIComponent(word);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ONLINE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();
    const phonetic = extractYoudaoPhonetic(json);
    const rawLines = extractYoudaoRawLines(json);
    if (rawLines.length === 0) return { notFound: true };
    const groups = groupDefinitionsByPos(rawLines);
    const meanings = buildMeaningsFromGroups(groups);
    const examples = extractYoudaoExamples(json);
    const phrases = extractYoudaoPhrases(json);
    const audio = extractYoudaoAudio(json, word);
    return { data: { word, phonetic, audio, meanings, examples, phrases } };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('有道查词超时');
    throw err;
  }
}

async function lookupWordFreeDict(word) {
  const url = ONLINE_SOURCES.freedict + encodeURIComponent(word);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ONLINE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (resp.status === 404) return { notFound: true };
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) return { notFound: true };
    const entry = data[0];
    const meanings = [];
    let phoneticText = '';
    let audioUrl = '';
    const allExamples = [];
    if (entry.phonetics) for (const p of entry.phonetics) {
      if (p.text && !phoneticText) phoneticText = p.text;
      if (p.audio && !audioUrl) audioUrl = p.audio;
    }
    if (entry.phonetic && !phoneticText) phoneticText = entry.phonetic;
    if (entry.meanings) for (const m of entry.meanings.slice(0, 4)) {
      const defs = [];
      if (m.definitions) for (const d of m.definitions.slice(0, 5)) {
        if (d.definition) defs.push(d.definition);
        if (d.example && allExamples.length < 3) allExamples.push({ en: d.example, zh: '' });
      }
      if (defs.length) meanings.push({ partOfSpeech: m.partOfSpeech || '', definitions: [{ definition: defs.join('；') }] });
    }
    if (meanings.length === 0) return { notFound: true };
    return {
      data: {
        word: entry.word || word,
        phonetic: phoneticText ? '/' + phoneticText + '/' : '',
        audio: audioUrl, meanings, examples: allExamples, phrases: []
      }
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Free Dictionary 查词超时');
    throw err;
  }
}

async function lookupWordOnline(word) {
  let source = 'youdao';
  try {
    const prefs = await chrome.storage.local.get('onlineSource');
    source = prefs.onlineSource || 'youdao';
  } catch (e) {}
  if (source === 'freedict') return await lookupWordFreeDict(word);
  return await lookupWordYoudao(word);
}

// ============================================================
// 统一查询入口
// ============================================================
async function queryByMode(word, mode) {
  const installed = await isDictInstalled(); 

  if (mode === 'online') {
    const r = await lookupWordOnline(word);
    if (r.notFound) return { data: null, error: '在线词典未收录该词' };
    return { data: r.data, source: 'online' };
  }

  if (mode === 'local') {
    if (!installed) return { data: null, error: '本地词典未安装，请前往设置下载' };
    const local = await lookupWordLocal(word);
    if (local) return { data: local, source: 'local' };
    return { data: null, error: '本地词典未收录该词' };
  }

  if (mode === 'online-first') {
    try {
      const r = await lookupWordOnline(word);
      if (!r.notFound) return { data: r.data, source: 'online' };
    } catch (err) {}
    if (installed) {
      const local = await lookupWordLocal(word);
      if (local) return { data: local, source: 'local' };
    }
    return { data: null, error: '在线和本地词典均未收录该词' };
  }

  // auto
  if (installed) {
    const local = await lookupWordLocal(word);
    if (local) return { data: local, source: 'local' };
  }
  try {
    const r = await lookupWordOnline(word);
    if (r.notFound) return { data: null, error: installed ? '本地和在线词典均未收录该词' : '在线词典未收录该词' };
    return { data: r.data, source: 'online' };
  } catch (err) {
    return { data: null, error: '在线查询失败: ' + err.message };
  }
}

// ============================================================
// 句子翻译
// ============================================================
async function translateSentence(text) {
  if (!text || !text.trim()) throw new Error('空文本');
  const cleanText = text.trim().slice(0, 1000);
  try { const r = await translateWithYoudaoAidemo(cleanText); if (r) return r; } catch (e) {}
  try { const r = await translateWithMyMemory(cleanText); if (r) return r; } catch (e) {}
  try { const r = await translateWithYoudaoFanyi(cleanText); if (r) return r; } catch (e) {}
  throw new Error('所有翻译引擎都失败了');
}

async function translateWithYoudaoAidemo(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch('https://aidemo.youdao.com/trans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'q=' + encodeURIComponent(text) + '&from=en&to=zh-CHS',
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const json = await resp.json();
    if (json.errorCode !== '0') return null;
    if (!json.translation || !json.translation[0]) return null;
    return json.translation[0];
  } catch (e) { clearTimeout(timer); return null; }
}

async function translateWithMyMemory(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en|zh-CN';
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const json = await resp.json();
    if (!json.responseData || !json.responseData.translatedText) return null;
    const t = json.responseData.translatedText;
    if (t.indexOf('MYMEMORY WARNING') === 0) return null;
    if (t.indexOf('QUERY LENGTH LIMIT') !== -1) return null;
    return t;
  } catch (e) { clearTimeout(timer); return null; }
}

async function translateWithYoudaoFanyi(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = 'https://fanyi.youdao.com/translate?&doctype=json&type=AUTO&i=' + encodeURIComponent(text);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const json = await resp.json();
    if (json.errorCode !== 0) return null;
    if (!json.translateResult || !json.translateResult[0]) return null;
    return json.translateResult.map(row => row.map(item => item.tgt).join('')).join('\n') || null;
  } catch (e) { clearTimeout(timer); return null; }
}

// ============================================================
// 消息
// ============================================================
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (!message || !message.type) return;

  if (message.type === 'PLAY_AUDIO') {
    (async () => {
      try { sendResponse(await playAudio(message.url)); }
      catch (err) { sendResponse({ success: false, error: err.message }); }
    })();
    return true;
  }

  if (message.type === 'TEST_ONLINE_API') {
    (async () => {
      try {
        const r = await lookupWordOnline('beautiful');
        sendResponse(r.notFound ? { success: false, error: 'API 可访问但未返回数据' } : { success: true });
      } catch (err) { sendResponse({ success: false, error: err.message }); }
    })();
    return true;
  }

  if (message.type === 'TRANSLATE_SENTENCE') {
    (async () => {
      try { sendResponse({ success: true, translation: await translateSentence(message.text) }); }
      catch (err) { sendResponse({ success: false, error: err.message }); }
    })();
    return true;
  }

  if (message.type === 'DICT_STATUS') {
    (async () => {
      try {
        const real = await getDictRealStatus();
        const r = await chrome.storage.local.get(['_dictStatus', '_dictProgress', '_dictError', '_dictBytes', '_dictBytesTotal']);
        if (real.installed && r._dictStatus !== 'installed') {
          await chrome.storage.local.set({
            _dictStatus: 'installed',
            _dictInstalled: true,
            _dictCount: real.count
          });
        }
        if (!real.installed && r._dictStatus === 'installed') {
          await chrome.storage.local.set({
            _dictStatus: 'not_installed',
            _dictInstalled: false,
            _dictCount: 0,
            _dictBytesTotal: 0,
            _dictBytes: 0
          });
        }
        sendResponse({
          installed: real.installed,
          count: real.count,
          status: real.installed ? 'installed' : (r._dictStatus || 'not_installed'),
          progress: r._dictProgress || null,
          error: r._dictError || null,
          bytes: r._dictBytes || 0,
          bytesTotal: r._dictBytesTotal || 0
        });
      } catch (err) {
        sendResponse({ installed: false, count: 0, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'DICT_DOWNLOAD') {
    startDictionaryDownload().then(sendResponse).catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

if (message.type === 'DICT_CLEAR') {
  (async () => {
    try {
      console.log('[Gloss BG] 开始清除词典...');
      await dbDestroy();
      dictInstalledCache = false;
      await chrome.storage.local.set({
        _dictInstalled: false,
        _dictCount: 0,
        _dictInstalledAt: 0,
        _dictStatus: 'not_installed',
        _dictProgress: null,
        _dictError: null,
        _dictBytes: 0,
        _dictBytesTotal: 0
      });
      console.log('[Gloss BG] 词典已清除');
      sendResponse({ success: true });
    } catch (err) {
      console.error('[Gloss BG] 清除失败:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();
  return true;
}

  if (message.type === 'LOOKUP_WORD') {
    (async () => {
      try {
        let mode = 'auto';
        try {
          const prefs = await chrome.storage.local.get('dictSource');
          mode = prefs.dictSource || 'auto';
        } catch (e) {}
        const result = await queryByMode(message.word, mode);
        if (!result.data) { sendResponse({ success: false, error: result.error || '查询失败' }); return; }
        result.data.source = result.source;
        sendResponse({ success: true, data: result.data });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});