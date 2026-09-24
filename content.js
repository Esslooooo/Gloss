let wcxEnabled = true;
let wcxRecordWords = true;
let wcxStoreLemma = true;

async function checkEnabled() {
  if (!isExtensionAlive()) return;
  try {
    const r = await chrome.storage.local.get(['_enabled', '_blacklist']);
    const enabled = r._enabled !== false;
    const blacklist = r._blacklist || [];
    const host = location.hostname || '';
    const inBlacklist = blacklist.some(function(b) {
      return host === b || host.endsWith('.' + b);
    });
    wcxEnabled = enabled && !inBlacklist;
    console.log('[Gloss] 状态:', wcxEnabled ? '启用' : '禁用', '(' + host + ')');
  } catch (e) {
    wcxEnabled = false;
  }
}

async function loadRecordWordsSetting() {
  try {
    const r = await chrome.storage.local.get(['_recordWords', '_storeLemma']);
    wcxRecordWords = r._recordWords !== false;
    wcxStoreLemma = r._storeLemma !== false;
  } catch (e) {}
}

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener(function(changes, area) {
    if (area !== 'local') return;
    if (changes._enabled || changes._blacklist) checkEnabled();
    if (changes._recordWords) {
      wcxRecordWords = changes._recordWords.newValue !== false;
    }
    if (changes._storeLemma) {
      wcxStoreLemma = changes._storeLemma.newValue !== false;
    }
  });
}

function isExtensionAlive() {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

function wakeUpBackground() {
  if (!isExtensionAlive()) return;
  try {
    chrome.runtime.sendMessage({ type: 'WAKE_UP' }, function() {
      if (chrome.runtime.lastError) {}
    });
  } catch (e) {}
}
wakeUpBackground();
checkEnabled();
loadRecordWordsSetting();

console.log('[Gloss] content.js 已加载');

function getSelectedText() {
  const active = document.activeElement;
  if (active) {
    const tag = active.tagName ? active.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') {
      try {
        const start = active.selectionStart;
        const end = active.selectionEnd;
        if (typeof start === 'number' && typeof end === 'number' && start !== end) {
          return active.value.substring(start, end).trim();
        }
      } catch (e) {}
    }
  }
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const t = sel.toString().trim();
    if (t) return t;
  }
  return '';
}

function getSelectionRect() {
  const active = document.activeElement;
  if (active) {
    const tag = active.tagName ? active.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') {
      try {
        if (active.selectionStart !== active.selectionEnd) {
          return active.getBoundingClientRect();
        }
      } catch (e) {}
    }
    if (active.isContentEditable) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        try {
          const r = sel.getRangeAt(0).getBoundingClientRect();
          if (r.width > 0 || r.height > 0) return r;
        } catch (e) {}
      }
      return active.getBoundingClientRect();
    }
  }
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    try {
      return sel.getRangeAt(0).getBoundingClientRect();
    } catch (e) {}
  }
  return null;
}

function captureAnchorForSelection() {
  const active = document.activeElement;
  if (active) {
    const tag = active.tagName ? active.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') {
      return { element: active, isElement: true };
    }
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  try {
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node && node.nodeType === Node.TEXT_NODE) {
      return { node: node, offset: range.startOffset, length: range.endOffset - range.startOffset };
    }
  } catch (e) {}
  return null;
}

let wcxPopup = null;
let wcxSentencePopup = null;
let wcxWord = '';
let wcxClickTimer = null;
let wcxAnchor = null;
let wcxPoller = null;
let wcxMouseDownPos = null;

function purgeAllOldPopups() {
  document.querySelectorAll('.wcx-popup').forEach(el => el.remove());
  document.querySelectorAll('.wcx-sentence-popup').forEach(el => el.remove());
  wcxPopup = null;
  wcxSentencePopup = null;
}
purgeAllOldPopups();

function wcxRemovePopup() {
  if (wcxPopup && wcxPopup.parentNode) wcxPopup.remove();
  if (wcxSentencePopup && wcxSentencePopup.parentNode) wcxSentencePopup.remove();
  wcxPopup = null;
  wcxSentencePopup = null;
  wcxAnchor = null;
  document.removeEventListener('mousedown', wcxHandleOutsideClick, true);
  document.removeEventListener('scroll', wcxHandleScroll, true);
  stopPoller();
}

function wcxHandleOutsideClick(e) {
  const hasAny = wcxPopup || wcxSentencePopup;
  if (!hasAny) return;
  if (wcxPopup && wcxPopup.contains(e.target)) return;
  if (wcxSentencePopup && wcxSentencePopup.contains(e.target)) return;
  wcxRemovePopup();
}

function wcxHandleScroll(e) {
  const el = wcxPopup || wcxSentencePopup;
  if (!el || !wcxAnchor) return;

  if (e && e.target && e.target.nodeType === 1) {
    if (wcxPopup && wcxPopup.contains(e.target)) return;
    if (wcxSentencePopup && wcxSentencePopup.contains(e.target)) return;
  }

  const rect = getAnchorRect();
  if (!rect) return;

  if (rect.bottom < -50 || rect.top > window.innerHeight + 50) {
    wcxRemovePopup();
    return;
  }

  wcxUpdatePosition(rect, el);
}

function getAnchorRect() {
  if (!wcxAnchor) return null;

  if (wcxAnchor.isElement && wcxAnchor.element) {
    try {
      return wcxAnchor.element.getBoundingClientRect();
    } catch (e) {
      return null;
    }
  }

  if (!wcxAnchor.node || !wcxAnchor.node.parentNode) return null;
  try {
    const r = document.createRange();
    const len = Math.max(wcxAnchor.length, 1);
    const end = Math.min(wcxAnchor.offset + len, wcxAnchor.node.textContent.length);
    r.setStart(wcxAnchor.node, wcxAnchor.offset);
    r.setEnd(wcxAnchor.node, end);
    return r.getBoundingClientRect();
  } catch (e) {
    return null;
  }
}

function wcxUpdatePosition(rect, el) {
  if (!el || !rect) return;

  const w = 340;
  const h = 260;
  const gap = 8;
  const edge = 10;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const spaceRight = vw - rect.right - edge;
  const spaceLeft = rect.left - edge;
  const spaceBelow = vh - rect.bottom - edge;
  const spaceAbove = rect.top - edge;

  let mode;

  if (spaceRight >= w + gap) mode = 'right';
  else if (spaceLeft >= w + gap) mode = 'left';
  else if (spaceBelow >= h + gap) mode = 'below';
  else if (spaceAbove >= h + gap) mode = 'above';
  else {
    const maxH = Math.max(spaceRight, spaceLeft);
    const maxV = Math.max(spaceBelow, spaceAbove);
    if (maxH >= maxV) mode = spaceRight >= spaceLeft ? 'right' : 'left';
    else mode = spaceBelow >= spaceAbove ? 'below' : 'above';
  }

  el.style.left = '';
  el.style.right = '';
  el.style.top = '';
  el.style.bottom = '';

  if (mode === 'right') {
    el.style.left = (rect.right + gap) + 'px';
    el.style.top = Math.max(edge, Math.min(vh - h - edge, rect.top)) + 'px';
  } else if (mode === 'left') {
    el.style.right = (vw - rect.left + gap) + 'px';
    el.style.top = Math.max(edge, Math.min(vh - h - edge, rect.top)) + 'px';
  } else if (mode === 'below') {
    el.style.left = Math.max(edge, Math.min(vw - w - edge, rect.left)) + 'px';
    el.style.top = (rect.bottom + gap) + 'px';
  } else {
    el.style.left = Math.max(edge, Math.min(vw - w - edge, rect.left)) + 'px';
    el.style.top = Math.max(edge, rect.top - h - gap) + 'px';
  }
}

function startPoller() {
  stopPoller();
  wcxPoller = setInterval(async () => {
    if (!wcxPopup && !wcxSentencePopup) { stopPoller(); return; }
    if (!isExtensionAlive()) { stopPoller(); return; }
    try {
      const r = await chrome.storage.local.get('_popupOpenedAt');
      if (r._popupOpenedAt && Date.now() - r._popupOpenedAt < 1000) wcxRemovePopup();
    } catch (e) {}
  }, 250);
}

function stopPoller() {
  if (wcxPoller) {
    clearInterval(wcxPoller);
    wcxPoller = null;
  }
}

function showRefreshHint(rect) {
  if (wcxPopup && wcxPopup.parentNode) wcxPopup.remove();
  if (wcxSentencePopup && wcxSentencePopup.parentNode) wcxSentencePopup.remove();
  wcxPopup = null;
  wcxSentencePopup = null;

  const el = document.createElement('div');
  el.className = 'wcx-popup';
  el.innerHTML = '<div class="wcx-header"><strong>Gloss 已更新</strong></div>' +
    '<div class="wcx-body" style="color:#64748b;font-size:13px;line-height:1.6;">请按 <b>Command + Shift + R</b> 刷新页面。</div>';
  el.style.position = 'fixed';
  el.style.zIndex = '999999';
  ['mousedown', 'mouseup', 'click', 'dblclick'].forEach(evt => {
    el.addEventListener(evt, e => e.stopPropagation());
  });
  document.documentElement.appendChild(el);
  wcxPopup = el;
  if (rect) wcxUpdatePosition(rect, el);
  else {
    el.style.left = Math.round((window.innerWidth - 320) / 2) + 'px';
    el.style.top = Math.round((window.innerHeight - 120) / 2) + 'px';
  }
  setTimeout(() => {
    if (el && el.parentNode) el.remove();
    if (wcxPopup === el) wcxPopup = null;
  }, 3500);
}

function wcxShowPopup(rect, word) {
  if (wcxPopup && wcxPopup.parentNode) wcxPopup.remove();
  if (wcxSentencePopup && wcxSentencePopup.parentNode) wcxSentencePopup.remove();
  wcxSentencePopup = null;

  wcxPopup = document.createElement('div');
  wcxPopup.className = 'wcx-popup';
  wcxPopup.innerHTML = '<div class="wcx-header"><strong>' + word + '</strong><span class="wcx-status">查询中...</span></div><div class="wcx-body">正在获取释义...</div>';
  wcxPopup.style.position = 'fixed';
  wcxPopup.style.zIndex = '999999';
  wcxPopup.style.visibility = 'hidden';

  ['mousedown', 'mouseup', 'click', 'dblclick'].forEach(evt => {
    wcxPopup.addEventListener(evt, e => e.stopPropagation());
  });

  document.documentElement.appendChild(wcxPopup);
  wcxUpdatePosition(rect, wcxPopup);
  wcxPopup.style.visibility = 'visible';

  setTimeout(() => {
    document.addEventListener('mousedown', wcxHandleOutsideClick, true);
    document.addEventListener('scroll', wcxHandleScroll, true);
  }, 300);

  startPoller();
}

function wcxShowSentencePopup(rect, sentence) {
  if (wcxPopup && wcxPopup.parentNode) wcxPopup.remove();
  if (wcxSentencePopup && wcxSentencePopup.parentNode) wcxSentencePopup.remove();
  wcxPopup = null;

  wcxSentencePopup = document.createElement('div');
  wcxSentencePopup.className = 'wcx-sentence-popup';
  wcxSentencePopup.innerHTML =
    '<div class="wcx-sentence-header">' +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M4 7h16M4 12h16M4 17h10"></path>' +
      '</svg>' +
      '<span>句子翻译</span>' +
    '</div>' +
    '<div class="wcx-sentence-source">' + escapeHtml(sentence) + '</div>' +
    '<div class="wcx-sentence-divider"></div>' +
    '<div class="wcx-sentence-result">正在翻译...</div>';

  wcxSentencePopup.style.position = 'fixed';
  wcxSentencePopup.style.zIndex = '999999';
  wcxSentencePopup.style.visibility = 'hidden';

  ['mousedown', 'mouseup', 'click', 'dblclick'].forEach(evt => {
    wcxSentencePopup.addEventListener(evt, e => e.stopPropagation());
  });

  document.documentElement.appendChild(wcxSentencePopup);
  wcxUpdatePosition(rect, wcxSentencePopup);
  wcxSentencePopup.style.visibility = 'visible';

  setTimeout(() => {
    document.addEventListener('mousedown', wcxHandleOutsideClick, true);
    document.addEventListener('scroll', wcxHandleScroll, true);
  }, 300);

  startPoller();
}

function updateSentenceTranslation(translation, sourceText) {
  if (!wcxSentencePopup) return;
  const resultEl = wcxSentencePopup.querySelector('.wcx-sentence-result');
  if (!resultEl) return;

  if (!translation) {
    resultEl.innerHTML = '<span style="color:#ef4444;">翻译失败</span>';
    return;
  }

  resultEl.textContent = translation;

  const actionsEl = document.createElement('div');
  actionsEl.className = 'wcx-sentence-actions';
  const clipBtn = document.createElement('button');
  clipBtn.className = 'wcx-clip-btn';
  clipBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>' +
    '</svg>' +
    '<span>摘抄此句</span>';

  clipBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await saveClip(sourceText, translation);
    clipBtn.classList.add('clipped');
    clipBtn.querySelector('span').textContent = ok === 'exists' ? '已存在 ✓' : '已摘抄 ✓';
    clipBtn.disabled = true;
  });

  actionsEl.appendChild(clipBtn);
  resultEl.parentNode.appendChild(actionsEl);
}

async function saveClip(text, translation) {
  if (!isExtensionAlive()) return 'dead';
  try {
    const r = await chrome.storage.local.get('clips');
    const clips = r.clips || [];
    if (clips.some(c => c.text === text)) return 'exists';
    clips.unshift({
      id: 'clip_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      text, translation,
      url: location.href,
      title: document.title || '',
      note: '', starred: false,
      createdAt: Date.now()
    });
    if (clips.length > 2000) clips.length = 2000;
    await chrome.storage.local.set({ clips });
    return 'ok';
  } catch (e) {
    return 'error';
  }
}

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  wcxMouseDownPos = { x: e.clientX, y: e.clientY };
}, true);

document.addEventListener('mouseup', (e) => {
  if (!wcxEnabled) return;
  if (e.button !== 0) return;
  if (wcxPopup && wcxPopup.contains(e.target)) return;
  if (wcxSentencePopup && wcxSentencePopup.contains(e.target)) return;

  const downPos = wcxMouseDownPos;
  wcxMouseDownPos = null;

  let moved = 0;
  if (downPos) {
    const dx = e.clientX - downPos.x;
    const dy = e.clientY - downPos.y;
    moved = Math.sqrt(dx * dx + dy * dy);
  }

  const capturedText = getSelectedText();
  const capturedRect = getSelectionRect();
  const capturedAnchor = captureAnchorForSelection();
  const isDrag = moved > 4;

  if (!capturedText || !capturedRect) return;

  if (!isExtensionAlive()) {
    if (isDrag) showRefreshHint(capturedRect);
    return;
  }

  if (isDrag) {
    const wordCount = capturedText.split(/\s+/).filter(Boolean).length;
    if (wordCount < 2 && capturedText.length < 10) return;
    if (capturedText.length > 500) return;
    if (wcxClickTimer) { clearTimeout(wcxClickTimer); wcxClickTimer = null; }

    setTimeout(() => {
      wcxAnchor = capturedAnchor;
      wcxShowSentencePopup(capturedRect, capturedText);
      translateSentenceAsync(capturedText);
    }, 100);
    return;
  }

  if (!/^[a-zA-Z]+$/.test(capturedText)) {
    if (!wcxPopup || !wcxPopup.contains(e.target)) {
      if (!wcxSentencePopup || !wcxSentencePopup.contains(e.target)) wcxRemovePopup();
    }
    return;
  }

  if (wcxClickTimer) clearTimeout(wcxClickTimer);
  wcxClickTimer = setTimeout(() => {
    if (!isExtensionAlive()) return;
    purgeAllOldPopups();
    wcxWord = capturedText.toLowerCase();
    wcxAnchor = capturedAnchor;
    wcxShowPopup(capturedRect, wcxWord);
    wcxDoLookup(wcxWord);
  }, 250);
}, true);

window.addEventListener('resize', wcxRemovePopup);

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function queryBackground(word) {
  return new Promise((resolve) => {
    if (!isExtensionAlive()) { resolve({ success: false, error: 'EXTENSION_DEAD' }); return; }
    const timer = setTimeout(() => resolve({ success: false, error: '后台响应超时' }), 30000);
    try {
      chrome.runtime.sendMessage({ type: 'LOOKUP_WORD', word }, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
        else resolve(response || { success: false, error: '无响应' });
      });
    } catch (e) {
      clearTimeout(timer);
      resolve({ success: false, error: e.message });
    }
  });
}

function translateSentenceAsync(sentence) {
  if (!isExtensionAlive()) { updateSentenceTranslation(null, sentence); return; }
  try {
    chrome.runtime.sendMessage({ type: 'TRANSLATE_SENTENCE', text: sentence }, (response) => {
      if (chrome.runtime.lastError) { updateSentenceTranslation(null, sentence); return; }
      if (response && response.success) updateSentenceTranslation(response.translation, sentence);
      else updateSentenceTranslation(null, sentence);
    });
  } catch (e) {
    updateSentenceTranslation(null, sentence);
  }
}

function playAudioViaBackground(url) {
  if (!isExtensionAlive()) return;
  try {
    chrome.runtime.sendMessage({ type: 'PLAY_AUDIO', url }, (response) => {
      if (chrome.runtime.lastError) return;
    });
  } catch (e) {}
}

const AUDIO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M11 5 L6 9 H2 V15 H6 L11 19 Z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path>' +
  '<path d="M16 9 a5 5 0 0 1 0 6"></path>' +
  '</svg>';

function renderMeanings(meanings) {
  if (!meanings || meanings.length === 0) return '<div class="wcx-empty">暂无释义</div>';
  let html = '';
  for (const m of meanings) {
    if (m.partOfSpeech) html += '<div class="wcx-pos">' + escapeHtml(m.partOfSpeech) + '</div>';
    const defs = m.definitions || [];
    if (defs.length === 0) continue;
    html += '<ul class="wcx-defs">';
    for (const d of defs) {
      html += '<li class="wcx-def-item"><div class="wcx-def-text">' + escapeHtml(d.definition) + '</div>';
      if (d.example) html += '<div class="wcx-example">' + escapeHtml(d.example) + '</div>';
      html += '</li>';
    }
    html += '</ul>';
  }
  return html;
}

function renderExamples(examples) {
  if (!examples || examples.length === 0) return '';
  let html = '<div class="wcx-examples-block"><div class="wcx-examples-title">例句</div>';
  for (const ex of examples) {
    html += '<div class="wcx-example-item">';
    html += '<div class="wcx-example-en">' + escapeHtml(ex.en) + '</div>';
    if (ex.zh) html += '<div class="wcx-example-zh">' + escapeHtml(ex.zh) + '</div>';
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function renderPhrases(phrases) {
  if (!phrases || phrases.length === 0) return '';
  let html = '<div class="wcx-phrases-block"><div class="wcx-phrases-title">短语</div>';
  for (const p of phrases) {
    html += '<div class="wcx-phrase-item">';
    html += '<span class="wcx-phrase-en">' + escapeHtml(p.phrase) + '</span>';
    html += '<span class="wcx-phrase-zh">' + escapeHtml(p.translation) + '</span>';
    html += '</div>';
  }
  html += '</div>';
  return html;
}

async function wcxDoLookup(word) {
  const response = await queryBackground(word);
  if (!wcxPopup || wcxWord !== word) return;

  if (response.error === 'EXTENSION_DEAD') { showRefreshHint(); return; }

  if (!response || !response.success) {
    wcxPopup.innerHTML = '<div class="wcx-header"><strong>' + escapeHtml(word) + '</strong></div>' +
      '<div class="wcx-body wcx-error">' + escapeHtml((response && response.error) || '查询失败') + '</div>';
    return;
  }

  let data = response.data;
  let isOnline = data.source === 'online';
  const lemma = (data.lemma || '').trim();
  const useLemma = wcxStoreLemma && lemma && lemma !== word;

  if (useLemma) {
    const resp2 = await queryBackground(lemma);
    if (!wcxPopup || wcxWord !== word) return;
    if (resp2 && resp2.success) {
      data = resp2.data;
      data.lemma = lemma;
      isOnline = data.source === 'online';
    }
  }

  const storeKey = useLemma ? lemma : word;

  if (wcxRecordWords) {
    saveToVocabulary(storeKey, data);
  }

  let titleHtml = '<strong>' + escapeHtml(word) + '</strong>';
  if (useLemma) {
    titleHtml += '<span class="wcx-lemma">原形 ' + escapeHtml(lemma) + '</span>';
  }

  let phoneticHtml = '';
  if (data.phonetic) phoneticHtml += '<span class="wcx-phonetic-text">' + escapeHtml(data.phonetic) + '</span>';
  if (data.audio) phoneticHtml += '<button class="wcx-play-audio" data-audio="' + escapeHtml(data.audio) + '" title="播放发音">' + AUDIO_SVG + '</button>';
  const phoneticBlock = phoneticHtml ? '<div class="wcx-phonetic">' + phoneticHtml + '</div>' : '';

  const meaningsHtml = renderMeanings(data.meanings);
  const examplesHtml = renderExamples(data.examples);
  const phrasesHtml = renderPhrases(data.phrases);

  const sourceLabel = isOnline
    ? '<span class="wcx-source online">在线</span>'
    : '<span class="wcx-source local">本地</span>';

  const savedLabel = wcxRecordWords
    ? '<span class="wcx-status wcx-saved">已加入生词本 ✓</span>'
    : '<span class="wcx-status wcx-not-saved">未记录</span>';

  wcxPopup.innerHTML =
    '<div class="wcx-header">' +
      '<div class="wcx-title">' + titleHtml + '</div>' +
      '<div class="wcx-header-right">' + sourceLabel + savedLabel + '</div>' +
    '</div>' +
    phoneticBlock +
    '<div class="wcx-body">' + meaningsHtml + phrasesHtml + examplesHtml + '</div>';

  const playButton = wcxPopup.querySelector('.wcx-play-audio');
  if (playButton) {
    playButton.addEventListener('click', function(e) {
      e.stopPropagation();
      const audioUrl = this.dataset.audio;
      if (audioUrl) playAudioViaBackground(audioUrl);
    });
  }
}

async function saveToVocabulary(word, entry) {
  if (!wcxRecordWords) {
    console.log('[Gloss] 生词记录已关闭，跳过:', word);
    return;
  }
  if (!isExtensionAlive()) return;
  try {
    const result = await chrome.storage.local.get('vocabulary');
    const vocabulary = result.vocabulary || {};
    if (vocabulary[word]) return;
    vocabulary[word] = {
      id: word, word,
      phonetic: entry.phonetic || '',
      audio: entry.audio || '',
      meanings: entry.meanings || [],
      examples: entry.examples || [],
      phrases: entry.phrases || [],
      note: '', tags: [], starred: false,
      status: 'new', addedAt: Date.now(), lastReviewedAt: null,
      reviewCount: 0, nextReviewAt: null, easeFactor: 2.5, interval: 1, repetitions: 0
    };
    await chrome.storage.local.set({ vocabulary });
  } catch (err) {}
}