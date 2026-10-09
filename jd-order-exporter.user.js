// ==UserScript==
// @name         京东订单导出（本地 · 2026 新版页面适配）
// @namespace    https://github.com/jd-order-exporter
// @version      1.0.0
// @description  在京东「我的订单」页面抓取订单并导出 CSV。适配 2026 年改版后的前端渲染页面，支持自动翻页、跨年份累积、按订单号去重。数据只留在本地，不上传任何服务器。
// @author       -
// @match        https://order.jd.com/center/list.action*
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='18' fill='%23d92d20'/%3E%3Ctext x='50' y='70' font-size='56' text-anchor='middle' fill='white' font-family='sans-serif'%3EJD%3C/text%3E%3C/svg%3E
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* ============================================================
   背景
   ------------------------------------------------------------
   京东在 2026 年改版了「我的订单」页面：订单不再由服务端渲染进 HTML，
   而是页面加载后由前端 JS 动态填充。
   所以任何「请求 HTML → 解析 DOM」的老脚本（含早期浏览器扩展）都会抓到空数据。

   本脚本改为【在渲染完成的页面上直接读取订单卡片】，并靠 class 前缀模糊匹配
   （[class*="orderCard-"] 之类）抗住京东每次构建变化的 hash 后缀。

   用法
   ------------------------------------------------------------
     1. 安装 Tampermonkey / Violentmonkey
     2. 安装本脚本
     3. 打开 https://order.jd.com/center/list.action （确认已登录、能看到订单）
     4. 页面右下角会出现控制面板 → 先手动筛好年份，再点「抓取当前页」
     5. 切换年份重复第 4 步；面板上的「导出累积全量」随时可导出
   ============================================================ */

(function () {
  'use strict';

  const KEY = '__jd_orders_accum_v1';
  const MAX_PAGES = 200;    // 单次最多翻多少页
  const WAIT_MS = 8000;     // 翻页后等待新内容的时间上限
  const CARD = '[class*="orderCard-"]';

  let running = false;

  const txt = (el) => el
    ? String((el.getAttribute && el.getAttribute('title')) || el.innerText || '').trim()
    : '';

  // ---------------- 解析单张订单卡片 ----------------
  function parseCard(card) {
    const metas = card.querySelector('[class*="orderMetas-"]');
    let orderId = metas ? txt(metas.querySelector('[class*="metaValue-"]')) : '';
    if (!orderId) {
      const m = (card.innerText || '').match(/\d{10,}/);
      orderId = m ? m[0] : '';
    }

    const items = [...card.querySelectorAll('[class*="productItem-"]')].map((it) => ({
      name: txt(it.querySelector('[class*="productTitle-"]')),
      qty: txt(it.querySelector('[class*="countNum-"]'))
    }));

    const pi = card.querySelector('[class*="priceInteger-"]');
    const pd = card.querySelector('[class*="priceDecimal-"]');
    const amount = pi ? (txt(pi) + (pd ? txt(pd) : '')) : '';

    const user = txt(card.querySelector('[class*="userName-"]'));
    let addr = '';
    const dg = card.querySelector('[class*="deliveryTextGroup-"]');
    if (dg) addr = (dg.innerText || '').replace(user, '').trim();

    return {
      订单号: orderId,
      下单时间: txt(card.querySelector('[class*="orderTime-"]')),
      店铺: txt(card.querySelector('[class*="shopNames-"]')),
      订单状态: txt(card.querySelector('[class*="statusText-"]')),
      商品名称: items.map((i) => i.name).filter(Boolean).join(' | '),
      商品数量: items.map((i) => i.qty).filter(Boolean).join(' | '),
      实付金额: amount,
      支付方式: txt(card.querySelector('[class*="paymentTypeName-"]')),
      收货人: user,
      收货地址: addr,
      抓取时间: new Date().toISOString()
    };
  }

  const pageIds = () => [...document.querySelectorAll(CARD)]
    .map((c) => {
      const m = c.querySelector('[class*="orderMetas-"]');
      return m ? txt(m.querySelector('[class*="metaValue-"]')) : '';
    })
    .join(',');

  function findNext() {
    const nodes = [...document.querySelectorAll('button, a, li, div, span')];
    for (const e of nodes) {
      if (e.offsetParent === null) continue;
      const cls = String(e.className || '');
      if (/disabled/i.test(cls)) continue;
      if (/(^|[-_])(next|pager-next|page-next)([-_]|$)/i.test(cls)) return e;
      if (/^(下一页|下页|›|»|>)$/.test((e.innerText || '').trim())) return e;
    }
    return null;
  }

  // ---------------- 累积存储 ----------------
  const load = () => {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; }
  };
  const save = (o) => localStorage.setItem(KEY, JSON.stringify(o));

  function exportCsv() {
    const all = Object.values(load());
    if (!all.length) { setStatus('还没有抓到任何订单'); return; }
    const headers = ['订单号', '下单时间', '店铺', '订单状态', '商品名称', '商品数量',
                     '实付金额', '支付方式', '收货人', '收货地址', '抓取时间'];
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = '\uFEFF' + [headers.join(',')]
      .concat(all.map((o) => headers.map((h) => esc(o[h])).join(',')))
      .join('\r\n');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'jd-orders-' + stamp + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus('已导出 ' + all.length + ' 条');
  }

  // ---------------- 抓取（含自动翻页） ----------------
  async function grab() {
    if (running) { setStatus('正在运行中…'); return; }
    running = true;
    const accum = load();
    let pageNo = 1;
    let lastIds = '';
    let fetched = 0;

    try {
      while (pageNo <= MAX_PAGES) {
        const cards = [...document.querySelectorAll(CARD)];
        if (!cards.length) {
          setStatus('当前页没有订单卡片 —— 请确认页面已加载出订单');
          break;
        }
        const ids = pageIds();
        if (ids === lastIds) { setStatus('已到末页，停止'); break; }
        lastIds = ids;

        const rows = cards.map(parseCard);
        let added = 0;
        for (const r of rows) {
          if (r.订单号 && !accum[r.订单号]) { accum[r.订单号] = r; added++; }
        }
        fetched += rows.length;
        save(accum);
        setStatus('第 ' + pageNo + ' 页：本页 ' + rows.length + ' 条，新增 ' + added +
                  '，累积 ' + Object.keys(accum).length);

        const next = findNext();
        if (!next) break;

        const before = ids;
        next.click();
        const t0 = Date.now();
        let changed = false;
        while (Date.now() - t0 < WAIT_MS) {
          await new Promise((r) => setTimeout(r, 400));
          if (pageIds() !== before) { changed = true; break; }
        }
        if (!changed) { setStatus('点击后页面未刷新，停止'); break; }
        await new Promise((r) => setTimeout(r, 700));
        pageNo++;
      }
    } finally {
      running = false;
      setStatus('本轮抓取 ' + fetched + ' 条，累积 ' +
                Object.keys(load()).length + ' 条（点「导出」下载 CSV）');
    }
  }

  // ---------------- 悬浮面板 ----------------
  let statusEl;
  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  function buildPanel() {
    const box = document.createElement('div');
    box.id = 'jd-exporter-panel';
    box.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'width:320px', 'padding:12px', 'border-radius:10px',
      'background:#fff', 'border:1px solid #d9e2ec',
      'box-shadow:0 12px 32px rgba(15,23,42,.18)',
      'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif', 'color:#102a43'
    ].join(';');

    box.innerHTML = [
      '<div style="font-weight:600;margin-bottom:6px">京东订单导出（本地）</div>',
      '<div style="color:#627d98;font-size:12px;margin-bottom:8px">',
      '先在页面上筛好年份，再点抓取。数据只存在本机。</div>',
      '<div style="display:flex;gap:6px;flex-wrap:wrap">',
      '<button id="jd-x-grab" style="flex:1;min-width:88px;padding:6px 8px;border:0;border-radius:6px;background:#d92d20;color:#fff;cursor:pointer">抓取当前页</button>',
      '<button id="jd-x-export" style="flex:1;min-width:88px;padding:6px 8px;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer">导出累积全量</button>',
      '</div>',
      '<div style="display:flex;gap:6px;margin-top:6px">',
      '<button id="jd-x-clear" style="flex:1;padding:5px 8px;border:1px solid #d9e2ec;border-radius:6px;background:#fff;color:#627d98;cursor:pointer">清空累积</button>',
      '<button id="jd-x-hide" style="flex:1;padding:5px 8px;border:1px solid #d9e2ec;border-radius:6px;background:#fff;color:#627d98;cursor:pointer">收起</button>',
      '</div>',
      '<div id="jd-x-status" style="margin-top:8px;color:#486581;font-size:12px;min-height:32px"></div>'
    ].join('');

    document.body.appendChild(box);
    statusEl = box.querySelector('#jd-x-status');
    setStatus('已加载 ' + Object.keys(load()).length + ' 条历史累积');

    box.querySelector('#jd-x-grab').addEventListener('click', grab);
    box.querySelector('#jd-x-export').addEventListener('click', exportCsv);
    box.querySelector('#jd-x-clear').addEventListener('click', () => {
      localStorage.removeItem(KEY);
      setStatus('已清空');
    });
    box.querySelector('#jd-x-hide').addEventListener('click', () => {
      box.style.display = 'none';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    buildPanel();
  }
})();
