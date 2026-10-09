/* ============================================================
   京东订单抓取脚本 v1（适配 2026 新版订单页）
   ------------------------------------------------------------
   原理：京东订单页已改为前端渲染，原始 HTML 里没有订单。
        本脚本直接在【渲染后的页面】上读取订单卡片，自动翻页，
        并把结果累积保存（localStorage），最后下载成 CSV。

   用法：
     1. Edge 打开 https://order.jd.com/center/list.action （已登录）
     2. 先在页面上手动筛选你要的年份 / 时间段（例如 2014 年）
     3. F12 → 控制台 → 首次粘贴需输入 allow pasting
     4. 复制本文件【下面全部内容】粘贴，回车，等它跑完
     5. 会自动下载一个 jd-orders-accum-时间戳.csv 到 D:\EDGE download
        （这个 CSV 是【累积全量】：含之前跑过的所有年份）
     6. 切换到下一个年份，重复第 4 步 —— 最后一次下载的就是全量
   ------------------------------------------------------------
   重跑不会重复计数（按订单号去重）；
   想从零开始，在控制台执行：localStorage.removeItem('__jd_orders_accum_v1')
   ============================================================ */

(async () => {
  const KEY = '__jd_orders_accum_v1';
  const MAX_PAGES = 200;
  const WAIT_MS = 8000;
  const log = (...a) => console.log('%c[抓单]', 'color:#c00;font-weight:bold', ...a);

  const txt = (el) => el ? (((el.getAttribute && el.getAttribute('title')) || el.innerText || '')).trim() : '';
  const cardSel = '[class*="orderCard-"]';

  function parseCard(card) {
    const metas = card.querySelector('[class*="orderMetas-"]');
    let orderId = metas ? txt(metas.querySelector('[class*="metaValue-"]')) : '';
    if (!orderId) {
      const m = (card.innerText || '').match(/\d{10,}/);
      orderId = m ? m[0] : '';
    }

    const items = [...card.querySelectorAll('[class*="productItem-"]')].map(it => ({
      name: txt(it.querySelector('[class*="productTitle-"]')),
      qty: txt(it.querySelector('[class*="countNum-"]'))
    }));

    const pi = card.querySelector('[class*="priceInteger-"]');
    const pd = card.querySelector('[class*="priceDecimal-"]');
    const amount = pi ? (txt(pi) + (pd ? txt(pd) : '')) : '';

    const user = txt(card.querySelector('[class*="userName-"]'));
    let addr = '';
    const dg = card.querySelector('[class*="deliveryTextGroup-"]');
    if (dg) addr = ((dg.innerText || '').replace(user, '')).trim();

    return {
      订单号: orderId,
      下单时间: txt(card.querySelector('[class*="orderTime-"]')),
      店铺: txt(card.querySelector('[class*="shopNames-"]')),
      订单状态: txt(card.querySelector('[class*="statusText-"]')),
      商品名称: items.map(i => i.name).filter(Boolean).join(' | '),
      商品数量: items.map(i => i.qty).filter(Boolean).join(' | '),
      实付金额: amount,
      支付方式: txt(card.querySelector('[class*="paymentTypeName-"]')),
      收货人: user,
      收货地址: addr,
      抓取时间: new Date().toISOString()
    };
  }

  const pageIds = () => [...document.querySelectorAll(cardSel)]
    .map(c => { const m = c.querySelector('[class*="orderMetas-"]'); return m ? txt(m.querySelector('[class*="metaValue-"]')) : ''; })
    .join(',');

  function findNext() {
    const nodes = [...document.querySelectorAll('button, a, li, div, span')];
    for (const e of nodes) {
      if (e.offsetParent === null) continue;
      const cls = String(e.className || '');
      if (/disabled/i.test(cls)) continue;
      if (/(^|[-_])(next|pager-next|page-next)([-_]|$)/i.test(cls)) return e;
      const t = (e.innerText || '').trim();
      if (/^(下一页|下页|›|»|>)$/.test(t)) return e;
    }
    return null;
  }

  const accum = JSON.parse(localStorage.getItem(KEY) || '{}');
  let fetched = 0;
  let pageNo = 1;
  let lastIds = '';

  while (pageNo <= MAX_PAGES) {
    const cards = [...document.querySelectorAll(cardSel)];
    if (cards.length === 0) { log('当前页没有订单卡片 —— 请确认页面已加载出订单，然后重跑'); break; }

    const ids = pageIds();
    if (ids === lastIds) { log('页面内容未变化，判定已到末页，停止'); break; }
    lastIds = ids;

    const rows = cards.map(parseCard);
    if (pageNo === 1) { console.table(rows); }   // 第一页回显，便于肉眼核对

    let added = 0;
    for (const r of rows) {
      if (r.订单号 && !accum[r.订单号]) { accum[r.订单号] = r; added++; }
    }
    fetched += rows.length;
    log(`第 ${pageNo} 页：本页 ${rows.length} 条，新增 ${added} 条，累积总数 ${Object.keys(accum).length}`);
    localStorage.setItem(KEY, JSON.stringify(accum));

    const next = findNext();
    if (!next) {
      const cands = [...document.querySelectorAll('*')]
        .filter(e => /next|下一页|下页/i.test(String(e.className || '') + ' ' + (e.innerText || '')))
        .slice(0, 15)
        .map(e => e.tagName + ' [' + String(e.className || '').slice(0, 50) + '] "' + (e.innerText || '').replace(/\s+/g, ' ').slice(0, 12) + '"');
      log('找不到「下一页」——可能已是最后一页。若还有更多页，请把下面这行发给我：');
      console.log('分页候选：', cands);
      break;
    }

    log('点击下一页…');
    const before = ids;
    next.click();

    const t0 = Date.now();
    let changed = false;
    while (Date.now() - t0 < WAIT_MS) {
      await new Promise(r => setTimeout(r, 400));
      if (pageIds() !== before) { changed = true; break; }
    }
    if (!changed) { log('等待超时：点击后页面未刷新，停止'); break; }
    await new Promise(r => setTimeout(r, 700));
    pageNo++;
  }

  const all = Object.values(accum);
  const headers = ['订单号', '下单时间', '店铺', '订单状态', '商品名称', '商品数量', '实付金额', '支付方式', '收货人', '收货地址', '抓取时间'];
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = '\uFEFF' + [headers.join(',')]
    .concat(all.map(o => headers.map(h => esc(o[h])).join(',')))
    .join('\r\n');

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'jd-orders-accum-' + stamp + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();

  log(`本轮抓取 ${fetched} 条；累积全量 ${all.length} 条，已下载 CSV`);
  log('提示：切换年份/时间段后再跑一次本脚本，会继续追加并重新下载全量 CSV');
})().catch(e => console.error('[抓单] 出错：', e));
