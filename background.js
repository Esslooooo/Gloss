// ============================================================
// 全局
// ============================================================
const DICT_PART_START = 1;
const DICT_PART_END = 10;
const BATCH_SIZE = 1;
const WRITE_CHUNK = 1000;
const ONLINE_TIMEOUT_MS = 8000;
const STALE_TIMEOUT = 2 * 60 * 1000;

const DEFAULT_DICT_BASE = 'https://fastly.jsdelivr.net/gh/Esslooooo/gloss@main/dict-parts/';

const ONLINE_SOURCES = {
  youdao: 'https://dict.youdao.com/jsonapi?q=',
  freedict: 'https://api.dictionaryapi.dev/api/v2/entries/en/'
};

let downloadCancelled = false;

console.log('[Gloss BG] background.js 已执行');

// ============================================================
// IndexedDB
// ============================================================
const DB_NAME = 'glossDictDB';
const DB_VERSION = 2;
const STORE_NAME = 'words';
const FORM_STORE = 'forms';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      if (!db.objectStoreNames.contains(FORM_STORE)) db.createObjectStore(FORM_STORE);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbPutBatch(entries, storeName) {
  const name = storeName || STORE_NAME;
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readwrite');
      const store = tx.objectStore(name);
      for (const [k, v] of entries) {
        try { store.put(v, k); } catch (e) {}
      }
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
      tx.onabort = () => reject(new Error('事务中止'));
    });
  } finally {
    try { db.close(); } catch (e) {}
  }
}

async function dbGet(key, storeName) {
  const name = storeName || STORE_NAME;
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readonly');
      const store = tx.objectStore(name);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  } finally {
    try { db.close(); } catch (e) {}
  }
}

async function dbDestroy() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      req.onsuccess = () => { console.log('[Gloss BG] DB 已删除'); finish(); };
      req.onerror = () => { console.log('[Gloss BG] DB 删除错误'); finish(); };
      req.onblocked = () => {
        console.log('[Gloss BG] DB 删除被阻止，等待连接释放...');
        let waited = 0;
        const iv = setInterval(() => {
          waited += 100;
          if (waited >= 3000) { clearInterval(iv); finish(); }
        }, 100);
      };
    } catch (e) {
      console.error('[Gloss BG] DB 删除异常:', e);
      resolve();
    }
  });
}

// ============================================================
// 词典状态
// ============================================================
let dictInstalledCache = null;

(async function initCache() {
  try {
    const r = await chrome.storage.local.get(['_dictInstalled']);
    if (r._dictInstalled === true) dictInstalledCache = true;
    else if (r._dictInstalled === false) dictInstalledCache = false;
  } catch (e) {}
})();

async function isDictInstalled() {
  if (dictInstalledCache !== null) return dictInstalledCache;

  try {
    const r = await chrome.storage.local.get(['_dictInstalled']);
    if (r._dictInstalled === true) { dictInstalledCache = true; return true; }
    if (r._dictInstalled === false) { dictInstalledCache = false; return false; }
  } catch (e) {}

  try {
    const probes = ['a', 'i', 'in', 'is', 'to', 'the'];
    for (const p of probes) {
      const hit = await dbGet(p);
      if (hit) { dictInstalledCache = true; return true; }
    }
  } catch (e) {}

  dictInstalledCache = false;
  return false;
}

async function getDictRealStatus() {
  try {
    const r = await chrome.storage.local.get([
      '_dictInstalled', '_dictCount', '_dictStatus', '_dictProgress',
      '_dictError', '_dictBytes', '_dictBytesTotal', '_dictFormCount'
    ]);
    return {
      installed: r._dictInstalled === true,
      count: r._dictCount || 0,
      formCount: r._dictFormCount || 0,
      status: r._dictStatus || (r._dictInstalled ? 'installed' : 'not_installed'),
      progress: r._dictProgress || null,
      error: r._dictError || null,
      bytes: r._dictBytes || 0,
      bytesTotal: r._dictBytesTotal || 0
    };
  } catch (e) {
    return { installed: false, count: 0, formCount: 0, status: 'not_installed', progress: null, error: null, bytes: 0, bytesTotal: 0 };
  }
}

// ============================================================
// Offscreen 音频
// ============================================================
let offscreenCreating = null;
async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('不支持 offscreen API');
  try { if (await chrome.offscreen.hasDocument()) return; } catch (e) {}
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
  if (alarm.name === 'dictKeepAlive') console.log('[Gloss BG] 下载保活 ping');
});

// ============================================================
// 下载
// ============================================================
async function startDictionaryDownload() {
  const r = await chrome.storage.local.get(['_dictStatus', '_dictProgress']);

  if (r._dictStatus === 'downloading') {
    const progress = r._dictProgress || {};
    const startedAt = progress.startedAt || 0;
    const elapsed = Date.now() - startedAt;

    if (elapsed < STALE_TIMEOUT && (progress.current || 0) < DICT_PART_END) {
      console.log('[Gloss BG] 已有下载任务在进行中');
      return { success: true, alreadyRunning: true };
    }
    console.log('[Gloss BG] 检测到僵尸/已完成下载状态，强制重置');
  }

  downloadCancelled = false;

  await chrome.storage.local.set({
    _dictStatus: 'downloading',
    _dictProgress: { current: 0, total: DICT_PART_END, loaded: 0, forms: 0, startedAt: Date.now() },
    _dictError: null,
    _dictBytes: 0,
    _dictBytesTotal: 0,
    _dictInstalled: false,
    _dictCount: 0,
    _dictFormCount: 0
  });

  chrome.alarms.create('dictKeepAlive', { periodInMinutes: 0.5 });

  runDictionaryDownload().catch(async (err) => {
    console.error('[Gloss BG] 下载任务异常:', err);
    await chrome.storage.local.set({
      _dictStatus: 'failed',
      _dictError: err.message || String(err),
      _dictProgress: null
    });
    chrome.alarms.clear('dictKeepAlive');
  });

  return { success: true, started: true };
}

async function cancelDictionaryDownload() {
  console.log('[Gloss BG] 取消下载');
  downloadCancelled = true;
  chrome.alarms.clear('dictKeepAlive');
  await chrome.storage.local.set({
    _dictStatus: 'not_installed',
    _dictProgress: null,
    _dictError: '已取消',
    _dictBytes: 0,
    _dictBytesTotal: 0,
    _dictInstalled: false,
    _dictCount: 0,
    _dictFormCount: 0
  });
  return { success: true };
}

async function runDictionaryDownload() {
  let baseUrl = DEFAULT_DICT_BASE;
  let isLocal = false;

  try {
    const r = await chrome.storage.local.get('_dictBaseUrl');
    if (r._dictBaseUrl && r._dictBaseUrl.trim()) {
      const val = r._dictBaseUrl.trim();
      if (val === 'local' || val.startsWith('local://')) isLocal = true;
      else { baseUrl = val; if (!baseUrl.endsWith('/')) baseUrl += '/'; }
    }
  } catch (e) {}

  console.log('[Gloss BG] 下载模式: ' + (isLocal ? '本地' : 'CDN'));

  await dbDestroy();
  await new Promise(r => setTimeout(r, 300));
  dictInstalledCache = null;

  let totalLoaded = 0;
  let totalForms = 0;
  let failed = 0;
  let totalBytes = 0;
  const startTime = Date.now();

  for (let i = DICT_PART_START; i <= DICT_PART_END; i++) {
    if (downloadCancelled) {
      console.log('[Gloss BG] 下载已取消');
      return;
    }

    const r = await downloadPartFile(baseUrl, i, isLocal);
    if (r.count > 0) totalLoaded += r.count;
    if (r.forms > 0) totalForms += r.forms;
    if (!r.ok) failed++;
    totalBytes += r.bytes || 0;

    await chrome.storage.local.set({
      _dictProgress: {
        current: i,
        total: DICT_PART_END,
        loaded: totalLoaded,
        forms: totalForms,
        failed,
        bytes: totalBytes,
        startedAt: startTime
      },
      _dictBytes: totalBytes,
      _dictFormCount: totalForms
    });
  }

  if (downloadCancelled) {
    console.log('[Gloss BG] 下载已取消');
    return;
  }

  if (totalLoaded === 0) {
    console.warn('[Gloss BG] 全部下载失败，0 词条');
    await chrome.storage.local.set({
      _dictStatus: 'failed',
      _dictError: '所有文件下载失败（CDN 未就绪或网络问题）',
      _dictProgress: null,
      _dictInstalled: false,
      _dictCount: 0,
      _dictFormCount: 0
    });
    chrome.alarms.clear('dictKeepAlive');
    return;
  }

  const verifyHits = await verifyDictWrite();
  console.log('[Gloss BG] 写入验证: ' + verifyHits + ' 个探针命中');

  if (verifyHits === 0) {
    console.warn('[Gloss BG] 下载完成但写入验证失败');
    await chrome.storage.local.set({
      _dictStatus: 'failed',
      _dictError: 'IndexedDB 写入失败',
      _dictProgress: null,
      _dictInstalled: false,
      _dictCount: 0,
      _dictFormCount: 0
    });
    chrome.alarms.clear('dictKeepAlive');
    return;
  }

  await chrome.storage.local.set({
    _dictStatus: 'installed',
    _dictInstalled: true,
    _dictCount: totalLoaded,
    _dictFormCount: totalForms,
    _dictInstalledAt: Date.now(),
    _dictProgress: null,
    _dictError: null,
    _dictBytes: totalBytes,
    _dictBytesTotal: totalBytes
  });

  dictInstalledCache = true;
  chrome.alarms.clear('dictKeepAlive');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('[Gloss BG] 词典下载完成: ' + totalLoaded + ' 词条, ' + totalForms + ' 变形映射, ' + (totalBytes / 1024 / 1024).toFixed(1) + ' MB, 耗时 ' + elapsed + 's');
}

async function verifyDictWrite() {
  const probes = ['a', 'i', 'in', 'is', 'to', 'the', 'and', 'you', 'of', 'that'];
  let hit = 0;
  for (const p of probes) {
    try {
      const r = await dbGet(p);
      if (r) hit++;
    } catch (e) {}
  }
  return hit;
}

function parseExchange(exchange, word) {
  if (!exchange || typeof exchange !== 'string') return [];
  const out = [];
  const parts = exchange.split('/');
  for (const part of parts) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const type = part.slice(0, idx).trim();
    const form = part.slice(idx + 1).trim();
    if (!form) continue;
    if (type === '1') continue;
    const lowForm = form.toLowerCase();
    const lowWord = word.toLowerCase();
    if (lowForm.indexOf(' ') !== -1) continue;
    if (lowForm === lowWord) continue;
    if (type === '0') {
      out.push([lowWord, lowForm]);
    } else {
      out.push([lowForm, lowWord]);
    }
  }
  return out;
}

async function downloadPartFile(baseUrl, partNum, isLocal) {
  const fileName = 'part_' + String(partNum).padStart(2, '0') + '.json';
  try {
    const url = isLocal
      ? chrome.runtime.getURL('dict-parts/' + fileName)
      : (baseUrl + fileName);

    console.log('[Gloss BG] 下载 ' + fileName);
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn('[Gloss BG] ' + fileName + ' HTTP ' + resp.status);
      return { ok: false, count: 0, forms: 0, bytes: 0 };
    }

    const text = await resp.text();
    if (!text) return { ok: false, count: 0, forms: 0, bytes: 0 };
    const bytes = text.length;

    const entries = [];
    const formEntries = [];
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (!entry || !entry.word) continue;
        const lower = entry.word.toLowerCase();
        entries.push([lower, entry]);
        const maps = parseExchange(entry.exchange, lower);
        for (const m of maps) formEntries.push(m);
      } catch (e) {}
    }

    let writeFailures = 0;
    for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
      if (downloadCancelled) break;
      try {
        await dbPutBatch(entries.slice(i, i + WRITE_CHUNK), STORE_NAME);
      } catch (e) {
        writeFailures++;
        console.warn('[Gloss BG] ' + fileName + ' 写入块 ' + i + ' 失败:', e.message);
      }
    }

    for (let i = 0; i < formEntries.length; i += WRITE_CHUNK) {
      if (downloadCancelled) break;
      try {
        await dbPutBatch(formEntries.slice(i, i + WRITE_CHUNK), FORM_STORE);
      } catch (e) {
        console.warn('[Gloss BG] ' + fileName + ' 变形索引写入失败:', e.message);
      }
    }

    console.log('[Gloss BG] ' + fileName + ' 完成: ' + entries.length + ' 词条, ' + formEntries.length + ' 变形映射, 写入失败 ' + writeFailures + ' 块');
    return { ok: true, count: entries.length, forms: formEntries.length, bytes };
  } catch (err) {
    console.warn('[Gloss BG] ' + fileName + ' 失败:', err.message);
    return { ok: false, count: 0, forms: 0, bytes: 0, error: err.message };
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
  return groups.map(g => ({
    partOfSpeech: g.pos || '',
    definitions: [{ definition: g.items.join('；') }]
  }));
}

async function lookupWordLocal(word) {
  const lower = word.toLowerCase();

  let entry = await dbGet(lower, STORE_NAME);
  let lemma = null;

  if (!entry) {
    const mapped = await dbGet(lower, FORM_STORE);
    if (mapped) {
      const base = await dbGet(mapped, STORE_NAME);
      if (base) {
        entry = base;
        lemma = mapped;
      }
    }
  }

  if (!entry) return null;

  let rawLines = parseMultiLine(entry.translation);
  if (rawLines.length === 0) rawLines = parseMultiLine(entry.definition);
  if (rawLines.length === 0) rawLines = ['无释义'];

  const groups = groupDefinitionsByPos(rawLines);
  const meanings = buildMeaningsFromGroups(groups);

  return {
    word,
    lemma: lemma || '',
    phonetic: formatLocalPhonetic(entry.phonetic),
    meanings,
    examples: [],
    phrases: []
  };
}

// ============================================================
// 有道原型提取
// ============================================================
function extractLemmaFromYoudao(json, word) {
  const w = (word || '').toLowerCase();
  const ec = json && json.ec;
  if (!ec || !Array.isArray(ec.word) || !ec.word[0]) return '';

  const proto = ec.word[0].prototype;
  if (!proto || typeof proto !== 'string') return '';

  const base = proto.toLowerCase().trim();
  if (!base || base === w) return '';
  if (base.indexOf(' ') !== -1) return '';
  return base;
}

// ============================================================
// 有道在线查词
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
    const lemma = extractLemmaFromYoudao(json, word);
    const groups = groupDefinitionsByPos(rawLines);
    const meanings = buildMeaningsFromGroups(groups);
    const examples = extractYoudaoExamples(json);
    const phrases = extractYoudaoPhrases(json);
    const audio = extractYoudaoAudio(json, word);
    return { data: { word, lemma, phonetic, audio, meanings, examples, phrases } };
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
      if (defs.length) meanings.push({
        partOfSpeech: m.partOfSpeech || '',
        definitions: [{ definition: defs.join('；') }]
      });
    }
    if (meanings.length === 0) return { notFound: true };
    return {
      data: {
        word: entry.word || word,
        lemma: '',
        phonetic: phoneticText ? '/' + phoneticText + '/' : '',
        audio: audioUrl,
        meanings,
        examples: allExamples,
        phrases: []
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
      try { sendResponse(await getDictRealStatus()); }
      catch (err) { sendResponse({ installed: false, count: 0, formCount: 0, status: 'not_installed', error: err.message }); }
    })();
    return true;
  }

  if (message.type === 'DICT_DOWNLOAD') {
    startDictionaryDownload().then(sendResponse).catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'DICT_CANCEL') {
    cancelDictionaryDownload().then(sendResponse).catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'DICT_CLEAR') {
    (async () => {
      try {
        console.log('[Gloss BG] 开始清除词典...');
        downloadCancelled = true;
        await dbDestroy();
        dictInstalledCache = false;
        await chrome.storage.local.set({
          _dictInstalled: false,
          _dictCount: 0,
          _dictFormCount: 0,
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