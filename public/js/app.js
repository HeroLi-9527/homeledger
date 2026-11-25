/* ============================================================
   家账簿 HomeLedger — 渐进增强脚本（无内联事件，严格遵循 CSP）
   ============================================================ */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const csrf = (document.querySelector('meta[name="csrf"]') || {}).content || '';
  const money = (cents) =>
    '¥' +
    (Math.abs(Number(cents) || 0) / 100).toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(message, type) {
    let box = $('#toast-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toast-box';
      box.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:200;display:flex;flex-direction:column;gap:8px;pointer-events:none';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = 'flash ' + (type || 'info');
    el.style.cssText = 'box-shadow:var(--shadow);margin:0;min-width:220px;max-width:90vw';
    el.innerHTML = '<span>' + esc(message) + '</span>';
    box.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 320);
    }, 3200);
  }
  window.hlToast = toast;

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('读取文件失败'));
      fr.readAsDataURL(file);
    });
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, Accept: 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const ct = res.headers.get('content-type') || '';
    if (res.redirected || ct.includes('text/html')) {
      return { ok: false, error: '登录已过期，请刷新页面重新登录' };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = { ok: false, error: '服务器返回异常（' + res.status + '）' };
    }
    if (!res.ok && !data.error) data.error = '请求失败（' + res.status + '）';
    return data;
  }

  /* ============================ 主题切换 ============================ */
  function initThemeToggle() {
    const btn = $('#theme-toggle-btn');
    if (!btn) return;
    const syncIcon = () => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      btn.textContent = dark ? '☀️' : '🌙';
      btn.title = dark ? '切换浅色模式' : '切换深色模式';
    };
    syncIcon();
    btn.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try {
        localStorage.setItem('hl_theme', next);
      } catch {}
      syncIcon();
      fetch('/theme/' + next, { method: 'POST', headers: { 'x-csrf-token': csrf } }).catch(() => {});
    });
  }

  /* ============================ 移动端侧栏 ============================ */
  function initMobileNav() {
    const toggle = $('#nav-toggle');
    const sb = $('.sidebar');
    const mask = $('#sidebar-backdrop');
    if (!toggle || !sb || !mask) return;
    const close = () => {
      sb.classList.remove('open');
      mask.classList.remove('open');
    };
    toggle.addEventListener('click', () => {
      sb.classList.toggle('open');
      mask.classList.toggle('open');
    });
    mask.addEventListener('click', close);
  }

  /* ============================ 记账表单 ============================ */
  function initTxnForm() {
    const form = $('#txn-form');
    if (!form) return;

    const applyType = (type) => {
      $$('[data-for-type]').forEach((el) => {
        const hidden = !el.dataset.forType.split(',').includes(type);
        el.classList.toggle('hidden', hidden);
        el.querySelectorAll('[name="to_account_id"], [name="to_account_amount"]').forEach((input) => {
          input.disabled = hidden;
        });
      });
      $$('[data-not-type]').forEach((el) => {
        el.classList.toggle('hidden', el.dataset.notType.split(',').includes(type));
      });
      const catWrap = $('#f-cat-wrap');
      if (catWrap) catWrap.classList.toggle('hidden', type === 'transfer' || type === 'adjust');
      const isIncome = ['income', 'interest', 'refund', 'reimburse'].includes(type);
      $$('.cat-kind, .cat-parents').forEach((el) => el.classList.toggle('hidden', el.dataset.catKind !== (isIncome ? 'income' : 'expense')));
      const accLabel = $('#acc-label');
      if (accLabel) {
        accLabel.textContent =
          type === 'expense'
            ? '支付账户'
            : type === 'income'
              ? '收款账户'
              : type === 'transfer'
                ? '转出账户'
                : type === 'lend'
                  ? '从哪个账户借出'
                  : type === 'borrow'
                    ? '收到哪个账户'
                    : type === 'repay_receive'
                      ? '收款账户'
                      : type === 'repay_pay'
                        ? '付款账户'
                        : type === 'invest_buy'
                          ? '资金账户'
                          : type === 'invest_sell'
                            ? '回款账户'
                            : '账户';
      }
    };

    $$('.type-tabs [data-type]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const type = btn.dataset.type;
        $('#f-type').value = type;
        $$('.type-tabs [data-type]').forEach((b) => b.classList.toggle('active', b === btn));
        $$('.chip[data-type]').forEach((b) => b.classList.remove('primary'));
        applyType(type);
      });
    });

    $$('.chip[data-type]').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.chip[data-type]').forEach((b) => b.classList.toggle('primary', b === btn));
        $$('.type-tabs [data-type]').forEach((b) => b.classList.remove('active'));
        const fType = $('#f-type');
        if (fType) fType.value = btn.dataset.type;
        applyType(btn.dataset.type);
      });
    });

    applyType($('#f-type')?.value || 'expense');

    // 金额快捷加减芯片
    const amt = $('#f-amount');
    $$('[data-amt-add]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!amt) return;
        const val = btn.dataset.amtAdd;
        if (val === 'clear') {
          amt.value = '';
          amt.focus();
          return;
        }
        const cur = parseFloat(amt.value || '0') || 0;
        amt.value = (cur + Number(val)).toFixed(2);
      });
    });

    // 分类芯片选择与一级分类快速跳转
    $$('.cat-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        $('#f-category').value = item.dataset.id;
        $$('.cat-item').forEach((i) => i.classList.toggle('selected', i === item));
        const hint = $('#cat-hint');
        if (hint) hint.textContent = item.dataset.path || item.dataset.name || '';
      });
    });
    $$('.cat-parent').forEach((btn) => {
      btn.addEventListener('click', () => {
        const bar = btn.closest('.cat-parents');
        if (bar) $$('.cat-parent', bar).forEach((b) => b.classList.toggle('active', b === btn));
        const target = document.getElementById(btn.dataset.target);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });

    // AA 分账行
    const splitWrap = $('#split-rows');
    const addSplit = $('#add-split');
    function bindSplitRow(row) {
      const del = $('.del-split', row);
      if (del) del.addEventListener('click', () => row.remove());
    }
    $$('.split-row', splitWrap).forEach(bindSplitRow);
    if (addSplit && splitWrap) {
      addSplit.addEventListener('click', (e) => {
        e.preventDefault();
        const row = document.createElement('div');
        row.className = 'row split-row mb8';
        row.innerHTML =
          '<input type="text" name="split_name" placeholder="成员" style="flex:1">' +
          '<input type="text" name="split_amount" placeholder="金额" inputmode="decimal" style="flex:1">' +
          '<button type="button" class="btn btn-sm btn-ghost del-split">✕</button>';
        splitWrap.appendChild(row);
        bindSplitRow(row);
      });
    }

    const avgBtn = $('#split-average');
    if (avgBtn) {
      avgBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const total = Math.round(parseFloat(($('#f-amount') || {}).value || '0') * 100);
        const rows = $$('.split-row', splitWrap);
        if (!rows.length || !total) return toast('请先填写金额并添加成员', 'warn');
        const per = Math.floor(total / rows.length);
        let rest = total - per * rows.length;
        rows.forEach((r) => {
          const inp = $('input[name="split_amount"]', r);
          if (inp) {
            const v = per + (rest > 0 ? 1 : 0);
            if (rest > 0) rest--;
            inp.value = (v / 100).toFixed(2);
          }
        });
      });
    }

    if (amt) {
      amt.addEventListener('input', () => {
        const t = ($('#f-type') || {}).value;
        amt.value =
          t === 'adjust'
            ? amt.value.replace(/[^\d.\-]/g, '').replace(/(?!^)-/g, '')
            : amt.value.replace(/[^\d.]/g, '');
      });
    }

    form.addEventListener('submit', () => {
      const btn = $('#submit-btn');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '保存中…';
      }
    });
  }

  /* ============================ AI 截图与文本记账 ============================ */
  function initAiPage() {
    const zone = $('#ai-dropzone');
    if (!zone) return;

    const input = $('#ai-file');
    const thumbs = $('#ai-thumbs');
    const state = { images: [] };
    let lastScanIds = [];

    function renderThumbs() {
      if (!thumbs) return;
      thumbs.innerHTML = state.images
        .map(
          (img, i) =>
            '<div class="thumb"><img src="' +
            img.dataUrl +
            '" alt=""><button type="button" data-i="' +
            i +
            '">✕</button></div>',
        )
        .join('');
      $$('button[data-i]', thumbs).forEach((b) =>
        b.addEventListener('click', () => {
          state.images.splice(Number(b.dataset.i), 1);
          renderThumbs();
        }),
      );
      const btn = $('#ai-scan-btn');
      if (btn) btn.disabled = state.images.length === 0 && !(($('#ai-text') || {}).value || '').trim();
    }

    async function addFiles(files) {
      for (const f of Array.prototype.slice.call(files)) {
        if (!/^image\//.test(f.type)) {
          toast('只支持图片文件：' + f.name, 'warn');
          continue;
        }
        if (f.size > 8 * 1024 * 1024) {
          toast('图片请小于 8MB：' + f.name, 'warn');
          continue;
        }
        if (state.images.length >= 6) {
          toast('一次最多 6 张截图', 'warn');
          break;
        }
        try {
          state.images.push({ dataUrl: await fileToDataUrl(f), name: f.name });
        } catch (e) {
          toast(e.message, 'error');
        }
      }
      renderThumbs();
    }

    zone.addEventListener('click', () => input && input.click());
    if (input)
      input.addEventListener('change', () => {
        addFiles(input.files);
        input.value = '';
      });
    ['dragenter', 'dragover'].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.add('dragover');
      }),
    );
    ['dragleave', 'drop'].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.remove('dragover');
      }),
    );
    zone.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });

    document.addEventListener('paste', (e) => {
      if (!e.clipboardData) return;
      const items = Array.prototype.slice.call(e.clipboardData.items || []);
      const files = items
        .filter((it) => it.kind === 'file')
        .map((it) => it.getAsFile())
        .filter(Boolean);
      if (files.length) {
        addFiles(files);
        toast('已粘贴 ' + files.length + ' 张截图');
      }
    });

    const textEl = $('#ai-text');
    if (textEl) textEl.addEventListener('input', renderThumbs);

    const scanBtn = $('#ai-scan-btn');
    const resultBox = $('#ai-result');

    if (scanBtn && resultBox) {
      scanBtn.addEventListener('click', async () => {
        const text = (textEl && textEl.value.trim()) || '';
        if (!state.images.length && !text) return toast('请上传截图或输入账单文字', 'warn');
        scanBtn.disabled = true;
        const oldLabel = scanBtn.textContent;
        scanBtn.textContent = '识别中…';
        resultBox.innerHTML = '<div class="card mt12"><span class="muted">AI 正在识别账单，请稍候…</span></div>';
        try {
          const data = await postJson('/ai/analyze', { images: state.images, text });
          if (!data.ok) throw new Error(data.error || '识别失败');
          lastScanIds = (data.images || []).map((i) => i.id);
          renderDrafts(data);
        } catch (e) {
          resultBox.innerHTML = '<div class="flash error mt12">识别失败：' + esc(e.message) + '</div>';
        } finally {
          scanBtn.disabled = false;
          scanBtn.textContent = oldLabel;
        }
      });
    }

    function renderDrafts(data, source) {
      if (!resultBox) return;
      const draftSource = source || 'ai_screenshot';
      const engines = { llm: 'AI 视觉模型', rule: '内置规则引擎' };
      let html = '<div class="mt12">';
      html +=
        '<div class="row between mb12"><h3>识别草稿队列（' +
        data.items.length +
        ' 笔）</h3><span class="chip primary">' +
        esc(engines[data.engine] || data.engine) +
        (data.model ? ' · ' + esc(data.model) : '') +
        '</span></div>';
      (data.warnings || []).forEach((w) => {
        html += '<div class="flash warn">' + esc(w) + '</div>';
      });
      if (!data.items.length) {
        html +=
          '<div class="card"><div class="empty">没有识别出可记账的交易，请换张截图或直接输入「午饭 35 元」。</div></div></div>';
        resultBox.innerHTML = html;
        return;
      }
      html += '<form id="ai-confirm-form">';
      data.items.forEach((it, i) => {
        const conf = Number(it.confidence) || 0;
        const cls = conf >= 0.8 ? 'high' : conf >= 0.5 ? 'mid' : 'low';
        html +=
          '<div class="draft" data-i="' +
          i +
          '">' +
          '<div class="draft-head">' +
          '<span class="chip ' +
          (it.type === 'income' ? 'income' : 'expense') +
          '">' +
          (it.type === 'income' ? '收入' : it.type === 'transfer' ? '转账' : '支出') +
          '</span>' +
          '<span class="chip">' +
          esc(it.category_path || it.category_name || '未分类') +
          '</span>' +
          '<span class="confidence ' +
          cls +
          '">置信度 ' +
          Math.round(conf * 100) +
          '%</span>' +
          '<span class="spacer"></span>' +
          '<button type="button" class="btn btn-sm btn-ghost draft-del">移除</button>' +
          '</div>' +
          '<div class="draft-grid">' +
          '<div class="field"><label>金额</label><input type="text" inputmode="decimal" class="d-amount" value="' +
          (it.amount_cents / 100).toFixed(2) +
          '"></div>' +
          '<div class="field"><label>币种</label><input type="text" maxlength="6" class="d-currency" value="' +
          esc((it.currency || 'CNY').toUpperCase()) +
          '"></div>' +
          '<div class="field"><label>日期</label><input type="date" class="d-date" value="' +
          esc(it.txn_date) +
          '"></div>' +
          '<div class="field d-type-wrap"><label>类型</label><select class="d-type">' +
          ['expense', 'income', 'transfer']
            .map(
              (t) =>
                '<option value="' +
                t +
                '"' +
                (t === it.type ? ' selected' : '') +
                '>' +
                { expense: '支出', income: '收入', transfer: '转账' }[t] +
                '</option>',
            )
            .join('') +
          '</select></div>' +
          '<div class="field"><label>分类</label><select class="d-category"></select></div>' +
          '<div class="field"><label>账户</label><select class="d-account"></select></div>' +
          '<div class="field d-to-account-wrap' +
          (it.type === 'transfer' ? '' : ' hidden') +
          '"><label>转入账户</label><select class="d-to-account"></select></div>' +
          '<div class="field"><label>商家 / 备注</label><input type="text" class="d-note" value="' +
          esc((it.merchant || '') + (it.note && it.note !== it.merchant ? ' ' + it.note : '')) +
          '"></div>' +
          '</div>' +
          '</div>';
      });
      html +=
        '<div class="row mt12"><button type="submit" class="btn btn-primary btn-block" id="ai-save">一键确认全部入库（' +
        data.items.length +
        ' 笔）</button>' +
        '<button type="button" class="btn btn-ghost" id="ai-clear">清空</button></div>' +
        '<div class="muted small mt8" id="ai-save-hint"></div></form></div>';
      resultBox.innerHTML = html;

      const cfg = window.__AI_FORM__ || { categories: [], accounts: [] };
      $$('.draft', resultBox).forEach((card) => {
        const it = data.items[Number(card.dataset.i)];
        const catSel = $('.d-category', card);
        const accSel = $('.d-account', card);
        const toAccSel = $('.d-to-account', card);
        const toAccWrap = $('.d-to-account-wrap', card);
        const kind = it.type === 'income' ? 'income' : 'expense';
        catSel.innerHTML =
          '<option value="">未分类</option>' +
          cfg.categories
            .filter((c) => c.kind === kind)
            .map(
              (c) =>
                '<option value="' +
                c.id +
                '"' +
                (Number(c.id) === Number(it.category_id) ? ' selected' : '') +
                '>' +
                esc(c.path) +
                '</option>',
            )
            .join('');
        accSel.innerHTML =
          '<option value="">未指定</option>' +
          cfg.accounts
            .map(
              (a) =>
                '<option value="' +
                a.id +
                '"' +
                (Number(a.id) === Number(it.account_id) ? ' selected' : '') +
                '>' +
                esc((a.icon || '') + ' ' + a.name) +
                '</option>',
            )
            .join('');
        if (toAccSel)
          toAccSel.innerHTML =
            '<option value="">未指定</option>' +
            cfg.accounts.map((a) => '<option value="' + a.id + '">' + esc((a.icon || '') + ' ' + a.name) + '</option>').join('');
        $('.d-type', card).addEventListener('change', (e) => {
          const k = e.target.value === 'income' ? 'income' : 'expense';
          catSel.innerHTML =
            '<option value="">未分类</option>' +
            cfg.categories
              .filter((c) => c.kind === k)
              .map((c) => '<option value="' + c.id + '">' + esc(c.path) + '</option>')
              .join('');
          if (toAccWrap) toAccWrap.classList.toggle('hidden', e.target.value !== 'transfer');
          if (toAccSel && e.target.value !== 'transfer') toAccSel.value = '';
        });
        $('.draft-del', card).addEventListener('click', () => card.remove());
      });

      const clearBtn = $('#ai-clear');
      if (clearBtn)
        clearBtn.addEventListener('click', () => {
          resultBox.innerHTML = '';
          state.images = [];
          if (thumbs) thumbs.innerHTML = '';
          if (textEl) textEl.value = '';
        });

      const confirmForm = $('#ai-confirm-form');
      confirmForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const items = $$('.draft', resultBox)
          .map((card) => {
            const draft = data.items[Number(card.dataset.i)] || {};
            const curEl = $('.d-currency', card);
            const currency = String((curEl && curEl.value) || draft.currency || 'CNY')
              .trim()
              .toUpperCase()
              .slice(0, 8) || 'CNY';
            return {
              type: $('.d-type', card).value,
              amount_cents: parseYuanToCents($('.d-amount', card).value),
              currency,
              txn_date: $('.d-date', card).value,
              category_id: $('.d-category', card).value || null,
              account_id: ($('.d-type', card).value === 'transfer' ? ($('.d-account', card) || {}).value : $('.d-account', card).value) || null,
              to_account_id: ($('.d-type', card).value === 'transfer' ? ($('.d-to-account', card) || {}).value : null) || null,
              note: $('.d-note', card).value,
              merchant: $('.d-note', card).value,
              draft_id: draft.draft_id || null,
            };
          })
          .filter((it) => it.amount_cents > 0);
        if (!items.length) return toast('请至少保留一笔有效金额', 'warn');
        const saveBtn = $('#ai-save');
        saveBtn.disabled = true;
        saveBtn.textContent = '入库中…';
        const res = await postJson('/ai/confirm', { items, image_ids: lastScanIds, source: draftSource });
        if (res.ok) {
          if (res.errors && res.errors.length) {
            toast('已保存 ' + res.created + ' 笔，' + res.errors.length + ' 笔失败', 'warn');
            const hint = $('#ai-save-hint');
            if (hint) {
              hint.textContent = '以下 ' + res.errors.length + ' 笔保存失败：' + res.errors.join('；');
              hint.style.color = 'var(--expense)';
            }
            saveBtn.disabled = false;
            saveBtn.textContent = '重试保存';
          } else {
            toast('已保存 ' + res.created + ' 笔' + (res.duplicates ? '，重复跳过 ' + res.duplicates + ' 笔' : ''), 'success');
            lastScanIds = [];
            setTimeout(() => {
              window.location.href = '/transactions';
            }, 700);
          }
        } else {
          toast('保存失败：' + (res.error || (res.errors || []).join('；')), 'error');
          saveBtn.disabled = false;
          saveBtn.textContent = '确认入库';
        }
      });

      const canAutoSave =
        data.autoSave &&
        data.items.length > 0 &&
        $$('.draft', resultBox).every((card) => {
          const amtVal = parseYuanToCents($('.d-amount', card).value);
          const t = $('.d-type', card).value;
          const aId = $('.d-account', card).value;
          const toId = ($('.d-to-account', card) || {}).value;
          if (!(amtVal > 0) || !aId) return false;
          if (t === 'transfer' && !toId) return false;
          return true;
        });
      if (canAutoSave) {
        toast('已开启自动入库，正在保存…', 'info');
        if (confirmForm.requestSubmit) confirmForm.requestSubmit();
        else $('#ai-save').click();
      }
    }

    const quickBtn = $('#ai-text-quick');
    if (quickBtn) {
      quickBtn.addEventListener('click', async () => {
        const text = ($('#ai-quick-text') || {}).value || '';
        if (!text.trim()) return toast('请输入一句话，如「午饭 35 元」', 'warn');
        quickBtn.disabled = true;
        const res = await postJson('/api/ai/text', { text });
        quickBtn.disabled = false;
        if (!res.ok) return toast('识别失败：' + res.error, 'error');
        if (!res.items.length) return toast('未识别出金额，请换个说法', 'warn');
        lastScanIds = [];
        renderDrafts({ items: res.items, engine: res.engine, model: res.model, autoSave: res.autoSave, warnings: res.warnings || [] }, 'ai_text');
      });
    }

    renderThumbs();
  }

  /* ============================ 账单导入 ============================ */
  function initImportPage() {
    const zone = $('#import-dropzone');
    if (!zone) return;
    const input = $('#import-file');
    const preview = $('#import-preview');
    const state = { token: null };

    async function handle(file) {
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) return toast('文件请小于 20MB', 'warn');
      preview.innerHTML = '<div class="card mt12"><span class="muted">正在解析账单文件…</span></div>';
      try {
        const dataUrl = await fileToDataUrl(file);
        const res = await postJson('/api/import/preview', { dataUrl, fileName: file.name });
        if (!res.ok) throw new Error(res.error);
        state.token = res.token;
        renderPreview(res);
      } catch (e) {
        preview.innerHTML = '<div class="flash error mt12">解析失败：' + esc(e.message) + '</div>';
      }
    }

    function renderPreview(res) {
      let html = '<div class="card mt16">';
      html +=
        '<div class="card-head"><b>解析预览</b><span class="chip primary">' +
        esc(res.sourceLabel) +
        '</span><span class="chip">编码 ' +
        esc(res.encoding) +
        '</span><span class="chip">共 ' +
        res.count +
        ' 条</span></div>';
      if (res.skipped > 0) {
        html +=
          '<div class="flash warn mb12"><span>已自动跳过 ' +
          res.skipped +
          ' 条无效、已关闭或退款记录' +
          (res.skippedDates ? '（含 ' + res.skippedDates + ' 条无有效日期）' : '') +
          '。</span></div>';
      }
      html +=
        '<div class="kpi-grid mb16">' +
        '<div class="stat"><div class="label">支出合计</div><div class="value amount expense">' +
        money(res.stat.expense) +
        '</div></div>' +
        '<div class="stat"><div class="label">收入合计</div><div class="value amount income">' +
        money(res.stat.income) +
        '</div></div>' +
        '<div class="stat"><div class="label">转账合计</div><div class="value amount neutral">' +
        money(res.stat.transfer) +
        '</div></div>' +
        '<div class="stat"><div class="label">时间范围</div><div class="value small">' +
        esc(res.stat.minDate || '—') +
        ' ~ ' +
        esc(res.stat.maxDate || '—') +
        '</div></div></div>';
      html +=
        '<div class="row mb12 wrap">' + (res.source === 'homeledger' ? '' : '<label class="check"><input type="checkbox" id="imp-auto-acc" checked> 自动创建缺失的支付账户</label>') +
        (res.neutralCount
          ? '<label class="check"><input type="checkbox" id="imp-include-neutral"> 一并导入 ' +
            res.neutralCount +
            ' 条「不计收支」转账</label>'
          : '') +
        '<span class="spacer"></span><button class="btn btn-primary" id="imp-commit">确认导入 ' +
        res.count +
        ' 条</button></div>';
      html +=
        '<div class="scroll-x"><table class="table"><thead><tr><th>日期</th><th>类型</th><th class="num">金额</th><th>商家/说明</th><th>建议分类</th><th>账户</th></tr></thead><tbody>';
      res.sample.slice(0, 60).forEach((r) => {
        const accCell = r.native
          ? '<td class="small muted">' + esc((r.account_hint || '—') + (r.native.toName ? ' → ' + r.native.toName : '')) + '</td>'
          : r.guess_account_missing
          ? '<td class="small imp-warn">缺失（将用默认账户）</td>'
          : '<td class="small muted">' + esc(r.guess_account || r.account_hint || '—') + '</td>';
        html +=
          '<tr><td>' +
          esc(r.txn_date) +
          '</td><td><span class="chip">' +
          esc(r.type_label) +
          '</span></td><td class="num amount">' +
          (r.native ? esc(r.native.currency) + ' ' + (r.amount_cents / 100).toFixed(2) : money(r.amount_cents)) +
          '</td><td>' +
          esc(r.merchant || r.note || '—') +
          '</td><td class="small muted">' +
          esc(r.guess_category || r.category_hint || '—') +
          '</td>' +
          accCell +
          '</tr>';
      });
      html += '</tbody></table></div>';
      if (res.neutralCount && Array.isArray(res.neutralSample) && res.neutralSample.length) {
        html +=
          '<div class="notice mt12"><b>发现 ' +
          res.neutralCount +
          ' 条「不计收支」记录（如余额宝转入、信用卡还款）</b>：默认跳过以免重复统计收支，勾选上方复选框可作为转账记录导入（前 ' +
          res.neutralSample.length +
          ' 条示例）：</div>' +
          '<div class="scroll-x mt8"><table class="table"><thead><tr><th>日期</th><th class="num">金额</th><th>商家/说明</th><th>账户</th></tr></thead><tbody>';
        res.neutralSample.forEach((nr) => {
          html +=
            '<tr><td>' +
            esc(nr.txn_date) +
            '</td><td class="num amount">' +
            money(nr.amount_cents) +
            '</td><td>' +
            esc(nr.merchant || nr.note || '—') +
            '</td><td class="small ' +
            (nr.guess_account_missing ? 'imp-warn' : 'muted') +
            '">' +
            (nr.guess_account_missing ? '缺失（将用默认账户）' : esc(nr.guess_account || nr.account_hint || '—')) +
            '</td></tr>';
        });
        html += '</tbody></table></div>';
      }
      html += '<div id="import-commit-result" class="mt12"></div></div>';
      preview.innerHTML = html;

      const neutralChk = $('#imp-include-neutral');
      const commitBtn = $('#imp-commit');
      if (neutralChk && commitBtn) {
        neutralChk.addEventListener('change', () => {
          const total = Number(res.count || 0) + (neutralChk.checked ? Number(res.neutralCount || 0) : 0);
          commitBtn.textContent = '确认导入 ' + total + ' 条';
        });
      }

      commitBtn.addEventListener('click', async () => {
        commitBtn.disabled = true;
        commitBtn.textContent = '导入中…';
        const defAccEl = $('#imp-default-acc');
        const r = await postJson('/api/import/commit', {
          token: state.token,
          auto_create_account: $('#imp-auto-acc')?.checked ?? false,
          include_neutral: !!(neutralChk && neutralChk.checked),
          default_account_id: defAccEl && defAccEl.value ? Number(defAccEl.value) : null,
        });
        const resBox = $('#import-commit-result');
        if (r.ok) {
          toast('成功导入 ' + r.imported + ' 条，跳过重复 ' + r.skipped + ' 条', r.failed ? 'warn' : 'success');
          if (!r.failed) {
            setTimeout(() => (window.location.href = '/transactions'), 800);
          } else {
            commitBtn.disabled = false;
            commitBtn.textContent = '已完成（部分失败 ' + r.failed + ' 条）';
            const list = (r.failuresAll || r.failures || []);
            if (resBox) {
              let fh =
                '<div class="flash warn"><span>已导入 ' +
                r.imported +
                ' 条，跳过 ' +
                r.skipped +
                ' 条，失败 ' +
                r.failed +
                ' 条。' +
                (r.jobId ? ' <a href="/import/failures/' + r.jobId + '" class="bold">下载失败清单 →</a>' : '') +
                '</span></div>';
              if (list.length) {
                fh +=
                  '<div class="scroll-x"><table class="table"><thead><tr><th>行号/序号</th><th>商家</th><th>失败原因</th></tr></thead><tbody>' +
                  list
                    .slice(0, 50)
                    .map(
                      (f) =>
                        '<tr><td>' +
                        esc(f.line ? '第 ' + f.line + ' 行' : '第 ' + (Number(f.index || 0) + 1) + ' 条') +
                        '</td><td>' +
                        esc(f.merchant || '—') +
                        '</td><td class="imp-warn">' +
                        esc(f.error) +
                        '</td></tr>',
                    )
                    .join('') +
                  '</tbody></table></div>';
              }
              resBox.innerHTML = fh;
            }
          }
        } else {
          toast('导入失败：' + r.error, 'error');
          commitBtn.disabled = false;
          commitBtn.textContent = '重试导入';
        }
      });
    }

    zone.addEventListener('click', () => input && input.click());
    if (input)
      input.addEventListener('change', () => {
        handle(input.files[0]);
        input.value = '';
      });
    ['dragenter', 'dragover'].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.add('dragover');
      }),
    );
    ['dragleave', 'drop'].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.remove('dragover');
      }),
    );
    zone.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]);
    });
  }

  /* ============================ 设置页与恢复 ============================ */
  function initSettings() {
    const testBtn = $('#ai-test-btn');
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        const out = $('#ai-test-result');
        testBtn.disabled = true;
        out.textContent = '正在测试连接…';
        const res = await postJson('/settings/ai/test', {
          base_url: ($('#ai-base-url') || {}).value,
          model: ($('#ai-model') || {}).value,
          api_key: ($('#ai-api-key') || {}).value,
        });
        testBtn.disabled = false;
        out.textContent = res.ok ? '✅ 连接成功：' + (res.raw || '') : '❌ 连接失败：' + res.error;
      });
    }

    const modelsBtn = $('#ai-models-btn');
    if (modelsBtn) {
      const sel = $('#ai-model-select');
      const modelInput = $('#ai-model');
      const out = $('#ai-models-result');
      modelsBtn.addEventListener('click', async () => {
        modelsBtn.disabled = true;
        out.textContent = '正在读取模型列表…';
        const res = await postJson('/settings/ai/models', {
          base_url: ($('#ai-base-url') || {}).value,
          api_key: ($('#ai-api-key') || {}).value,
        });
        modelsBtn.disabled = false;
        if (!res.ok) {
          out.textContent = '❌ ' + res.error;
          return;
        }
        sel.textContent = '';
        res.models.forEach((m) => {
          const o = document.createElement('option');
          o.value = m.id;
          o.dataset.vision = m.vision === true ? '1' : m.vision === false ? '0' : '';
          o.textContent = m.id + (m.vision === true ? ' ✅ 可读图' : '');
          sel.appendChild(o);
        });
        sel.classList.remove('hidden');
        out.textContent = '✅ 已读取 ' + res.models.length + ' 个模型';
      });
      sel.addEventListener('change', () => {
        const opt = sel.options[sel.selectedIndex];
        if (sel.value && modelInput) modelInput.value = sel.value;
        const visChk = $('input[name="ai.vision"]');
        if (visChk && opt && (opt.dataset.vision === '1' || opt.dataset.vision === '0')) {
          visChk.checked = opt.dataset.vision === '1';
          if (out) {
            out.textContent =
              '已选用 ' + sel.value + (visChk.checked ? '（已自动勾选「支持视觉识图」）' : '（已自动取消「支持视觉识图」）');
          }
        }
      });
    }

    const ledgerImport = $('#ledger-import-form');
    if (ledgerImport) {
      ledgerImport.addEventListener('submit', async (event) => {
        event.preventDefault();
        const file = $('#ledger-import-file').files[0];
        if (!file) return;
        const submit = $('button[type="submit"]', ledgerImport);
        submit.disabled = true;
        try {
          const result = await postJson('/ledgers/import', { dataUrl: await fileToDataUrl(file) });
          if (!result.ok) throw new Error(result.error);
          window.location.href = '/ledgers';
        } catch (error) {
          toast(error.message, 'error');
          submit.disabled = false;
        }
      });
    }

    const restoreInput = $('#restore-file');
    if (restoreInput) {
      restoreInput.addEventListener('change', async () => {
        const f = restoreInput.files[0];
        if (!f) return;
        if (!confirm('确定要用该备份覆盖当前全部数据吗？恢复前请确保你已手工导出当前 JSON 备份！')) {
          restoreInput.value = '';
          return;
        }
        const dataUrl = await fileToDataUrl(f);
        const res = await postJson('/backup/restore', { dataUrl });
        toast(res.ok ? '备份已恢复，请重新登录' : '恢复失败：' + res.error, res.ok ? 'success' : 'error');
        restoreInput.value = '';
        if (res.ok) setTimeout(() => (window.location.href = '/login?notice=restored'), 900);
      });
    }
  }

  /* ============================ 批量勾选与交互 ============================ */
  function initBulk() {
    const master = $('#bulk-all');
    if (!master || !$$('.bulk-item').length) return;
    const bar = $('#bulk-bar');
    const update = () => {
      const boxes = $$('.bulk-item:not(:disabled)');
      const n = boxes.filter((b) => b.checked).length;
      if (bar) {
        bar.classList.toggle('hidden', n === 0);
        const cnt = $('#bulk-count');
        if (cnt) cnt.textContent = String(n);
      }
      master.indeterminate = n > 0 && n < boxes.length;
      master.checked = n === boxes.length && n > 0;
    };
    master.addEventListener('change', () => {
      $$('.bulk-item:not(:disabled)').forEach((b) => (b.checked = master.checked));
      update();
    });
    $$('.bulk-item').forEach((b) => b.addEventListener('change', update));
    window.hlRefreshBulk = update;
  }

  function initConfirm() {
    $$('form[data-confirm]').forEach((f) => {
      f.addEventListener('submit', (e) => {
        if (!confirm(f.dataset.confirm)) e.preventDefault();
      });
    });
    $$('select[data-autosubmit]').forEach((s) => {
      s.addEventListener('change', () => s.form && s.form.submit());
    });
    $$('form[data-require-trial-end]').forEach((f) => {
      f.addEventListener('submit', (e) => {
        const status = f.querySelector('[name="status"]');
        const end = f.querySelector('[name="trial_ends_on"]');
        if (status && status.value === 'trial' && end && !end.value) {
          alert('试用中必须填写试用结束日');
          e.preventDefault();
        }
      });
    });
  }

  function initListActions() {
    $$('[data-del-txn]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!confirm('删除这笔记录？')) return;
        const res = await postJson('/transactions/' + btn.dataset.delTxn + '/delete', { _json: '1' });
        if (res.ok) {
          const row = btn.closest('.txn');
          if (row) row.remove();
          if (window.hlRefreshBulk) window.hlRefreshBulk();
          toast('已删除', 'success');
        } else {
          toast(res.error || '删除失败', 'error');
        }
      });
    });
  }

  function initUserMenu() {
    const btn = $('#userMenuBtn');
    const drop = $('#userMenuDrop');
    if (!btn || !drop) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      drop.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!drop.classList.contains('hidden') && !drop.contains(e.target)) drop.classList.add('hidden');
    });
  }

  function initAvatarUpload() {
    async function uploadAvatarFile(fileInput) {
      const f = fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) return toast('头像请小于 2MB', 'warn');
      const res = await postJson('/settings/avatar', { dataUrl: await fileToDataUrl(f) });
      if (res.ok) {
        toast('头像已更新', 'success');
        setTimeout(() => window.location.reload(), 600);
      } else {
        toast(res.error || '上传失败', 'error');
      }
    }
    const bindPair = (btnId, inputId) => {
      const btn = $(btnId);
      const inp = $(inputId);
      if (!btn || !inp) return;
      btn.addEventListener('click', () => inp.click());
      inp.addEventListener('change', () => uploadAvatarFile(inp));
    };
    bindPair('#avatarPick', '#avatarFile');
    bindPair('#userMenuAvatar', '#userAvatarFile');

    const clearBtn = $('#avatarClear');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        const res = await postJson('/settings/avatar/clear', {});
        if (res.ok) {
          toast('已恢复默认头像', 'success');
          setTimeout(() => window.location.reload(), 600);
        }
      });
    }
  }

  function initLightbox() {
    let overlay = null;
    const close = () => {
      if (overlay) {
        overlay.remove();
        overlay = null;
      }
    };
    document.addEventListener('click', (e) => {
      const img = e.target && e.target.closest ? e.target.closest('img[data-zoom]') : null;
      if (!img) return;
      e.preventDefault();
      close();
      overlay = document.createElement('div');
      overlay.className = 'hl-lightbox';
      const big = document.createElement('img');
      big.src = img.currentSrc || img.src;
      big.alt = img.alt || '';
      overlay.appendChild(big);
      overlay.addEventListener('click', close);
      document.body.appendChild(overlay);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
  }

  function initSidebar() {
    const sb = $('.sidebar');
    if (!sb) return;
    try {
      const saved = sessionStorage.getItem('hl_sidebar_scroll');
      if (saved !== null) {
        sb.scrollTop = Number(saved) || 0;
      } else {
        const active = $('.nav-item.active', sb);
        if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
      }
      sb.addEventListener('scroll', () => {
        try {
          sessionStorage.setItem('hl_sidebar_scroll', String(sb.scrollTop));
        } catch {}
      });
    } catch {}
  }

  function parseYuanToCents(input) {
    if (input === null || input === undefined) return 0;
    const s = String(input).trim().replace(/[¥$€£,\s元块圆]/g, '');
    if (!/^-?\d{1,12}(\.\d{0,4})?$/.test(s)) return 0;
    const neg = s.startsWith('-');
    const parts = (neg ? s.slice(1) : s).split('.');
    const ip = parts[0] || '0';
    const fp = parts[1] || '';
    let cents = Number(ip) * 100 + Number((fp + '00').slice(0, 2));
    if (fp.length > 2 && Number(fp[2]) >= 5) cents += 1;
    return neg ? -cents : cents;
  }

  function initNumberInputs() {
    document.addEventListener('focusout', (e) => {
      const el = e.target;
      if (!el || el.tagName !== 'INPUT' || el.getAttribute('inputmode') !== 'decimal') return;
      const name = String(el.name || '');
      if (el.hasAttribute('data-no-money-format') || name === 'rate' || /^rate_/.test(name)) return;
      const raw = String(el.value || '').trim();
      if (!raw) return;
      if (!/^-?\d{1,12}(\.\d{0,4})?$/.test(raw)) return;
      const cents = parseYuanToCents(raw);
      if (Math.abs(cents) / 100 < 1e12) {
        el.value = (cents < 0 ? '-' : '') + (Math.abs(cents) / 100).toFixed(2);
      }
    });
  }

  /* ============================ 账户与次卡表单 ============================ */
  function initAccountForms() {
    $$('form[data-account-form]').forEach((form) => {
      const typeSel = $('select[name="type"]', form);
      const creditBox = $('[data-credit-fields]', form);
      const balLabel = $('[data-balance-label]', form);
      const sync = () => {
        if (!typeSel) return;
        const isCredit = ['credit', 'payable', 'loan'].includes(typeSel.value);
        if (creditBox) creditBox.classList.toggle('hidden', !isCredit);
        if (balLabel) balLabel.textContent = isCredit ? '当前待还金额（元，正数录入，无欠款填 0）' : '初始余额（元）';
      };
      sync();
      if (typeSel) typeSel.addEventListener('change', sync);
    });

    $$('[data-credit-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const form = $('form[data-account-form]');
        if (!form) return;
        const typeSel = $('select[name="type"]', form);
        const nameIn = $('input[name="name"]', form);
        const iconIn = $('input[name="icon"]', form);
        const instIn = $('input[name="institution"]', form);
        if (typeSel) {
          typeSel.value = 'credit';
          typeSel.dispatchEvent(new Event('change'));
        }
        if (nameIn) nameIn.value = btn.dataset.name || '';
        if (iconIn) iconIn.value = btn.dataset.icon || '💳';
        if (instIn) instIn.value = btn.dataset.inst || '';
        if (nameIn) nameIn.focus();
      });
    });

    $$('form[data-session-card-form]').forEach((form) => {
      const chk = $('input[name="record_expense"]', form);
      const box = $('[data-sc-expense-fields]', form);
      const sync = () => {
        if (box && chk) box.classList.toggle('hidden', !chk.checked);
      };
      sync();
      if (chk) chk.addEventListener('change', sync);
    });
  }

  /* ============================ 交易编辑页附件与周期账单动态行 ============================ */
  function initTxnAttachments() {
    const zone = $('#txn-att-dropzone');
    if (!zone) return;
    const txnId = Number(zone.dataset.txnId || 0);
    const existing = Number(zone.dataset.existing || 0);
    const maxCount = Number(zone.dataset.max || 6);
    const input = $('#txn-att-file');
    const form = $('#txn-att-form');
    if (!txnId) return;

    async function uploadFiles(files) {
      const list = Array.prototype.slice.call(files || []);
      if (!list.length) return;
      const quota = Math.max(0, maxCount - existing);
      if (quota <= 0) return toast('已达单笔流水最多 ' + maxCount + ' 个附件上限', 'warn');
      if (list.length > quota) return toast('当前最多还能补传 ' + quota + ' 张图片', 'warn');
      const images = [];
      for (const f of list) {
        if (!/^image\//.test(f.type)) {
          toast('只支持图片文件：' + f.name, 'warn');
          return;
        }
        if (f.size > 8 * 1024 * 1024) {
          toast('单张图片请小于 8MB：' + f.name, 'warn');
          return;
        }
        images.push({ dataUrl: await fileToDataUrl(f), name: f.name });
      }
      const btn = $('#txn-att-submit');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '上传中…';
      }
      const res = await postJson('/transactions/' + txnId + '/attachments', { images });
      if (res.ok) {
        toast('已上传 ' + images.length + ' 个附件', 'success');
        setTimeout(() => window.location.reload(), 400);
      } else {
        toast(res.error || '上传失败', 'error');
        if (btn) {
          btn.disabled = false;
          btn.textContent = '补传附件';
        }
      }
    }

    zone.addEventListener('click', () => input && input.click());
    if (input) {
      input.addEventListener('change', () => {
        if (input.files && input.files.length) uploadFiles(input.files);
      });
    }
    ['dragenter', 'dragover'].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.add('dragover');
      }),
    );
    ['dragleave', 'drop'].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.remove('dragover');
      }),
    );
    zone.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files);
    });
    document.addEventListener('paste', (e) => {
      if (!e.clipboardData) return;
      const items = Array.prototype.slice.call(e.clipboardData.items || []);
      const files = items.filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
      if (files.length) uploadFiles(files);
    });
    if (form) {
      form.addEventListener('submit', (e) => {
        if (!input || !input.files || !input.files.length) {
          e.preventDefault();
          toast('请先选择图片', 'warn');
        }
      });
    }
  }

  function initRecurringForm() {
    $$('form[data-recurring-form]').forEach((form) => {
      const box = $('[data-rec-items]', form);
      const addBtn = $('[data-add-rec-item]', form);
      if (!box) return;
      const bindDel = (row) => {
        const del = $('.del-rec-item', row);
        if (del) {
          del.addEventListener('click', () => {
            if ($$('.recurring-item-row', box).length <= 1) {
              $$('input', row).forEach((inp) => (inp.value = ''));
              return;
            }
            row.remove();
          });
        }
      };
      $$('.recurring-item-row', box).forEach(bindDel);
      if (addBtn) {
        addBtn.addEventListener('click', () => {
          const tpl = $('.recurring-item-row', box);
          if (!tpl) return;
          const clone = tpl.cloneNode(true);
          $$('input', clone).forEach((inp) => (inp.value = ''));
          $$('select', clone).forEach((sel) => {
            sel.value = sel.name === 'item_type' ? 'expense' : '';
          });
          box.appendChild(clone);
          bindDel(clone);
        });
      }
    });
  }

  function initSubscriptionPresets() {
    const form = document.querySelector('form[action="/subscriptions"]');
    if (!form) return;
    $$('[data-sub-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        let p = null;
        try {
          p = JSON.parse(btn.dataset.subPreset || 'null');
        } catch {
          p = null;
        }
        if (!p) return;
        const set = (name, val) => {
          const el = form.querySelector(`[name="${name}"]`);
          if (el && val !== undefined) el.value = String(val);
        };
        set('name', p.name);
        set('icon', p.icon);
        set('amount', p.amount);
        set('currency', p.currency);
        set('cycle', p.cycle);
        set('plan', p.plan || '');
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initThemeToggle();
    initMobileNav();
    initSidebar();
    initUserMenu();
    initAvatarUpload();
    initLightbox();
    initNumberInputs();
    initTxnForm();
    initTxnAttachments();
    initRecurringForm();
    initAccountForms();
    initSubscriptionPresets();
    initAiPage();
    initImportPage();
    initSettings();
    initBulk();
    initConfirm();
    initListActions();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  });
})();
