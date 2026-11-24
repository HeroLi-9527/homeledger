/* 家账簿 · 浮动 AI 记账助手 */
'use strict';
(function () {
  const fab = document.getElementById('aiFab');
  const panel = document.getElementById('aiPanel');
  if (!fab || !panel) return;

  const $ = (id) => document.getElementById(id);
  const msgs = $('aiMsgs');
  const textEl = $('aiText');
  const sendBtn = $('aiSend');
  const attachBtn = $('aiAttach');
  const fileEl = $('aiFile');
  const thumbsEl = $('aiThumbs');
  const csrf = (document.querySelector('meta[name="csrf"]') || {}).content || '';
  const pendingImages = [];
  let busy = false;

  const esc = (s) => {
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  };

  function autoResize() {
    if (!textEl) return;
    textEl.style.height = 'auto';
    textEl.style.height = Math.min(textEl.scrollHeight, 120) + 'px';
  }

  function open() {
    panel.classList.remove('hidden');
    fab.classList.add('hidden');
    msgs.scrollTop = msgs.scrollHeight;
    textEl.focus();
  }
  function close() {
    panel.classList.add('hidden');
    fab.classList.remove('hidden');
  }
  fab.addEventListener('click', open);
  $('aiClose').addEventListener('click', close);
  $('aiClear').addEventListener('click', () => {
    while (msgs.children.length > 1) msgs.removeChild(msgs.lastChild);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.classList.contains('hidden')) close();
  });

  textEl.addEventListener('input', autoResize);
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', send);
  attachBtn.addEventListener('click', () => fileEl.click());
  fileEl.addEventListener('change', async () => {
    for (const f of Array.from(fileEl.files || [])) {
      if (pendingImages.length >= 6) break;
      const fr = new FileReader();
      const dataUrl = await new Promise((resolve) => {
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => resolve('');
        fr.readAsDataURL(f);
      });
      if (dataUrl) pendingImages.push({ dataUrl, name: f.name });
    }
    fileEl.value = '';
    renderThumbs();
  });

  function renderThumbs() {
    thumbsEl.innerHTML = '';
    thumbsEl.classList.toggle('hidden', !pendingImages.length);
    pendingImages.forEach((p, i) => {
      const d = document.createElement('div');
      d.className = 'thumb';
      d.innerHTML = `<img src="${p.dataUrl}" alt=""><button type="button">✕</button>`;
      d.querySelector('button').addEventListener('click', () => {
        pendingImages.splice(i, 1);
        renderThumbs();
      });
      thumbsEl.appendChild(d);
    });
  }

  function addBubble(cls, html) {
    const d = document.createElement('div');
    d.className = 'ai-bubble ' + cls;
    d.innerHTML = html;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  async function send() {
    if (busy) return;
    const text = textEl.value.trim();
    if (!text && !pendingImages.length) return;
    busy = true;
    sendBtn.disabled = true;
    const images = pendingImages.splice(0);
    renderThumbs();
    let userHtml = '';
    if (images.length) {
      userHtml += '<div class="ai-bubble-thumbs">' + images.map((im) => `<img src="${im.dataUrl}" alt="">`).join('') + '</div>';
    }
    userHtml += esc(text || '(已发送账单截图)');
    addBubble('user', userHtml);
    textEl.value = '';
    autoResize();
    const typingEl = addBubble('bot', '<span class="muted">正在识别并记账…</span>');
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, Accept: 'application/json' },
        body: JSON.stringify({ text, images }),
      });
      const data = await res.json().catch(() => ({}));
      typingEl.remove();
      if (!res.ok || !data.ok) {
        addBubble('bot error', esc(data.error || '识别失败'));
      } else {
        const engLabel = data.engine === 'llm' ? 'AI 模型' + (data.model ? ' · ' + data.model : '') : '内置规则引擎';
        let h = `<div class="tiny muted mb8">${esc(engLabel)}</div>`;
        for (const it of data.items || []) {
          const income = it.type === 'income';
          h += `<div class="ai-record"><div class="m"><b>${esc(it.merchant || it.note || '记账')}</b><span>${esc(it.category_path || it.category_name || '未分类')} · ${esc(it.txn_date)}</span></div><span class="amount ${income ? 'income' : 'expense'}">${income ? '+' : '-'}¥${(Number(it.amount_cents || 0) / 100).toFixed(2)}</span></div>`;
        }
        if (Array.isArray(data.warnings) && data.warnings.length) {
          h += `<div class="tiny mt8" style="color:var(--warn)">${data.warnings.map((w) => esc(w)).join('；')}</div>`;
        }
        const dupMsg = data.duplicates ? `（跳过重复 ${data.duplicates} 笔）` : '';
        h += `<div class="small muted mt8">已入库 ${data.created} 笔${dupMsg} · <a href="/transactions">查看明细 →</a></div>`;
        addBubble('bot', h);
      }
    } catch (e) {
      typingEl.remove();
      addBubble('bot error', '网络异常：' + esc(e.message));
    } finally {
      busy = false;
      sendBtn.disabled = false;
    }
  }
})();
