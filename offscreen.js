// ============================================================
// Offscreen 页面：专门用于在扩展沙箱里播放音频
// 不受网页 CSP 限制
// ============================================================
console.log('[Gloss Offscreen] 已加载');

let currentAudio = null;

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (!message || message.type !== 'PLAY_AUDIO_OFFSCREEN') return;

  const url = message.url;
  if (!url) {
    sendResponse({ success: false, error: '无音频 URL' });
    return true;
  }

  try {
    // 停止上一个音频
    if (currentAudio) {
      try { currentAudio.pause(); } catch (e) {}
      currentAudio = null;
    }

    currentAudio = new Audio(url);
    currentAudio.volume = 1.0;

    const playPromise = currentAudio.play();
    if (playPromise && playPromise.then) {
      playPromise.then(function() {
        console.log('[Gloss Offscreen] ✅ 播放成功');
        sendResponse({ success: true });
      }).catch(function(err) {
        console.warn('[Gloss Offscreen] ❌ 播放失败:', err.message);
        sendResponse({ success: false, error: err.message });
      });
    } else {
      sendResponse({ success: true });
    }
  } catch (err) {
    console.warn('[Gloss Offscreen] 异常:', err.message);
    sendResponse({ success: false, error: err.message });
  }

  return true;
});