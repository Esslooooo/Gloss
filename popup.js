try {
  chrome.storage.local.set({ _popupOpenedAt: Date.now() }, function() {
    if (chrome.runtime.lastError) {}
  });
} catch (e) {}

console.log('[Gloss Popup] popup.js 开始加载');

let state = {
  vocabulary: {}, clips: [], view: 'list', filter: 'all', search: '',
  detailWordId: null, editingNote: false,
  reviewQueue: [], reviewIndex: 0, reviewAnswerShown: false,
  contextTarget: null, enabled: true, blacklist: [], currentDomain: ''
};

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function on(id, event, handler) {
  const el = document.getElementById(id);
  if (!el) { console.warn('[Gloss Popup] 找不到 #' + id); return null; }
  el.addEventListener(event, handler);
  return el;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 MB';
  const kb = bytes / 1024;
  if (kb < 1024) return kb.toFixed(0) + ' KB';
  const mb = kb / 1024;
  if (mb < 1024) return mb.toFixed(1) + ' MB';
  return (mb / 1024).toFixed(2) + ' GB';
}

async function loadData() {
  const r = await chrome.storage.local.get('vocabulary');
  state.vocabulary = r.vocabulary || {};
}
async function saveData() { await chrome.storage.local.set({ vocabulary: state.vocabulary }); }
async function loadClips() {
  try {
    const r = await chrome.storage.local.get('clips');
    state.clips = r.clips || [];
  } catch (e) { state.clips = []; }
}

function calculateNextReview(quality, item) {
  let ef = item.easeFactor || 2.5;
  let interval = item.interval || 1;
  let reps = item.repetitions || 0;
  ef = Math.max(1.3, ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
  if (quality < 3) { reps = 0; interval = 1; }
  else {
    reps += 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 6;
    else interval = Math.round(interval * ef);
  }
  return {
    easeFactor: parseFloat(ef.toFixed(2)), interval, repetitions: reps,
    nextReviewAt: Date.now() + interval * 24 * 60 * 60 * 1000,
    lastReviewedAt: Date.now(),
    reviewCount: (item.reviewCount || 0) + 1,
    status: reps >= 5 ? 'mastered' : 'review'
  };
}

function showView(name) {
  state.view = name;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = document.getElementById('view-' + name);
  if (target) target.classList.add('active');

  const tabbar = document.getElementById('tabbar');
  if (tabbar) tabbar.style.display = (name === 'list' || name === 'review' || name === 'clips') ? 'flex' : 'none';

  document.querySelectorAll('.tabbar .tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));

  if (name === 'review') startReview();
  if (name === 'settings') loadSettings();
  if (name === 'clips') renderClips();
}

function updatePowerBtn() {
  const btn = document.getElementById('powerBtn');
  if (!btn) return;
  if (state.enabled) { btn.classList.add('active'); btn.title = '已启用 · 点击暂停'; }
  else { btn.classList.remove('active'); btn.title = '已暂停 · 点击启用'; }
}

on('powerBtn', 'click', async (e) => {
  e.stopPropagation(); e.preventDefault();
  const newEnabled = !state.enabled;
  state.enabled = newEnabled;
  const btn = document.getElementById('powerBtn');
  if (btn) {
    if (newEnabled) { btn.classList.add('active'); btn.title = '已启用 · 点击暂停'; }
    else { btn.classList.remove('active'); btn.title = '已暂停 · 点击启用'; }
  }
  try { await chrome.storage.local.set({ _enabled: newEnabled }); } catch (err) {}
  window.close();
});

on('settingsBtn', 'click', () => showView('settings'));
on('settingsBackBtn', 'click', () => showView('list'));
on('tabbar', 'click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  showView(tab.dataset.view);
});

function updateBadges() {
  const all = Object.values(state.vocabulary);
  const now = Date.now();
  const due = all.filter(w => {
    if (w.status === 'mastered') return false;
    if (w.status === 'new' || !w.nextReviewAt) return true;
    return w.nextReviewAt <= now;
  }).length;

  const listBadge = document.getElementById('listBadge');
  const reviewBadge = document.getElementById('reviewBadge');
  const clipsBadge = document.getElementById('clipsBadge');
  if (listBadge) { listBadge.textContent = all.length; listBadge.classList.toggle('hidden', all.length === 0); }
  if (reviewBadge) { reviewBadge.textContent = due; reviewBadge.classList.toggle('hidden', due === 0); }
  const clipCount = (state.clips || []).length;
  if (clipsBadge) { clipsBadge.textContent = clipCount; clipsBadge.classList.toggle('hidden', clipCount === 0); }
}

function getFilteredWords() {
  let words = Object.values(state.vocabulary);
  if (state.filter === 'starred') words = words.filter(w => w.starred);
  else if (state.filter === 'review') {
    const now = Date.now();
    words = words.filter(w => {
      if (w.status === 'mastered') return false;
      if (w.status === 'new' || !w.nextReviewAt) return true;
      return w.nextReviewAt <= now;
    });
  } else if (state.filter === 'mastered') words = words.filter(w => w.status === 'mastered');

  if (state.search) {
    const q = state.search.toLowerCase();
    words = words.filter(w =>
      w.word.toLowerCase().includes(q) ||
      (w.note && w.note.toLowerCase().includes(q)) ||
      (w.meanings || []).some(m => (m.definitions || []).some(d => (d.definition || '').toLowerCase().includes(q)))
    );
  }
  return words.sort((a, b) => b.addedAt - a.addedAt);
}

function getFirstMeaning(item) {
  if (!item.meanings || !item.meanings.length) return '';
  const m = item.meanings[0];
  const defs = m.definitions || [];
  if (!defs.length) return '';
  let text = (defs[0].definition || '').trim();
  const idx = text.search(/[；;]/);
  if (idx > 0) text = text.slice(0, idx).trim();
  const pos = m.partOfSpeech || '';
  return pos && !text.startsWith(pos) ? (pos + ' ' + text).trim() : text;
}

function renderList() {
  const listEl = document.getElementById('wordList');
  if (!listEl) return;
  const words = getFilteredWords();
  if (words.length === 0) {
    listEl.innerHTML = '<div class="empty-list">还没有单词<br>双击网页上的单词即可收录</div>';
    return;
  }
  listEl.innerHTML = words.map(item => {
    const id = item.id || item.word;
    const firstDef = getFirstMeaning(item);
    return `
      <div class="word-row" data-id="${escapeHtml(id)}">
        <div class="w">${item.starred ? '<span class="star-dot"></span>' : ''}${escapeHtml(item.word)}</div>
        ${item.phonetic ? `<div class="ph">${escapeHtml(item.phonetic)}</div>` : ''}
        ${firstDef ? `<div class="d">${escapeHtml(firstDef)}</div>` : ''}
      </div>
    `;
  }).join('');
}

on('wordList', 'click', (e) => {
  const row = e.target.closest('.word-row');
  if (!row) return;
  openDetail(row.dataset.id);
});
on('wordList', 'contextmenu', (e) => {
  const row = e.target.closest('.word-row');
  if (!row) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, row.dataset.id);
});

function showContextMenu(x, y, wordId) {
  const menu = document.getElementById('contextMenu');
  if (!menu) return;
  state.contextTarget = wordId;
  const item = state.vocabulary[wordId];
  const starBtn = menu.querySelector('[data-action="star"] span');
  if (starBtn) starBtn.textContent = item && item.starred ? '取消收藏' : '收藏';
  menu.classList.add('show');
  const menuRect = menu.getBoundingClientRect();
  let left = x, top = y;
  if (x + menuRect.width > window.innerWidth) left = window.innerWidth - menuRect.width - 6;
  if (y + menuRect.height > window.innerHeight) top = window.innerHeight - menuRect.height - 6;
  menu.style.left = left + 'px'; menu.style.top = top + 'px';
}
function hideContextMenu() {
  const menu = document.getElementById('contextMenu');
  if (menu) menu.classList.remove('show');
  state.contextTarget = null;
}

on('contextMenu', 'click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = state.contextTarget;
  if (!id) return;
  const item = state.vocabulary[id];
  if (!item) { hideContextMenu(); return; }

  if (action === 'star') {
    item.starred = !item.starred;
    await saveData(); renderList(); updateBadges(); hideContextMenu();
  } else if (action === 'edit') {
    hideContextMenu(); openDetail(id);
    setTimeout(() => { state.editingNote = true; renderDetail(); }, 50);
  } else if (action === 'delete') {
    delete state.vocabulary[id];
    await saveData(); renderList(); updateBadges(); hideContextMenu();
  }
});

document.addEventListener('click', (e) => {
  const menu = document.getElementById('contextMenu');
  if (menu && !menu.contains(e.target)) hideContextMenu();
});
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.word-row')) hideContextMenu();
});

function openDetail(wordId) {
  state.detailWordId = wordId;
  state.editingNote = false;
  renderDetail();
  showView('detail');
}
on('backBtn', 'click', () => { state.detailWordId = null; state.editingNote = false; showView('list'); });

function renderDetail() {
  const item = state.vocabulary[state.detailWordId];
  const el = document.getElementById('detailContent');
  if (!item || !el) { if (el) el.innerHTML = ''; return; }

  const parts = [];
  parts.push(`<div class="detail-word">${escapeHtml(item.word)}</div>`);

  const ph = [];
  if (item.phonetic) ph.push(`<span>${escapeHtml(item.phonetic)}</span>`);
  if (item.audio) ph.push(`<button class="play-btn" data-audio="${escapeHtml(item.audio)}" title="发音"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>`);
  if (ph.length) parts.push(`<div class="detail-phonetic">${ph.join('')}</div>`);

  if (item.meanings && item.meanings.length) {
    parts.push('<div class="detail-section"><div class="detail-section-title">释义</div>');
    item.meanings.forEach(m => {
      if (m.partOfSpeech) parts.push(`<div class="detail-pos">${escapeHtml(m.partOfSpeech)}</div>`);
      (m.definitions || []).forEach(d => {
        if (d.definition) parts.push(`<div class="detail-def">${escapeHtml(d.definition)}</div>`);
      });
    });
    parts.push('</div>');
  }

  if (item.phrases && item.phrases.length) {
    parts.push('<div class="detail-section"><div class="detail-section-title">短语</div>');
    item.phrases.forEach(p => {
      parts.push(`<div class="detail-phrase-row"><span class="en">${escapeHtml(p.phrase)}</span><span class="zh">${escapeHtml(p.translation)}</span></div>`);
    });
    parts.push('</div>');
  }

  if (item.examples && item.examples.length) {
    parts.push('<div class="detail-section"><div class="detail-section-title">例句</div>');
    item.examples.forEach(ex => {
      parts.push(`<div class="detail-example"><div class="en">${escapeHtml(ex.en)}</div>${ex.zh ? `<div class="zh">${escapeHtml(ex.zh)}</div>` : ''}</div>`);
    });
    parts.push('</div>');
  }

  parts.push('<div class="detail-section"><div class="detail-section-title">笔记</div>');
  if (state.editingNote) {
    parts.push(`<textarea class="note-area" id="noteInput" placeholder="添加笔记...">${escapeHtml(item.note || '')}</textarea>`);
    parts.push('<div class="note-actions">');
    parts.push('<button class="btn-secondary" id="cancelNoteBtn" style="flex:0 0 auto;">取消</button>');
    parts.push('<button class="btn-primary" id="saveNoteBtn" style="flex:0 0 auto;">保存</button>');
    parts.push('</div>');
  } else {
    parts.push(item.note ? `<div class="detail-note">${escapeHtml(item.note)}</div>` : '<div class="detail-note empty">暂无笔记</div>');
    parts.push('<button class="note-edit-btn" id="editNoteBtn">编辑笔记</button>');
  }
  parts.push('</div>');

  parts.push('<div class="detail-actions">');
  parts.push(`<button id="starBtn" class="${item.starred ? 'starred' : ''}">${item.starred ? '已收藏' : '收藏'}</button>`);
  parts.push('<button class="danger" id="deleteBtn">删除</button>');
  parts.push('</div>');

  el.innerHTML = parts.join('');

  el.querySelectorAll('.play-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = btn.dataset.audio;
      if (url) chrome.runtime.sendMessage({ type: 'PLAY_AUDIO', url }, function() {});
    });
  });

  const editNoteBtn = document.getElementById('editNoteBtn');
  if (editNoteBtn) editNoteBtn.addEventListener('click', () => { state.editingNote = true; renderDetail(); });

  const saveNoteBtn = document.getElementById('saveNoteBtn');
  if (saveNoteBtn) saveNoteBtn.addEventListener('click', async () => {
    const ta = document.getElementById('noteInput');
    if (ta) item.note = ta.value.trim();
    await saveData(); state.editingNote = false; renderDetail();
  });

  const cancelNoteBtn = document.getElementById('cancelNoteBtn');
  if (cancelNoteBtn) cancelNoteBtn.addEventListener('click', () => { state.editingNote = false; renderDetail(); });

  const starBtn = document.getElementById('starBtn');
  if (starBtn) starBtn.addEventListener('click', async () => {
    item.starred = !item.starred;
    await saveData(); renderDetail(); updateBadges();
  });

  const deleteBtn = document.getElementById('deleteBtn');
  if (deleteBtn) deleteBtn.addEventListener('click', async () => {
    delete state.vocabulary[state.detailWordId];
    await saveData();
    state.detailWordId = null; state.editingNote = false;
    showView('list'); renderList(); updateBadges();
  });
}

function renderClips() {
  const body = document.getElementById('clipsBody');
  if (!body) return;
  const clips = state.clips || [];
  if (clips.length === 0) {
    body.innerHTML = '<div class="empty-clips">还没有摘抄<br><br>拖动划选句子<br>点击「摘抄此句」即可收录</div>';
    return;
  }
  body.innerHTML = clips.map(c => {
    const sourceHost = (() => { try { return new URL(c.url).hostname.replace(/^www\./, ''); } catch (e) { return c.url || ''; } })();
    const dateStr = new Date(c.createdAt).toLocaleDateString();
    return `
      <div class="clip-card" data-id="${escapeHtml(c.id)}">
        <div class="clip-text" data-action="copy" data-id="${escapeHtml(c.id)}">${escapeHtml(c.text)}</div>
        <div class="clip-translation">${escapeHtml(c.translation)}</div>
        ${c.note ? `<div class="clip-note">${escapeHtml(c.note)}</div>` : ''}
        <div class="clip-meta">
          <span class="clip-source" title="${escapeHtml(c.url || '')}">${escapeHtml(sourceHost)} · ${dateStr}</span>
          <div class="clip-actions">
            <button class="clip-action-btn" data-action="copy-full" data-id="${escapeHtml(c.id)}" title="复制">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
            <button class="clip-action-btn danger" data-action="delete-clip" data-id="${escapeHtml(c.id)}" title="删除">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

on('clipsBody', 'click', async (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  const clip = (state.clips || []).find(c => c.id === id);
  if (!clip) return;
  if (action === 'copy' || action === 'copy-full') {
    const text = action === 'copy-full' ? (clip.text + '\n\n' + clip.translation) : clip.text;
    try { await navigator.clipboard.writeText(text); } catch (err) {}
  } else if (action === 'delete-clip') {
    state.clips = state.clips.filter(c => c.id !== id);
    await chrome.storage.local.set({ clips: state.clips });
    renderClips(); updateBadges();
  }
});

on('searchBox', 'input', (e) => { state.search = e.target.value; renderList(); });
on('filters', 'click', (e) => {
  const btn = e.target.closest('.filter');
  if (!btn) return;
  document.querySelectorAll('.filter').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.filter = btn.dataset.filter;
  renderList();
});

function startReview() {
  const now = Date.now();
  state.reviewQueue = Object.values(state.vocabulary)
    .filter(w => {
      if (w.status === 'mastered') return false;
      if (w.status === 'new' || !w.nextReviewAt) return true;
      return w.nextReviewAt <= now;
    })
    .sort((a, b) => (a.nextReviewAt || 0) - (b.nextReviewAt || 0));
  state.reviewIndex = 0;
  state.reviewAnswerShown = false;
  renderReview();
}

function renderReview() {
  const emptyEl = document.getElementById('reviewEmpty');
  const cardEl = document.getElementById('reviewCard');
  if (!emptyEl || !cardEl) return;
  if (state.reviewIndex >= state.reviewQueue.length || state.reviewQueue.length === 0) {
    emptyEl.style.display = 'flex'; cardEl.style.display = 'none'; return;
  }
  emptyEl.style.display = 'none'; cardEl.style.display = 'flex';
  const item = state.reviewQueue[state.reviewIndex];

  document.getElementById('reviewProgress').textContent = (state.reviewIndex + 1) + ' / ' + state.reviewQueue.length;
  document.getElementById('reviewWord').textContent = item.word;
  document.getElementById('reviewPhonetic').textContent = item.phonetic || '';

  const meaningEl = document.getElementById('reviewMeaning');
  const frontEl = document.getElementById('reviewFront');
  const gradesEl = document.getElementById('reviewGrades');

  const meaningHtml = (item.meanings || []).map(m => {
    const pos = m.partOfSpeech ? `<em>${escapeHtml(m.partOfSpeech)}</em>` : '';
    const defs = (m.definitions || []).map(d => escapeHtml(d.definition || '')).join('；');
    return `<div>${pos}${defs}</div>`;
  }).join('') || '<div>暂无释义</div>';
  meaningEl.innerHTML = meaningHtml;

  if (state.reviewAnswerShown) {
    meaningEl.classList.add('show');
    frontEl.classList.add('hidden');
    gradesEl.classList.add('show');
  } else {
    meaningEl.classList.remove('show');
    frontEl.classList.remove('hidden');
    gradesEl.classList.remove('show');
  }
}

on('showAnswerBtn', 'click', () => { state.reviewAnswerShown = true; renderReview(); });
on('skipBtn', 'click', () => submitReview(4));
on('reviewGrades', 'click', (e) => {
  const btn = e.target.closest('.grade');
  if (!btn) return;
  submitReview(parseInt(btn.dataset.q));
});

async function submitReview(quality) {
  const item = state.reviewQueue[state.reviewIndex];
  if (!item) return;
  const id = item.id || item.word;
  Object.assign(state.vocabulary[id], calculateNextReview(quality, item));
  await saveData();
  state.reviewIndex++;
  state.reviewAnswerShown = false;
  renderReview();
  updateBadges();
}

document.addEventListener('keydown', (e) => {
  if (state.view !== 'review') return;
  const gradesEl = document.getElementById('reviewGrades');
  const isShown = gradesEl && gradesEl.classList.contains('show');
  if (e.code === 'Space' && !isShown) { e.preventDefault(); state.reviewAnswerShown = true; renderReview(); }
  else if (e.code === 'ArrowRight' && !isShown) { e.preventDefault(); submitReview(4); }
  else if (isShown) {
    const map = { 'Digit1': 0, 'Digit2': 3, 'Digit3': 4, 'Digit4': 5 };
    if (map[e.code] !== undefined) { e.preventDefault(); submitReview(map[e.code]); }
  }
});

// ============================================================
// 本地词典 UI
// ============================================================
function renderDictUI(r) {
  const statusEl = document.getElementById('dictStatusText');
  const downloadBtn = document.getElementById('downloadDictBtn');
  const clearBtn = document.getElementById('clearDictBtn');
  const progressWrap = document.getElementById('dictProgressWrap');
  const progressFill = document.getElementById('dictProgressFill');
  const progressText = document.getElementById('dictProgressText');

  if (!statusEl) return;

  const status = r.status || r._dictStatus || (r._dictInstalled ? 'installed' : 'not_installed');
  const count = r.count || r._dictCount || 0;
  const progress = r.progress || r._dictProgress;
  const error = r.error || r._dictError;

  if (status === 'downloading' && progress) {
    const percent = (progress.current / progress.total) * 100;
    statusEl.textContent = '下载中 ' + Math.round(percent) + '%';
    statusEl.className = 'dict-status-text';
    progressWrap.style.display = 'block';
    progressFill.style.width = percent + '%';
    progressText.textContent = progress.current + ' / ' + progress.total + ' 分片 · ' + (progress.loaded || 0).toLocaleString() + ' 词条';
    downloadBtn.textContent = '下载中...';
    downloadBtn.disabled = true;
    clearBtn.style.display = 'none';
  } else if (status === 'installed' && count > 0) {
    statusEl.textContent = '已安装 · ' + count.toLocaleString() + ' 词条';
    statusEl.className = 'dict-status-text installed';
    progressWrap.style.display = 'none';
    downloadBtn.textContent = '重新下载';
    downloadBtn.disabled = false;
    clearBtn.style.display = 'block';
  } else if (status === 'failed') {
    statusEl.textContent = '下载失败：' + (error || '未知原因');
    statusEl.className = 'dict-status-text missing';
    progressWrap.style.display = 'none';
    downloadBtn.textContent = '重试下载';
    downloadBtn.disabled = false;
    clearBtn.style.display = 'none';
  } else {
    statusEl.textContent = '未安装';
    statusEl.className = 'dict-status-text missing';
    progressWrap.style.display = 'none';
    downloadBtn.textContent = '下载本地词典';
    downloadBtn.disabled = false;
    clearBtn.style.display = 'none';
  }
}

async function updateDictStatus() {
  try {
    const cached = await chrome.storage.local.get([
      '_dictStatus', '_dictInstalled', '_dictCount', '_dictProgress', '_dictError'
    ]);
    renderDictUI({
      status: cached._dictStatus || (cached._dictInstalled ? 'installed' : 'not_installed'),
      installed: cached._dictInstalled === true,
      count: cached._dictCount || 0,
      progress: cached._dictProgress || null,
      error: cached._dictError || null
    });
  } catch (e) {}

  try {
    const r = await chrome.runtime.sendMessage({ type: 'DICT_STATUS' });
    renderDictUI(r);
  } catch (e) {
    console.warn('[Gloss Popup] 读取词典状态失败:', e);
  }
}

async function updateStorageInfo() {
  const valueEl = document.getElementById('storageUsageValue');
  const fillEl = document.getElementById('storageFill');
  const hintEl = document.getElementById('storageHint');
  if (!valueEl || !fillEl || !hintEl) return;

  function paint(r) {
    const status = r.status || 'not_installed';
    const progress = r.progress;
    const bytes = r.bytes || 0;
    const bytesTotal = r.bytesTotal || 0;

    if (status === 'downloading' && progress) {
      const done = progress.current || 0;
      const total = progress.total || 1;
      const ratio = done / total;
      const estimatedTotal = ratio > 0 ? bytes / ratio : 0;
      valueEl.textContent = formatBytes(bytes) + ' / 约 ' + formatBytes(estimatedTotal);
      fillEl.style.width = (ratio * 100) + '%';
      hintEl.textContent = '已下载 ' + done + ' / ' + total + ' 分片';
    } else if (status === 'installed') {
      valueEl.textContent = formatBytes(bytesTotal || bytes);
      fillEl.style.width = '100%';
      hintEl.textContent = '完整词典 · ' + (r.count || 0).toLocaleString() + ' 词条';
    } else {
      valueEl.textContent = '未下载';
      fillEl.style.width = '0%';
      hintEl.textContent = '点击上方按钮下载完整词典';
    }
  }

  try {
    const cached = await chrome.storage.local.get([
      '_dictStatus', '_dictInstalled', '_dictCount',
      '_dictProgress', '_dictBytes', '_dictBytesTotal'
    ]);
    paint({
      status: cached._dictStatus || (cached._dictInstalled ? 'installed' : 'not_installed'),
      count: cached._dictCount || 0,
      progress: cached._dictProgress || null,
      bytes: cached._dictBytes || 0,
      bytesTotal: cached._dictBytesTotal || 0
    });
  } catch (e) {}

  try {
    const r = await chrome.runtime.sendMessage({ type: 'DICT_STATUS' });
    paint(r);
  } catch (e) {}
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes._dictProgress || changes._dictStatus || changes._dictInstalled || changes._dictCount ||
      changes._dictError || changes._dictBytes || changes._dictBytesTotal) {
    if (state.view === 'settings') {
      updateDictStatus();
      updateStorageInfo();
    }
  }
});

on('downloadDictBtn', 'click', async () => {
  await chrome.storage.local.set({ _dictBaseUrl: 'local' });
  // await chrome.storage.local.set({ _dictBaseUrl: '' });

  chrome.runtime.sendMessage({ type: 'DICT_DOWNLOAD' }, function() {
    if (chrome.runtime.lastError) console.warn('[Gloss Popup] 启动下载失败');
  });

  setTimeout(() => { updateDictStatus(); updateStorageInfo(); }, 200);
});

let clearConfirming = false;
on('clearDictBtn', 'click', async () => {
  const btn = document.getElementById('clearDictBtn');
  if (!clearConfirming) {
    clearConfirming = true;
    btn.textContent = '再点一次确认清除';
    btn.style.background = '#ffe5e3';
    btn.style.color = '#ff3b30';
    setTimeout(() => {
      if (clearConfirming) {
        clearConfirming = false;
        btn.textContent = '清除本地词典';
        btn.style.background = '';
        btn.style.color = '';
      }
    }, 3000);
    return;
  }
  clearConfirming = false;
  btn.textContent = '清除中...';
  btn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'DICT_CLEAR' });
    console.log('[Gloss Popup] 清除结果:', resp);
    await updateDictStatus();
    await updateStorageInfo();
  } catch (e) {
    alert('清除失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '清除本地词典';
    btn.style.background = '';
    btn.style.color = '';
  }
});

// ============================================================
// 设置
// ============================================================
async function loadSettings() {
  try {
    const r = await chrome.storage.local.get(['dictSource', 'onlineSource', '_enabled', '_blacklist']);
    const ds = document.getElementById('dictSourceSelect');
    if (ds) ds.value = r.dictSource || 'auto';
    const os = document.getElementById('onlineSourceSelect');
    if (os) os.value = r.onlineSource || 'youdao';

    state.enabled = r._enabled !== false;
    state.blacklist = r._blacklist || [];
    updatePowerBtn();

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs[0] && tabs[0].url) state.currentDomain = new URL(tabs[0].url).hostname;
      else state.currentDomain = '';
    } catch (e) { state.currentDomain = ''; }

    renderCurrentSite();
    renderBlacklist();
    updateDictStatus();
    updateStorageInfo();
  } catch (e) {}
}

function renderCurrentSite() {
  const domainEl = document.getElementById('currentDomain');
  const btn = document.getElementById('toggleSiteBtn');
  if (!domainEl || !btn) return;
  if (!state.currentDomain) {
    domainEl.textContent = '（当前页面不支持）';
    btn.disabled = true; btn.style.opacity = '0.4'; return;
  }
  domainEl.textContent = state.currentDomain;
  btn.disabled = false; btn.style.opacity = '1';
  const inBlacklist = state.blacklist.some(b => state.currentDomain === b || state.currentDomain.endsWith('.' + b));
  if (inBlacklist) { btn.textContent = '移出黑名单'; btn.classList.add('danger'); }
  else { btn.textContent = '加入黑名单'; btn.classList.remove('danger'); }
}

function renderBlacklist() {
  const group = document.getElementById('blacklistGroup');
  const items = document.getElementById('blacklistItems');
  if (!group || !items) return;
  if (!state.blacklist || state.blacklist.length === 0) { group.style.display = 'none'; return; }
  group.style.display = 'block';
  items.innerHTML = state.blacklist.map(b => `
    <div class="blacklist-item">
      <span>${escapeHtml(b)}</span>
      <button class="blacklist-remove" data-domain="${escapeHtml(b)}" title="移除">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
  `).join('');
  items.querySelectorAll('.blacklist-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const domain = btn.dataset.domain;
      state.blacklist = state.blacklist.filter(b => b !== domain);
      await chrome.storage.local.set({ _blacklist: state.blacklist });
      renderCurrentSite(); renderBlacklist();
    });
  });
}

on('toggleSiteBtn', 'click', async () => {
  if (!state.currentDomain) return;
  const inBlacklist = state.blacklist.some(b => state.currentDomain === b || state.currentDomain.endsWith('.' + b));
  if (inBlacklist) state.blacklist = state.blacklist.filter(b => b !== state.currentDomain);
  else state.blacklist.push(state.currentDomain);
  await chrome.storage.local.set({ _blacklist: state.blacklist });
  renderCurrentSite(); renderBlacklist();
});

on('dictSourceSelect', 'change', async (e) => { await chrome.storage.local.set({ dictSource: e.target.value }); });
on('onlineSourceSelect', 'change', async (e) => { await chrome.storage.local.set({ onlineSource: e.target.value }); });

on('testApiBtn', 'click', async () => {
  const hint = document.getElementById('apiStatusHint');
  hint.textContent = '测试中...'; hint.style.color = '#86868b';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'TEST_ONLINE_API' });
    if (resp && resp.success) { hint.textContent = '在线词典可用'; hint.style.color = '#34c759'; }
    else { hint.textContent = (resp && resp.error) || '测试失败'; hint.style.color = '#ff3b30'; }
  } catch (err) { hint.textContent = '异常: ' + err.message; hint.style.color = '#ff3b30'; }
});

on('exportBtn', 'click', async () => {
  const data = JSON.stringify(state.vocabulary, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'gloss-vocabulary-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
});

on('importBtn', 'click', () => { document.getElementById('importFile').click(); });

on('importFile', 'change', async (e) => {
  if (!e.target.files[0]) return;
  try {
    const text = await e.target.files[0].text();
    const imported = JSON.parse(text);
    let count = 0;
    for (const key of Object.keys(imported)) {
      if (!state.vocabulary[key]) { state.vocabulary[key] = imported[key]; count++; }
    }
    await saveData();
    renderList(); updateBadges();
    alert('导入完成，新增 ' + count + ' 条');
  } catch (err) { alert('导入失败: ' + err.message); }
  finally { e.target.value = ''; }
});

loadData()
  .then(() => loadClips())
  .then(() => chrome.storage.local.get(['_enabled', '_blacklist']))
  .then((r) => {
    state.enabled = r._enabled !== false;
    state.blacklist = r._blacklist || [];
    updatePowerBtn();
    renderList();
    updateBadges();
    console.log('[Gloss Popup] 初始化完成');
  })
  .catch((err) => { console.error('[Gloss Popup] 初始化失败:', err); });