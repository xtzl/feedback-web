/* ===========================================================
   售后反馈工作台 — 主逻辑
   数据全部保存在本机浏览器（IndexedDB），不上传任何服务器。
   =========================================================== */
(function () {
'use strict';

/* ---------------------------------------------------------
   1. 基础工具
   --------------------------------------------------------- */
const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function fmtTime(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function fmtDay(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return '今天 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return '昨天 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function debounce(fn, wait) {
  let t = null;
  return function () {
    const args = arguments, ctx = this;
    clearTimeout(t);
    t = setTimeout(() => fn.apply(ctx, args), wait);
  };
}

function toast(msg, kind) {
  const box = $('#toast');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 260);
  }, kind === 'err' ? 3600 : 2200);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------------------------------------------------------
   2. IndexedDB
   --------------------------------------------------------- */
const DB_NAME = 'feedback-workbench';
const DB_VER = 1;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('records')) {
        const s = d.createObjectStore('records', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!d.objectStoreNames.contains('images')) {
        const s = d.createObjectStore('images', { keyPath: 'id' });
        s.createIndex('recordId', 'recordId');
      }
      if (!d.objectStoreNames.contains('meta')) {
        d.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(storeName, mode, work) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let out;
    try { out = work(store); } catch (err) { reject(err); return; }
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const dbRecordsAll = () => idb('records', 'readonly', s => s.getAll());
const dbRecordPut = (rec) => idb('records', 'readwrite', s => s.put(rec));
const dbRecordDel = (id) => idb('records', 'readwrite', s => s.delete(id));
const dbImagePut = (img) => idb('images', 'readwrite', s => s.put(img));
const dbImageDel = (id) => idb('images', 'readwrite', s => s.delete(id));
const dbImagesOf = (recordId) =>
  idb('images', 'readonly', s => s.index('recordId').getAll(IDBKeyRange.only(recordId)));
const dbAllImages = () => idb('images', 'readonly', s => s.getAll());

function dbMetaGet(key) {
  return idb('meta', 'readonly', s => s.get(key)).then(r => (r ? r.value : undefined));
}
function dbMetaSet(key, value) {
  return idb('meta', 'readwrite', s => s.put({ key: key, value: value }));
}

/* ---------------------------------------------------------
   3. 模板定义
   --------------------------------------------------------- */
const URGENCY_LEVELS = [
  ['非常紧急', '影响面广，商户数 > 10，大范围商户使用不了'],
  ['紧急', '系统整体瘫痪，影响系统使用（网络 / 服务器 / 数据库异常）'],
  ['高', '系统关键业务受影响、客户身份为 VP 客户、同一客户多次发生或客户带有明显情绪'],
  ['中', '系统非关键业务停止或受影响，但对业务部分开展有干扰'],
  ['低', '暂无关键业务受影响，任意商户数，查询类']
];

const TEMPLATES = {
  /* ---------- 1. 内部售后问题反馈 ---------- */
  internal: {
    name: '内部售后反馈',
    title: '内部售后问题反馈',
    fields: [
      { id: 'customer', label: '客户信息', hint: '门店名称 / 群名称 -- 的谁（微信昵称）',
        type: 'text', ph: '油菜花信息科技', half: true, sticky: true },
      { id: 'dongle', label: '加密狗', type: 'text', ph: '00056477', half: true, sticky: true },

      { id: 'system', label: '系统 + 版本 + 本云', type: 'text',
        ph: '娱乐管家单店版 10.4.1420 云服务器', sticky: true },

      { id: 'device', label: '设备', hint: '无关可留空', type: 'text',
        ph: '钻石V9 320版本', half: true, sticky: true },
      { id: 'mini', label: '小程序', hint: '无关可留空', type: 'text',
        ph: '版本号 2.31.0', half: true, sticky: true },

      { id: 'time', label: '问题时间', type: 'text', ph: '5月4号下午2点出现 / 现在一直存在',
        quick: ['现在', '今天上午', '今天下午', '昨天', '近期一直存在'] },

      { id: 'phenomenon', label: '现象描述', hint: '只写事实', type: 'textarea',
        ph: '后台查询会员管理，查询全部时间时会提示错误，查询一段时间正常，查询有报错日志，麻烦帮忙看下。@对应模块研发或值班研发' },

      { id: 'actual', label: '实际情况', type: 'textarea', ph: '客户那边真实看到 / 经历的情况' },
      { id: 'display', label: '系统显示', type: 'textarea', ph: '系统里显示成什么样' },
      { id: 'diff', label: '差异 / 异常', type: 'textarea', ph: '两者对不上的地方、异常点' },

      { id: 'steps', label: '操作步骤', hint: '客户做了什么 → 系统 / 设备反应 → 系统结果',
        type: 'textarea', ph: '1. 客户点击…\n2. 系统弹出…\n3. 结果为…' },

      { id: 'tried', label: '已尝试处理', type: 'textarea', ph: '重启设备 / 重启服务 / 换网络…', half: true },
      { id: 'result', label: '处理结果', type: 'select', options: ['有效', '无效', '依旧'], half: true },

      { id: 'info', label: '信息相关', hint: '订单号、会员卡号、远程信息等，直接复制粘贴',
        type: 'textarea', ph: '订单号：\n会员卡号：\n远程信息：' },

      { id: 'scope', label: '影响范围', type: 'select',
        options: ['偶尔', '频繁', '所有机台', '仅某台'], half: true },
      { id: 'urgency', label: '紧急程度', type: 'select',
        options: ['非常紧急', '紧急', '高', '中', '低'], half: true, urgency: true },

      { id: 'images', label: '附件', hint: '截图 / 日志 —— 可直接 Ctrl+V 粘贴', type: 'images' }
    ],
    format: function (values, imageCount) {
      const v = k => String(values[k] == null ? '' : values[k]).trim();
      const L = [];

      const head = [];
      if (v('customer')) head.push('客户信息：' + v('customer'));
      if (v('dongle')) head.push('加密狗：' + v('dongle'));
      if (head.length) L.push(head.join('　'));

      if (v('system')) L.push('系统 + 版本 + 本云：' + v('system'));
      if (v('device')) L.push('设备：' + v('device'));
      if (v('mini')) L.push('小程序：' + v('mini'));
      if (v('time')) L.push('问题时间：' + v('time'));
      if (v('phenomenon')) L.push('现象描述（只写事实）：' + v('phenomenon'));
      if (v('actual')) L.push('实际情况：' + v('actual'));
      if (v('display')) L.push('系统显示：' + v('display'));
      if (v('diff')) L.push('差异 / 异常：' + v('diff'));
      if (v('steps')) L.push('操作步骤：' + v('steps'));
      if (v('tried') || v('result')) {
        L.push('已尝试处理：' + (v('tried') || '—') + '　结果：' + (v('result') || '待确认'));
      }
      if (v('info')) L.push('信息相关：' + v('info'));
      if (v('scope')) L.push('影响范围：' + v('scope'));
      if (v('urgency')) L.push('紧急程度：' + v('urgency'));
      if (imageCount) L.push('附件：截图 / 日志 ' + imageCount + ' 张（见后续图片）');

      return L.join('\n');
    }
  },

  /* ---------- 2. 回复客户问题 ---------- */
  replyCustomer: {
    name: '客户问题回复',
    title: '回复客户问题',
    fields: [
      { id: 'greeting', label: '问候语', type: 'text', sticky: true, ph: '您好',
        quick: ['您好', '您好，这边是油菜花售后', '您好，感谢您的耐心等待'] },
      { id: 'quote', label: '引用问题内容', hint: '把客户原话贴进来', type: 'textarea',
        ph: '客户反馈：…' },
      { id: 'reason', label: '出现问题的原因', type: 'textarea', ph: '因…导致…' },
      { id: 'solution', label: '如何解决 / 临时解决方案', type: 'textarea',
        ph: '1. 请先…\n2. 若仍不行，…' },
      { id: 'avoid', label: '后续怎么避免', type: 'textarea', ph: '建议后续…' },
      { id: 'images', label: '附件', hint: '需要给客户看的截图', type: 'images' }
    ],
    format: function (values, imageCount) {
      const v = k => String(values[k] == null ? '' : values[k]).trim();
      const L = [];
      L.push(v('greeting') || '您好');
      if (v('quote')) L.push('', '【您反馈的问题】' + v('quote'));
      if (v('reason')) L.push('', '出现这个问题的原因是：' + v('reason'));
      if (v('solution')) L.push('', '解决办法：' + v('solution'));
      if (v('avoid')) L.push('', '后续如何避免：' + v('avoid'));
      if (imageCount) L.push('', '（相关截图 ' + imageCount + ' 张，见后续图片）');
      return L.join('\n');
    }
  },

  /* ---------- 3. 售后工单回复客户 ---------- */
  replyTicket: {
    name: '工单回复客户',
    title: '售后工单问题回复客户',
    fields: [
      { id: 'greeting', label: '问候语', type: 'text', sticky: true, ph: '您好',
        quick: ['您好', '您好，这边是油菜花售后'] },
      { id: 'problem', label: '门店反馈的问题', type: 'textarea', ph: '…', half: true },
      { id: 'ticket', label: '钉钉工单编号', type: 'text', ph: '如 20250913001', half: true },
      { id: 'reason', label: '出现问题的原因是', type: 'textarea', ph: '…' },
      { id: 'solution', label: '解决 / 临时解决方案', type: 'textarea',
        ph: '需对接人员告知客户如何解决 / 临时方案是什么' },
      { id: 'avoid', label: '如何规避', hint: '没有可留空，会自动省略这一行', type: 'textarea',
        ph: '如涉及版本优化，注明预估发版时间' },
      { id: 'images', label: '附件', type: 'images' }
    ],
    format: function (values, imageCount) {
      const v = k => String(values[k] == null ? '' : values[k]).trim();
      const L = [];
      L.push(v('greeting') || '您好');
      if (v('problem')) L.push('门店反馈的问题：' + v('problem'));
      if (v('ticket')) L.push('（附钉钉工单编号：' + v('ticket') + '）');
      if (v('reason')) L.push('出现问题的原因是：' + v('reason'));
      if (v('solution')) L.push('解决 / 临时解决方案：' + v('solution'));
      if (v('avoid')) L.push('如何规避：' + v('avoid'));
      if (imageCount) L.push('（相关截图 ' + imageCount + ' 张，见后续图片）');
      return L.join('\n');
    }
  },

  /* ---------- 4. 排查中回复客户 ---------- */
  pending: {
    name: '排查中回复',
    title: '问题排查需客户等待回复',
    fields: [
      { id: 'greeting', label: '问候语', type: 'text', sticky: true, ph: '您好：',
        quick: ['您好：', '您好'] },
      { id: 'problem', label: '门店反馈的问题', type: 'textarea', ph: '…' },
      { id: 'ticket', label: '钉钉反馈工单编号', type: 'text', ph: '如 20250913001' },
      { id: 'images', label: '附件', type: 'images' }
    ],
    format: function (values, imageCount) {
      const v = k => String(values[k] == null ? '' : values[k]).trim();
      const L = [];
      L.push(v('greeting') || '您好：');
      if (v('problem')) L.push('门店反馈的问题：' + v('problem'));
      L.push('以上问题目前已反馈在进一步排查中，对应工单是：' + (v('ticket') || '（待填写）')
        + '，这边有结果第一时间回复您，给您带来不便，抱歉~');
      if (imageCount) L.push('（相关截图 ' + imageCount + ' 张，见后续图片）');
      return L.join('\n');
    }
  }
};

const TEMPLATE_ORDER = ['internal', 'replyCustomer', 'replyTicket', 'pending'];

/* ---------------------------------------------------------
   4. 全局状态
   --------------------------------------------------------- */
const state = {
  records: [],          // 全部记录（按 updatedAt 倒序）
  current: null,        // 当前记录
  images: [],           // 当前记录的图片
  pins: {},             // fieldId -> 常用值
  lastUsed: {},         // templateId -> { fieldId: value }
  currentByTemplate: {},// templateId -> recordId
  filter: '',
  lbIndex: 0
};

/* ---------------------------------------------------------
   5. 图片处理
   --------------------------------------------------------- */
const MAX_DIM = 2200;
const MAX_CHARS = 3.2 * 1024 * 1024;

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('图片解析失败'));
    im.src = src;
  });
}

function renderCanvas(img, w, h, type, quality) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL(type, quality);
}

async function prepareImage(file) {
  const rawType = file.type || 'image/png';
  let dataUrl = await readAsDataURL(file);
  let img;
  try { img = await loadImage(dataUrl); }
  catch (e) { throw new Error('无法识别的图片格式'); }

  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  let type = rawType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  let out = dataUrl;
  let w = srcW, h = srcH;

  const tooBig = Math.max(srcW, srcH) > MAX_DIM;
  const tooHeavy = dataUrl.length > MAX_CHARS;

  if (tooBig || tooHeavy) {
    const scale = tooBig ? MAX_DIM / Math.max(srcW, srcH) : 1;
    w = Math.max(1, Math.round(srcW * scale));
    h = Math.max(1, Math.round(srcH * scale));
    try { out = renderCanvas(img, w, h, type, 0.92); } catch (e) { out = dataUrl; }
  }
  if (out.length > MAX_CHARS) {
    try {
      out = renderCanvas(img, w, h, 'image/jpeg', 0.86);
      type = 'image/jpeg';
    } catch (e) { /* 保持原图 */ }
  }

  return {
    dataUrl: out,
    type: type,
    w: w,
    h: h,
    size: Math.round(out.length * 0.75)
  };
}

async function addFiles(fileList) {
  const files = Array.prototype.slice.call(fileList || [])
    .filter(f => f && /^image\//.test(f.type || ''));
  if (!files.length) return;

  const imgField = (TEMPLATES[state.current.template].fields || []).some(f => f.type === 'images');
  if (!imgField) { toast('当前模板不支持附件', 'err'); return; }

  let ok = 0, fail = 0;
  for (const f of files) {
    try {
      const info = await prepareImage(f);
      const item = {
        id: uid(),
        recordId: state.current.id,
        createdAt: Date.now(),
        name: '截图_' + (state.images.length + 1) + (info.type === 'image/jpeg' ? '.jpg' : '.png'),
        type: info.type,
        size: info.size,
        w: info.w,
        h: info.h,
        dataUrl: info.dataUrl
      };
      await dbImagePut(item);
      state.images.push(item);
      ok++;
    } catch (e) { fail++; }
  }
  syncImageCount();
  renderImages();
  renderSendHint();
  renderDirBox();
  renderHistory();
  scheduleSaveNow();
  if (ok) toast('已添加 ' + ok + ' 张图片', 'ok');
  if (fail) toast(fail + ' 张图片处理失败', 'err');
}

function syncImageCount() {
  if (state.current) state.current.imageCount = state.images.length;
}

/* ---------------------------------------------------------
   6. 记录读写
   --------------------------------------------------------- */
function newRecord(templateId) {
  const tpl = TEMPLATES[templateId];
  const values = {};
  (tpl.fields || []).forEach(f => {
    if (f.type === 'images') return;
    if (f.sticky) {
      const pin = state.pins[f.id];
      const last = (state.lastUsed[templateId] || {})[f.id];
      values[f.id] = (pin !== undefined && pin !== '') ? pin : (last || '');
    } else {
      values[f.id] = '';
    }
  });
  const now = Date.now();
  return {
    id: uid(),
    template: templateId,
    values: values,
    imageCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

async function loadRecord(rec) {
  if (!rec) return;
  state.current = rec;
  state.currentByTemplate[rec.template] = rec.id;
  try { state.images = (await dbImagesOf(rec.id)) || []; }
  catch (e) { state.images = []; }
  state.images.sort((a, b) => ((a.createdAt || 0) - (b.createdAt || 0)) || (a.id > b.id ? 1 : -1));

  // 让列表与当前记录指向同一个对象，避免计数等信息不同步
  const at = state.records.findIndex(r => r.id === rec.id);
  if (at >= 0) state.records[at] = rec; else state.records.push(rec);

  renderTabs();
  renderForm();
  syncImageCount();
  renderImages();
  renderPreview();
  renderSendHint();
  renderDirBox();
  renderHistory();
  updateHeaderCount();
}

const scheduleSaveNow = () => saveCurrent(true);

const debouncedSave = debounce(() => saveCurrent(false), 450);

async function saveCurrent(immediate) {
  const rec = state.current;
  if (!rec) return;

  rec.updatedAt = Date.now();
  syncImageCount();

  setSaveState(true);
  try {
    await dbRecordPut(rec);

    // 记忆本模板最近一次填写的值
    const remembered = {};
    (TEMPLATES[rec.template].fields || []).forEach(f => {
      if (f.type === 'images') return;
      const val = rec.values[f.id];
      if (val && String(val).trim()) remembered[f.id] = val;
    });
    state.lastUsed[rec.template] = remembered;
    await dbMetaSet('lastUsed', state.lastUsed);

    // 合并进列表
    const idx = state.records.findIndex(r => r.id === rec.id);
    const snapshot = { id: rec.id, template: rec.template, values: rec.values,
      imageCount: rec.imageCount, createdAt: rec.createdAt, updatedAt: rec.updatedAt };
    if (idx >= 0) state.records[idx] = snapshot; else state.records.push(snapshot);
    state.records.sort((a, b) => b.updatedAt - a.updatedAt);

    renderHistory();
    updateHeaderCount();
  } catch (e) {
    console.error(e);
    if (immediate) toast('保存失败：' + (e && e.message ? e.message : e), 'err');
  }
  setSaveState(false);
}

let saveTimer = null;
function setSaveState(saving) {
  const el = $('#saveState');
  if (!el) return;
  if (saving) {
    el.classList.add('saving');
    el.lastElementChild.textContent = '保存中…';
    clearTimeout(saveTimer);
  } else {
    el.classList.remove('saving');
    el.lastElementChild.textContent = '已保存 ' + fmtTime(Date.now()).slice(11);
  }
}

/* ---------------------------------------------------------
   7. 渲染 — Tabs
   --------------------------------------------------------- */
function renderTabs() {
  const box = $('#tabs');
  box.innerHTML = '';
  TEMPLATE_ORDER.forEach(id => {
    const b = document.createElement('button');
    b.className = 'tab' + (state.current && state.current.template === id ? ' active' : '');
    b.textContent = TEMPLATES[id].name;
    b.onclick = () => switchTemplate(id);
    box.appendChild(b);
  });
}

async function createAndLoad(templateId) {
  const rec = newRecord(templateId);
  state.records.push(rec);
  try { await dbRecordPut(rec); } catch (e) { console.error(e); }
  await loadRecord(rec);
  return rec;
}

async function switchTemplate(id) {
  if (state.current && state.current.template === id) return;
  if (state.current) await saveCurrent(true);

  const knownId = state.currentByTemplate[id];
  let rec = knownId ? state.records.find(r => r.id === knownId) : null;

  if (!rec) {
    // 该模板已存在的最新记录
    rec = state.records.filter(r => r.template === id)[0] || null;
  }
  if (!rec) { await createAndLoad(id); return; }

  await loadRecord(rec);
}

/* ---------------------------------------------------------
   8. 渲染 — 表单
   --------------------------------------------------------- */
function renderForm() {
  const tpl = TEMPLATES[state.current.template];
  $('#formTitle').textContent = tpl.title;

  const form = $('#form');
  form.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'grid';

  (tpl.fields || []).forEach(f => {
    if (f.type === 'images') {
      grid.appendChild(buildImagesField(f));
    } else {
      grid.appendChild(buildField(f));
    }
  });

  form.appendChild(grid);
}

function buildField(f) {
  const wrap = document.createElement('div');
  wrap.className = 'field' + (f.type === 'textarea' || !f.half ? ' full' : '');

  const label = document.createElement('label');
  label.textContent = f.label;
  if (f.hint) {
    const h = document.createElement('span');
    h.className = 'hint';
    h.textContent = '· ' + f.hint;
    label.appendChild(h);
  }
  if (f.sticky) {
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'pin' + (state.pins[f.id] ? ' on' : '');
    pin.title = state.pins[f.id] ? '已设为常用（点一下取消）' : '设为常用信息，新建时自动填充';
    pin.textContent = '📌';
    pin.onclick = async (e) => {
      e.preventDefault();
      const val = state.current.values[f.id];
      if (state.pins[f.id]) {
        delete state.pins[f.id];
        pin.classList.remove('on');
        pin.title = '设为常用信息，新建时自动填充';
        toast('已取消常用');
      } else {
        if (!val || !String(val).trim()) { toast('先填内容，再点 📌 存为常用', 'err'); return; }
        state.pins[f.id] = val;
        pin.classList.add('on');
        pin.title = '已设为常用（点一下取消）';
        toast('已存为常用信息', 'ok');
      }
      await dbMetaSet('pins', state.pins);
    };
    label.appendChild(pin);
  }
  wrap.appendChild(label);

  let input;
  if (f.type === 'textarea') {
    input = document.createElement('textarea');
    input.rows = f.rows || 3;
    input.placeholder = f.ph || '';
  } else if (f.type === 'select') {
    input = document.createElement('select');
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '请选择…';
    input.appendChild(empty);
    (f.options || []).forEach(o => {
      const op = document.createElement('option');
      op.value = o; op.textContent = o;
      input.appendChild(op);
    });
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.placeholder = f.ph || '';
  }

  input.value = state.current.values[f.id] || '';
  const evt = (f.type === 'select') ? 'change' : 'input';
  input.addEventListener(evt, () => {
    state.current.values[f.id] = input.value;
    renderPreview();
    debouncedSave();
  });
  wrap.appendChild(input);

  if (f.quick && f.quick.length) {
    const chips = document.createElement('div');
    chips.className = 'chips';
    f.quick.forEach(q => {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'chip';
      c.textContent = q;
      c.onclick = () => {
        input.value = q;
        state.current.values[f.id] = q;
        renderPreview();
        debouncedSave();
      };
      chips.appendChild(c);
    });
    wrap.appendChild(chips);
  }

  if (f.urgency) {
    const d = document.createElement('details');
    d.className = 'urgency-help';
    const s = document.createElement('summary');
    s.textContent = '紧急程度怎么定？点开看标准';
    d.appendChild(s);
    const inner = document.createElement('div');
    inner.className = 'inner';
    URGENCY_LEVELS.forEach(pair => {
      const line = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = pair[0] + '：';
      line.appendChild(b);
      line.appendChild(document.createTextNode(pair[1]));
      inner.appendChild(line);
    });
    d.appendChild(inner);
    wrap.appendChild(d);
  }

  return wrap;
}

function buildImagesField(f) {
  const wrap = document.createElement('div');
  wrap.className = 'field full';

  const label = document.createElement('label');
  label.textContent = f.label;
  if (f.hint) {
    const h = document.createElement('span');
    h.className = 'hint';
    h.textContent = '· ' + f.hint;
    label.appendChild(h);
  }
  const sp = document.createElement('span');
  sp.className = 'field-tools';

  const btnDir = document.createElement('button');
  btnDir.type = 'button';
  btnDir.className = 'btn sm';
  btnDir.textContent = '导出图片';
  btnDir.title = '把全部截图按顺序写入你指定的文件夹，方便一次拖进聊天窗口';
  btnDir.onclick = () => exportImagesToFolder(true);
  sp.appendChild(btnDir);

  const btnZip = document.createElement('button');
  btnZip.type = 'button';
  btnZip.className = 'btn sm';
  btnZip.textContent = '打包 zip';
  btnZip.title = '全部截图打包成一个 zip 文件';
  btnZip.onclick = downloadAllImages;
  sp.appendChild(btnZip);

  const btnLong = document.createElement('button');
  btnLong.type = 'button';
  btnLong.className = 'btn sm';
  btnLong.textContent = '合成一张图';
  btnLong.title = '把文字和全部截图合成一张长图存成 PNG（注意：图里的文字不能被搜索）';
  btnLong.onclick = downloadSummaryImage;
  sp.appendChild(btnLong);

  label.appendChild(sp);
  wrap.appendChild(label);

  const dz = document.createElement('div');
  dz.className = 'dropzone';
  dz.id = 'dropzone';
  dz.innerHTML = '<div class="big">🖼️</div>'
    + '把截图拖进来 · 或 <kbd>Ctrl</kbd> + <kbd>V</kbd> 直接粘贴 · 或点击选择文件'
    + '<div style="margin-top:4px;font-size:11.5px;opacity:.75">支持多张，自动压缩，只存在你自己电脑上</div>';
  dz.onclick = () => $('#filePicker').click();

  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });
  wrap.appendChild(dz);

  const thumbs = document.createElement('div');
  thumbs.className = 'thumbs';
  thumbs.id = 'thumbs';
  wrap.appendChild(thumbs);

  return wrap;
}

function renderImages() {
  const box = $('#thumbs');
  if (!box) return;
  box.innerHTML = '';

  if (!state.images.length) {
    const t = document.createElement('div');
    t.className = 'empty-tip';
    t.style.gridColumn = '1 / -1';
    t.style.padding = '10px';
    t.textContent = '还没有附件';
    box.appendChild(t);
    return;
  }

  state.images.forEach((im, i) => {
    const d = document.createElement('div');
    d.className = 'thumb';

    const img = document.createElement('img');
    img.src = im.dataUrl;
    img.alt = im.name;
    img.onclick = () => openLightbox(i);
    d.appendChild(img);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const n1 = document.createElement('span');
    n1.textContent = im.name;
    const n2 = document.createElement('span');
    n2.textContent = fmtSize(im.size);
    meta.appendChild(n1); meta.appendChild(n2);
    d.appendChild(meta);

    const ops = document.createElement('div');
    ops.className = 'ops';

    const bCopy = document.createElement('button');
    bCopy.title = '复制图片到剪贴板（可直接粘贴进群聊）';
    bCopy.textContent = '📋';
    bCopy.onclick = (e) => { e.stopPropagation(); copyImageToClipboard(im); };

    const bDl = document.createElement('button');
    bDl.title = '下载这张图片';
    bDl.textContent = '⬇';
    bDl.onclick = (e) => { e.stopPropagation(); downloadOneImage(im, i); };

    const bDel = document.createElement('button');
    bDel.className = 'del';
    bDel.title = '删除';
    bDel.textContent = '✕';
    bDel.onclick = async (e) => {
      e.stopPropagation();
      await dbImageDel(im.id);
      state.images = state.images.filter(x => x.id !== im.id);
      syncImageCount();
      renderImages();
      renderSendHint();
      renderDirBox();
      renderPreview();
      renderHistory();
      await saveCurrent(true);
      toast('已删除');
    };

    ops.appendChild(bCopy); ops.appendChild(bDl); ops.appendChild(bDel);
    d.appendChild(ops);

    box.appendChild(d);
  });
}

/* ---------------------------------------------------------
   9. 渲染 — 预览
   --------------------------------------------------------- */
function renderPreview() {
  const el = $('#preview');
  if (!state.current) return;
  const tpl = TEMPLATES[state.current.template];
  const text = tpl.format(state.current.values, state.images.length).trim();
  if (!text) {
    el.textContent = '开始填写左侧内容，这里会自动生成可以粘贴到群里的文本。';
    el.classList.add('empty');
  } else {
    el.textContent = text;
    el.classList.remove('empty');
  }
}

/* ---------------------------------------------------------
   10. 渲染 — 历史
   --------------------------------------------------------- */
function recordTitle(rec) {
  const v = rec.values || {};
  const cands = [v.customer, v.problem, v.quote, v.phenomenon, v.greeting];
  let t = '';
  for (const c of cands) {
    if (c && String(c).trim()) { t = String(c).trim(); break; }
  }
  if (!t) t = '未命名记录';
  t = t.replace(/\s+/g, ' ');
  return t.length > 30 ? t.slice(0, 30) + '…' : t;
}

function renderHistory() {
  const box = $('#history');
  const q = state.filter.trim().toLowerCase();
  box.innerHTML = '';

  let list = state.records.filter(r => TEMPLATES[r.template]);
  if (q) {
    list = list.filter(r => {
      const hay = (recordTitle(r) + ' ' + Object.values(r.values || {}).join(' ')
        + ' ' + TEMPLATES[r.template].name).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  $('#histCount').textContent = list.length + ' / ' + state.records.length + ' 条';

  if (!list.length) {
    const e = document.createElement('div');
    e.className = 'empty-tip';
    e.textContent = q ? '没有匹配的记录' : '还没有历史记录，填写后会自动保存';
    box.appendChild(e);
    return;
  }

  list.slice(0, 200).forEach(rec => {
    const item = document.createElement('div');
    item.className = 'hist-item' + (state.current && state.current.id === rec.id ? ' active' : '');

    const main = document.createElement('div');
    main.className = 'hist-main';

    const title = document.createElement('div');
    title.className = 'hist-title';
    title.textContent = recordTitle(rec);

    const sub = document.createElement('div');
    sub.className = 'hist-sub';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = TEMPLATES[rec.template].name;
    sub.appendChild(badge);
    const tm = document.createElement('span');
    tm.textContent = fmtDay(rec.updatedAt);
    sub.appendChild(tm);
    if (rec.imageCount) {
      const ic = document.createElement('span');
      ic.textContent = '🖼 ' + rec.imageCount;
      sub.appendChild(ic);
    }

    main.appendChild(title);
    main.appendChild(sub);
    main.onclick = () => loadRecord(rec);

    const del = document.createElement('button');
    del.className = 'hist-del';
    del.textContent = '🗑';
    del.title = '删除这条记录';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('确定删除这条记录？图片也会一起删除，无法恢复。')) return;
      const imgs = await dbImagesOf(rec.id).catch(() => []);
      for (const im of imgs) await dbImageDel(im.id);
      await dbRecordDel(rec.id);
      state.records = state.records.filter(r => r.id !== rec.id);
      if (state.current && state.current.id === rec.id) {
        const next = state.records[0];
        if (next) { await loadRecord(next); }
        else {
          const nr = newRecord('internal');
          state.records.push(nr);
          await loadRecord(nr);
        }
      } else {
        renderHistory();
        updateHeaderCount();
      }
      toast('已删除');
    };

    item.appendChild(main);
    item.appendChild(del);
    box.appendChild(item);
  });
}

function updateHeaderCount() {
  $('#recordCount').textContent = state.records.length
    ? '· 共 ' + state.records.length + ' 条记录' : '';
}

/* ---------------------------------------------------------
   11. 复制 / 下载
   --------------------------------------------------------- */
async function copyText(text) {
  if (!text) { toast('还没有内容可以复制', 'err'); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast('文字已复制（真文本，可搜索）', 'ok');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('文字已复制', 'ok'); }
    catch (e2) { toast('复制失败，请手动选中预览区复制', 'err'); }
    ta.remove();
  }
}

function dataUrlToBlob(dataUrl, type) {
  const parts = String(dataUrl).split(',');
  const mime = (parts[0].match(/:(.*?);/) || [])[1] || type || 'image/png';
  const bin = atob(parts[1] || '');
  const len = bin.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/* ---------------------------------------------------------
   11.5 图文长图：把成稿文字 + 全部截图合成一张图
   （浏览器剪贴板一次只能放一张图，微信/企微也不支持一次粘贴多图，
     所以用「合成一张长图」来做到一次粘贴发完整条反馈）
   --------------------------------------------------------- */
const IMG_W = 1000;            // 逻辑宽度
const IMG_PAD = 44;
const IMG_DPR = 2;             // 2 倍图，粘到聊天窗口更清晰
const IMG_MAX_IMG_H = 9000;    // 所有截图累计高度上限，超出则等比缩小

const IMG_FONT = '"Microsoft YaHei","PingFang SC","Hiragino Sans GB","Segoe UI",sans-serif';

async function buildSummaryImage() {
  const tpl = TEMPLATES[state.current.template];
  const text = (tpl.format(state.current.values, state.images.length) || '').trim()
    || '（暂无可导出的内容）';

  const FS = 17, LH = 30;
  const contentW = IMG_W - IMG_PAD * 2;
  const fBody  = '400 ' + FS + 'px ' + IMG_FONT;
  const fLabel = '600 ' + FS + 'px ' + IMG_FONT;
  const fTitle = '600 26px ' + IMG_FONT;
  const fSub   = '400 14px ' + IMG_FONT;
  const fCap   = '600 15px ' + IMG_FONT;

  const probe = document.createElement('canvas').getContext('2d');
  const meas = (t, f) => { probe.font = f; return probe.measureText(t).width; };

  /* --- 文本折行：把 "标签：内容" 拆开，标签加粗，内容在剩余宽度里折行 --- */
  const visRows = [];
  for (const src of text.split('\n')) {
    if (!src.trim()) { visRows.push({ label: '', body: '' }); continue; }

    const mm = src.match(/^([^：]{1,14})：/);
    const label = mm ? mm[1] + '：' : '';
    let rest = mm ? src.slice(mm[0].length) : src;

    let labelW = label ? meas(label, fLabel) : 0;
    let first = true;

    // 标签本身就把一行占满了，那就标签单独一行
    if (labelW > contentW - 60) {
      visRows.push({ label: label, body: '' });
      labelW = 0; first = false;
    }
    if (!rest) { visRows.push({ label: label, body: '' }); continue; }

    let guard = 0;
    while (rest.length && guard++ < 800) {
      const avail = first ? contentW - labelW : contentW;
      let line = '';
      for (const ch of Array.from(rest)) {
        if (line && meas(line + ch, fBody) > avail) break;
        line += ch;
      }
      if (!line) line = Array.from(rest)[0];      // 保底：至少吃掉一个字符，绝不死循环
      visRows.push({ label: first ? label : '', body: line });
      rest = rest.slice(line.length);
      first = false;
    }
  }

  /* --- 加载截图 --- */
  const loaded = [];
  for (const im of state.images) {
    try { loaded.push({ el: await loadImage(im.dataUrl), name: im.name }); }
    catch (e) { /* 单张坏了就跳过 */ }
  }

  const CAP_H = 28, IMG_GAP = 18, SEP_GAP = 30;
  const rawH = loaded.map(o => contentW * (o.el.naturalHeight / o.el.naturalWidth));
  const sumRaw = rawH.reduce((a, b) => a + b, 0);
  const scale = sumRaw > IMG_MAX_IMG_H ? IMG_MAX_IMG_H / sumRaw : 1;

  /* --- 计算画布高度 --- */
  let y = IMG_PAD;
  y += 36;              // 标题
  y += 22;              // 副标题
  y += 24;              // 分隔线
  const textTop = y;
  y = textTop + visRows.length * LH;

  if (loaded.length) {
    y += SEP_GAP + 1;
    loaded.forEach((o, i) => {
      y += CAP_H;
      y += rawH[i] * scale;
      y += IMG_GAP;
    });
    y -= IMG_GAP;
  }
  y += 26;
  const H = Math.ceil(y + 22 + IMG_PAD);

  /* --- 绘制 --- */
  const cv = document.createElement('canvas');
  cv.width = IMG_W * IMG_DPR;
  cv.height = H * IMG_DPR;
  const ctx = cv.getContext('2d');
  ctx.scale(IMG_DPR, IMG_DPR);
  ctx.textBaseline = 'top';

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, IMG_W, H);
  ctx.fillStyle = '#2563eb';
  ctx.fillRect(0, 0, IMG_W, 6);

  const now = fmtTime(Date.now());
  let cy = IMG_PAD;

  ctx.font = fTitle; ctx.fillStyle = '#1b1f24';
  ctx.fillText(tpl.title, IMG_PAD, cy);
  ctx.font = fSub; ctx.fillStyle = '#8a94a6';
  ctx.textAlign = 'right';
  ctx.fillText(now, IMG_W - IMG_PAD, cy + 11);
  ctx.textAlign = 'left';
  cy += 36;

  ctx.font = fSub; ctx.fillStyle = '#8a94a6';
  ctx.fillText(loaded.length ? '附件 ' + loaded.length + ' 张' : '无附件', IMG_PAD, cy);
  cy += 22;

  ctx.strokeStyle = '#e4e7ec'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(IMG_PAD, cy + 8.5); ctx.lineTo(IMG_W - IMG_PAD, cy + 8.5); ctx.stroke();
  cy += 24;

  for (const row of visRows) {
    if (row.label) {
      ctx.font = fLabel; ctx.fillStyle = '#3d4757';
      ctx.fillText(row.label, IMG_PAD, cy);
    }
    if (row.body) {
      const lw = row.label ? meas(row.label, fLabel) : 0;
      ctx.font = fBody; ctx.fillStyle = '#1b1f24';
      ctx.fillText(row.body, IMG_PAD + lw, cy);
    }
    cy += LH;
  }

  if (loaded.length) {
    cy += SEP_GAP;
    ctx.strokeStyle = '#e4e7ec';
    ctx.beginPath(); ctx.moveTo(IMG_PAD, cy + 0.5); ctx.lineTo(IMG_W - IMG_PAD, cy + 0.5); ctx.stroke();
    cy += 1;

    loaded.forEach((o, i) => {
      ctx.font = fCap; ctx.fillStyle = '#5b6577';
      ctx.fillText((i + 1) + '.  ' + o.name, IMG_PAD, cy + 4);
      cy += CAP_H;

      const iw = contentW * scale;
      const ih = rawH[i] * scale;
      const ix = IMG_PAD + (contentW - iw) / 2;

      ctx.fillStyle = '#f6f7f9';
      ctx.fillRect(ix, cy, iw, ih);
      ctx.drawImage(o.el, ix, cy, iw, ih);
      ctx.strokeStyle = '#e4e7ec'; ctx.lineWidth = 1;
      ctx.strokeRect(ix + 0.5, cy + 0.5, iw - 1, ih - 1);

      cy += ih + IMG_GAP;
    });
    cy -= IMG_GAP;
  }

  cy += 26;
  ctx.font = fSub; ctx.fillStyle = '#98a2b3';
  ctx.fillText('本图由「售后反馈工作台」自动生成 · ' + now, IMG_PAD, cy);

  return await new Promise((resolve, reject) => {
    const fallback = () => {
      try { resolve(dataUrlToBlob(cv.toDataURL('image/png'), 'image/png')); }
      catch (e) { reject(e); }
    };
    if (typeof cv.toBlob !== 'function') { fallback(); return; }
    let done = false;
    try {
      cv.toBlob(b => { done = true; b ? resolve(b) : fallback(); }, 'image/png');
    } catch (e) { fallback(); return; }
    // 某些环境 toBlob 不回调，兜底走 toDataURL
    setTimeout(() => { if (!done) fallback(); }, 5000);
  });
}

async function copySummaryImage() {
  if (!state.current) return;
  const tpl = TEMPLATES[state.current.template];
  const text = (tpl.format(state.current.values, state.images.length) || '').trim();

  if (!state.images.length) {
    await copyText(text);
    toast('这条记录还没有附件，已只复制文字');
    return;
  }

  toast('正在合成图文长图…');
  try {
    const blob = await buildSummaryImage();

    // 优先同时放入图片和纯文字：粘到聊天窗口是图，粘到文本编辑器是文字
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'image/png': blob,
        'text/plain': new Blob([text || ' '], { type: 'text/plain' })
      })]);
    } catch (e) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    }
    toast('已复制「文字 + ' + state.images.length + ' 张图」，去群里直接粘贴', 'ok');
  } catch (e) {
    console.error(e);
    toast('复制失败：' + (e && e.message ? e.message : e) + '　可点「长图」保存后手动发送', 'err');
  }
}

async function downloadSummaryImage() {
  if (!state.current) return;
  toast('正在合成长图…');
  try {
    const blob = await buildSummaryImage();
    const v = state.current.values;
    const base = String(v.customer || v.problem || '反馈')
      .replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 28);
    downloadBlob(blob, base + '_' + stamp14() + '_长图.png');
    toast('长图已保存', 'ok');
  } catch (e) {
    console.error(e);
    toast('合成失败：' + (e && e.message ? e.message : e), 'err');
  }
}

async function copyImageToClipboard(im) {
  try {
    if (!navigator.clipboard || !window.ClipboardItem) throw new Error('浏览器不支持');
    const png = await toPngBlob(im);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast('图片已复制，可直接粘贴进聊天窗口', 'ok');
  } catch (e) {
    toast('复制图片失败，可用「下载」后手动发送', 'err');
  }
}

async function toPngBlob(im) {
  const blob = dataUrlToBlob(im.dataUrl, im.type);
  if (blob.type === 'image/png') return blob;
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    const out = await new Promise(res => c.toBlob(res, 'image/png'));
    return out || blob;
  } finally { URL.revokeObjectURL(url); }
}

function downloadOneImage(im, i) {
  const blob = dataUrlToBlob(im.dataUrl, im.type);
  const base = (state.current.values.customer || state.current.values.problem || '截图')
    .replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 20);
  const ext = blob.type === 'image/jpeg' ? '.jpg' : '.png';
  downloadBlob(blob, base + '_' + pad2(i + 1) + ext);
}

function downloadAllImages() {
  if (!state.images.length) { toast('还没有图片', 'err'); return; }
  const v = state.current.values;
  const stamp = stamp14();
  const base = ((v.customer || v.problem || '反馈') + '_' + stamp)
    .replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);

  const files = state.images.map((im, i) => {
    const ext = im.type === 'image/jpeg' ? '.jpg' : '.png';
    return { name: base + '_' + pad2(i + 1) + ext, blob: dataUrlToBlob(im.dataUrl, im.type) };
  });
  makeZip(files).then(blob => {
    downloadBlob(blob, base + '.zip');
    toast('已打包 ' + files.length + ' 张图片', 'ok');
  }).catch(err => {
    console.error(err);
    toast('打包失败，改为逐张下载', 'err');
    state.images.forEach((im, i) => setTimeout(() => downloadOneImage(im, i), i * 350));
  });
}

/* ---------------------------------------------------------
   11.6 导出图片到文件夹 / 一键准备发送
   —— 文字走剪贴板保持"真文本"（可搜索），图片走文件保持"真图片"
   --------------------------------------------------------- */
let dirHandle = null;

function fileBase(rec) {
  const r = rec || state.current;
  const v = (r && r.values) || {};
  return String(v.customer || v.problem || v.quote || '反馈')
    .replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 28) || '反馈';
}

/** 到秒的紧凑时间戳，用作文件夹/文件名后缀，避免同一分钟内重复导出互相覆盖 */
function stamp14(ts) {
  const d = new Date(ts || Date.now());
  return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate())
    + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

/** 所有照片都收在这个固定子目录下，方便日后回头找 */
const PHOTO_ROOT = '售后反馈照片';

/** 这条记录的文件夹名：客户名_20260913_2302 —— 一条反馈一个独立文件夹 */
function recordFolderName(rec) {
  rec = rec || state.current;
  if (!rec) return PHOTO_ROOT;
  // 已经导出过就锁定，避免客户名后来改动导致文件夹对不上
  if (rec.photoFolder && rec.photoFolderLocked) return rec.photoFolder;
  const d = new Date(rec.createdAt || Date.now());
  const base = fileBase(rec);
  rec.photoFolder = base + '_' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate())
    + '_' + pad2(d.getHours()) + pad2(d.getMinutes());
  return rec.photoFolder;
}

function pickDir() {
  if (!window.showDirectoryPicker) return Promise.resolve(null);
  return window.showDirectoryPicker({ id: 'fb-export', mode: 'readwrite', startIn: 'desktop' })
    .catch(() => null);      // 用户取消
}

async function ensureDir(interactive) {
  if (dirHandle) {
    try {
      if (await dirHandle.queryPermission({ mode: 'readwrite' }) === 'granted') return dirHandle;
      if (interactive && await dirHandle.requestPermission({ mode: 'readwrite' }) === 'granted') return dirHandle;
    } catch (e) { /* 句柄失效，重新选 */ }
    dirHandle = null;
  }
  if (!interactive) return null;
  const h = await pickDir();
  if (h) {
    dirHandle = h;
    try { await dbMetaSet('exportDir', h); } catch (e) {}
    renderDirBox();
    renderSendHint();
    toast('照片会存到「' + h.name + '/' + PHOTO_ROOT + '」下面', 'ok');
  }
  return h;
}

/** 侧栏「照片存到哪」里点「选择/更改文件夹」 */
function pickDirInteractive() {
  if (!window.showDirectoryPicker) {
    toast('当前浏览器不支持选择文件夹，请改用 Chrome 或 Edge', 'err');
    return;
  }
  ensureDir(true);
}

/**
 * 回读目录，确认文件真的落到磁盘上了（不能只看 API 没报错）。
 * 这是「完全确认」的关键一步。
 */
async function listWrittenFiles(sub) {
  const out = [];
  try {
    for await (const entry of sub.values()) {
      if (entry.kind !== 'file') continue;
      let size = 0, modified = 0;
      try {
        const f = await entry.getFile();
        size = f.size; modified = f.lastModified;
      } catch (e) { /* 拿不到大小不算失败 */ }
      out.push({ name: entry.name, size: size, modified: modified });
    }
  } catch (e) {
    console.error('回读目录失败', e);
  }
  out.sort((a, b) => (a.name > b.name ? 1 : -1));
  return out;
}

/**
 * 把当前记录的全部截图按顺序写进
 *   <你选的文件夹> / 售后反馈照片 / <客户名_日期_时间> / 01_xxx.png
 * 写完后**回读目录核对**，只有真的读到文件才算成功。
 * 同一条记录重复导出会写进同一个文件夹（不会每次都新建）。
 * @returns {Promise<{dir:object, n:number, folder:string, files:Array}|null>}
 */
async function exportImagesToFolder(interactive) {
  if (!state.images.length) { toast('这条记录还没有附件', 'err'); return null; }

  const dir = await ensureDir(interactive !== false);
  if (!dir) {
    if (!window.showDirectoryPicker) {
      toast('当前浏览器不支持选择文件夹，已改为逐张下载', 'err');
      state.images.forEach((im, i) => setTimeout(() => downloadOneImage(im, i), i * 320));
    }
    return null;
  }

  const folder = recordFolderName();
  let root, sub;
  try {
    root = await dir.getDirectoryHandle(PHOTO_ROOT, { create: true });
    sub = await root.getDirectoryHandle(folder, { create: true });
  } catch (e) {
    toast('无法在「' + dir.name + '」里建目录：' + (e && e.message ? e.message : e)
      + '　请确认这个文件夹允许写入', 'err');
    return null;
  }

  let failed = 0;
  for (let i = 0; i < state.images.length; i++) {
    const im = state.images[i];
    const ext = im.type === 'image/jpeg' ? '.jpg' : '.png';
    const name = pad2(i + 1) + '_' + (im.name || '截图').replace(/\.[^.]+$/, '') + ext;
    try {
      const fh = await sub.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(dataUrlToBlob(im.dataUrl, im.type));
      await w.close();
    } catch (e) {
      failed++;
      console.error('写入失败', name, e);
    }
  }

  /* ---- 关键：回读目录核对，不信写入接口的"没报错" ---- */
  const readBack = await listWrittenFiles(sub);
  const good = readBack.filter(f => f.size > 0);

  if (!good.length) {
    toast('写入后回读目录是空的 —— 导出没成功。请确认「' + dir.name
      + '」这个文件夹允许写入', 'err');
    state.current.photoFiles = [];
    state.current.photoFolderLocked = false;
    state.current.photoExportedAt = 0;
    await saveCurrent(true);
    renderDirBox();
    renderSendHint();
    return null;
  }

  state.current.photoFolder = folder;
  state.current.photoFolderLocked = true;
  state.current.photoFiles = good;
  state.current.photoExportedAt = Date.now();
  state.current.photoExportedCount = good.length;
  await saveCurrent(true);
  renderDirBox();
  renderSendHint();

  if (failed) toast('有 ' + failed + ' 张写入失败，已成功 ' + good.length + ' 张', 'err');
  return { dir, n: good.length, folder, files: good };
}

async function prepareSend() {
  if (!state.current) return;
  const tpl = TEMPLATES[state.current.template];
  const text = tpl.format(state.current.values, state.images.length).trim();

  if (!text) { toast('还没有内容可以复制', 'err'); return; }

  await copyText(text);
  if (!state.images.length) return;

  const r = await exportImagesToFolder(true);
  if (r) toast('✓ 文字已复制 · ' + r.n + ' 个文件已确认写入', 'ok');
}

/* ---- 侧栏「照片存到哪」 ---- */
function renderDirBox() {
  const box = $('#dirBox');
  if (!box) return;
  box.innerHTML = '';

  const rec = state.current;
  const n = state.images.length;
  const folder = rec ? recordFolderName(rec) : PHOTO_ROOT;
  const done = !!(rec && rec.photoExportedAt && (rec.photoFiles || []).length);

  /* --- 还没选文件夹 --- */
  if (!dirHandle) {
    const empty = document.createElement('div');
    empty.className = 'empty-tip';
    empty.style.padding = '14px 8px';
    empty.textContent = '还没有选文件夹。点下面的按钮挑一个位置，'
      + '建议先在桌面上建一个专门的文件夹（比如 001）再选它。';
    box.appendChild(empty);

    const b = document.createElement('button');
    b.className = 'btn sm primary';
    b.style.width = '100%';
    b.textContent = '选择文件夹';
    b.onclick = pickDirInteractive;
    box.appendChild(b);

    const note = document.createElement('div');
    note.className = 'dir-note';
    note.innerHTML = '浏览器出于安全<b>不会告诉我们文件夹的完整路径</b>，'
      + '所以这里只能显示文件夹的名字。';
    box.appendChild(note);
    return;
  }

  /* --- 有图但还没导出：醒目提醒 --- */
  if (!done && n) {
    const warn = document.createElement('div');
    warn.className = 'dir-warn';
    warn.innerHTML = '⚠️ <b>照片还没有导出</b><br>'
      + '下面这条路径目前<b>只是预告，磁盘上还不存在</b>。'
      + '点「导出这 ' + n + ' 张」才会真正写入。';
    box.appendChild(warn);
  }

  /* --- 目录树：区分「已创建」和「还没创建」 --- */
  const tree = document.createElement('div');
  tree.className = 'dir-tree';
  tree.appendChild(dirRow(dirHandle.name, '你选的', 0, false, true));
  tree.appendChild(dirRow(PHOTO_ROOT, done ? '已创建' : '待创建', 1, false, done));
  tree.appendChild(dirRow(folder, done ? '已创建' : '待创建', 2, true, done));
  box.appendChild(tree);

  /* --- 按钮 --- */
  const acts = document.createElement('div');
  acts.className = 'dir-actions';

  const bPick = document.createElement('button');
  bPick.className = 'btn sm';
  bPick.textContent = '更改文件夹';
  bPick.onclick = pickDirInteractive;
  acts.appendChild(bPick);

  if (n) {
    const bGo = document.createElement('button');
    bGo.className = 'btn sm primary';
    bGo.textContent = done ? '重新导出' : '导出这 ' + n + ' 张';
    bGo.onclick = async () => {
      const r = await exportImagesToFolder(true);
      if (r) toast('✓ 已确认写入 ' + r.n + ' 个文件', 'ok');
    };
    acts.appendChild(bGo);
  }
  box.appendChild(acts);

  /* --- 结果 --- */
  if (done) {
    const ok = document.createElement('div');
    ok.className = 'dir-result';

    const head = document.createElement('div');
    head.className = 'dir-result-head';
    head.textContent = '✓ 已确认写入 ' + rec.photoFiles.length + ' 个文件 · '
      + fmtTime(rec.photoExportedAt);
    ok.appendChild(head);

    const ul = document.createElement('div');
    ul.className = 'dir-files';
    rec.photoFiles.forEach(f => {
      const li = document.createElement('div');
      li.className = 'dir-file';
      const nm = document.createElement('span');
      nm.className = 'nm'; nm.textContent = f.name; nm.title = f.name;
      const sz = document.createElement('span');
      sz.className = 'sz'; sz.textContent = fmtSize(f.size);
      li.appendChild(nm); li.appendChild(sz);
      ul.appendChild(li);
    });
    ok.appendChild(ul);
    box.appendChild(ok);

    const note = document.createElement('div');
    note.className = 'dir-note';
    note.innerHTML = '上面就是<b>真实读回来的文件清单</b>，'
      + '到系统里打开这个文件夹核对一下。'
      + '同一条反馈反复导出只会覆盖同一个文件夹。';
    box.appendChild(note);
  } else {
    const note = document.createElement('div');
    note.className = 'dir-note';
    note.innerHTML = n
      ? '导出后这里会列出<b>实际写入的文件清单</b>，用来核对。'
      : '左边加了截图后，点上面的按钮就能导出。';
    box.appendChild(note);
  }
}

function dirRow(name, tag, level, isLast, created) {
  const row = document.createElement('div');
  row.className = 'dir-row' + (level ? ' lvl' + level : '')
    + (isLast ? ' last' : '') + (level ? (created ? ' done' : ' pending') : '');
  const i = document.createElement('span');
  i.className = 'ico';
  i.textContent = created ? '📂' : (level ? '📁' : '📁');
  const nm = document.createElement('span');
  nm.className = 'nm'; nm.textContent = name;
  nm.title = name;
  row.appendChild(i); row.appendChild(nm);
  if (tag) {
    const t = document.createElement('span');
    t.className = 'tag'; t.textContent = tag;
    row.appendChild(t);
  }
  return row;
}

function renderSendHint() {
  const el = $('#sendHint');
  if (!el) return;
  const n = state.images.length;
  if (!n) {
    el.innerHTML = '这是<b>真文本</b> —— 复制后粘到群里可以选中、可以搜索。<br>'
      + '左边加了截图（直接 <b>Ctrl+V</b> 粘贴）后，这里会给出完整发送流程。';
    return;
  }

  const rec = state.current;
  const done = !!(rec && rec.photoExportedAt && (rec.photoFiles || []).length);
  const where = dirHandle
    ? '「' + PHOTO_ROOT + ' / ' + recordFolderName(rec) + '」'
    : '你选定的文件夹（第一次点会弹窗挑一个）';

  if (done) {
    el.innerHTML = '✓ <b>这条反馈已经准备好了</b><br>'
      + '① 文字在剪贴板里（真文本，可搜索）<br>'
      + '② <b>' + rec.photoFiles.length + ' 个文件</b>已写入 ' + where + '，'
      + '侧栏卡片里有完整清单<br>'
      + '到群里：<b>Ctrl+V 粘文字</b> → 打开那个文件夹<b>全选图片拖进聊天窗口</b>。';
  } else {
    el.innerHTML = '点【<b>准备发送</b>】会做两件事：<br>'
      + '① 把上面的文字复制到剪贴板（真文本，可搜索）<br>'
      + '② 把 <b>' + n + ' 张截图</b>写入 ' + where + '<br>'
      + '<b style="color:#d97706">现在还没有导出</b>，点一下才会真正写入磁盘。';
  }
}


/* ------------------- 极简 ZIP（仅存储，不压缩） ------------------- */
let CRC_TABLE = null;
function crc32(u8) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ u8[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const nameBytes = enc.encode(f.name);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    parts.push(local, data);

    const c = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    c.set(nameBytes, 46);
    central.push(c);

    offset += local.length + data.length;
  }

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return new Blob(parts.concat(central, [eocd]), { type: 'application/zip' });
}

/* ---------------------------------------------------------
   12. 备份：导出 / 导入
   --------------------------------------------------------- */
async function exportAll() {
  try {
    const records = await dbRecordsAll();
    const images = await dbAllImages();
    const payload = {
      app: 'feedback-workbench',
      version: 1,
      exportedAt: new Date().toISOString(),
      pins: state.pins,
      records: records,
      images: images
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const stamp = stamp14();
    downloadBlob(blob, '反馈记录备份_' + stamp + '.json');
    toast('已导出 ' + records.length + ' 条记录 / ' + images.length + ' 张图片', 'ok');
  } catch (e) {
    console.error(e);
    toast('导出失败：' + e.message, 'err');
  }
}

async function importAll(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.records)) throw new Error('文件格式不正确');

    let added = 0, updated = 0;
    for (const rec of data.records) {
      if (!rec || !rec.id || !TEMPLATES[rec.template]) continue;
      const exist = state.records.find(r => r.id === rec.id);
      if (exist) {
        if ((rec.updatedAt || 0) > (exist.updatedAt || 0)) { await dbRecordPut(rec); updated++; }
      } else { await dbRecordPut(rec); added++; }
    }
    for (const im of (data.images || [])) {
      if (im && im.id && im.recordId) await dbImagePut(im);
    }
    if (data.pins && typeof data.pins === 'object') {
      state.pins = Object.assign({}, state.pins, data.pins);
      await dbMetaSet('pins', state.pins);
    }

    state.records = (await dbRecordsAll()).sort((a, b) => b.updatedAt - a.updatedAt);
    renderHistory();
    updateHeaderCount();
    if (state.current) await loadRecord(state.records.find(r => r.id === state.current.id) || state.records[0]);
    toast('导入完成：新增 ' + added + ' 条，更新 ' + updated + ' 条', 'ok');
  } catch (e) {
    console.error(e);
    toast('导入失败：' + e.message, 'err');
  }
}

/* ---------------------------------------------------------
   13. 看大图
   --------------------------------------------------------- */
function openLightbox(i) {
  state.lbIndex = i;
  updateLightbox();
  $('#lightbox').classList.add('show');
}
function updateLightbox() {
  const im = state.images[state.lbIndex];
  if (!im) return;
  $('#lbImg').src = im.dataUrl;
  $('#lbCap').textContent = (state.lbIndex + 1) + ' / ' + state.images.length
    + '　' + im.name + '　' + im.w + '×' + im.h + '　' + fmtSize(im.size);
}
function closeLightbox() { $('#lightbox').classList.remove('show'); $('#lbImg').src = ''; }
function stepLightbox(d) {
  if (!state.images.length) return;
  state.lbIndex = (state.lbIndex + d + state.images.length) % state.images.length;
  updateLightbox();
}

/* ---------------------------------------------------------
   14. 事件绑定
   --------------------------------------------------------- */
/**
 * 安全绑定：元素不存在时只警告、不抛错。
 * 这样即使 HTML 和 JS 版本对不上（浏览器缓存了旧版页面），
 * 也只是个别按钮失效，不会连粘贴、自动保存这些核心功能一起挂掉。
 */
function bind(sel, handler, evt) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) {
    console.warn('[反馈工作台] 找不到 ' + sel + '，跳过绑定。'
      + '如果页面功能异常，请按 Ctrl+F5 强制刷新清掉旧缓存。');
    return null;
  }
  el.addEventListener(evt || 'click', handler);
  return el;
}

function bindEvents() {
  /* --- 核心功能优先绑定，绝不放在可能出错的位置之后 --- */

  // 全局粘贴图片：在任意位置 Ctrl+V 都能把截图加进附件
  document.addEventListener('paste', (e) => {
    if (!state.current) return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const files = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
        const f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });

  // 键盘：Esc 关灯箱、Ctrl+S 保存、灯箱左右翻页
  document.addEventListener('keydown', (e) => {
    const lb = $('#lightbox');
    if (e.key === 'Escape') closeLightbox();
    if (lb && lb.classList.contains('show')) {
      if (e.key === 'ArrowLeft') stepLightbox(-1);
      if (e.key === 'ArrowRight') stepLightbox(1);
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveCurrent(true).then(() => toast('已保存', 'ok'));
    }
  });

  /* --- 顶部工具条 --- */
  bind('#btnNew', async () => {
    if (state.current) await saveCurrent(true);
    await createAndLoad(state.current ? state.current.template : 'internal');
    toast('已新建记录', 'ok');
  });
  bind('#btnExport', () => exportAll());
  bind('#btnImport', () => { const p = $('#jsonPicker'); if (p) p.click(); });
  bind('#jsonPicker', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) await importAll(f);
  }, 'change');

  /* --- 预览区 --- */
  bind('#btnCopyText', () => {
    const tpl = TEMPLATES[state.current.template];
    copyText(tpl.format(state.current.values, state.images.length).trim());
  });
  bind('#btnPrepare', () => prepareSend());

  /* --- 表单 --- */
  bind('#btnClearForm', async () => {
    if (!confirm('清空当前这条记录的全部内容和附件？（记录本身会保留）')) return;
    const tpl = TEMPLATES[state.current.template];
    (tpl.fields || []).forEach(f => {
      if (f.type === 'images') return;
      state.current.values[f.id] = '';
    });
    for (const im of state.images) await dbImageDel(im.id);
    state.images = [];
    syncImageCount();
    renderForm();
    renderImages();
    renderSendHint();
    renderDirBox();
    renderPreview();
    renderHistory();
    await saveCurrent(true);
    toast('已清空');
  });

  bind('#filePicker', async (e) => {
    const files = e.target.files;
    e.target.value = '';
    if (files && files.length) await addFiles(files);
  }, 'change');

  /* --- 照片文件夹 --- */
  bind('#btnPickDir', () => pickDirInteractive());

  /* --- 历史搜索 --- */
  bind('#search', (e) => {
    state.filter = e.target.value;
    renderHistory();
  }, 'input');

  /* --- 灯箱 --- */
  bind('#lbClose', closeLightbox);
  bind('#lbPrev', () => stepLightbox(-1));
  bind('#lbNext', () => stepLightbox(1));
  bind('#lightbox', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });
}

/* ---------------------------------------------------------
   15. 启动
   --------------------------------------------------------- */
let booted = false;

async function init() {
  if (booted) return;   // 防止重复初始化
  booted = true;

  try {
    db = await openDB();
  } catch (e) {
    console.error(e);
    document.body.innerHTML = '<div style="padding:60px;text-align:center;font-family:sans-serif">'
      + '当前浏览器不支持本地数据库（IndexedDB），无法保存数据。<br>请改用 Chrome / Edge 打开本页面。</div>';
    return;
  }

  state.pins = (await dbMetaGet('pins')) || {};
  state.lastUsed = (await dbMetaGet('lastUsed')) || {};
  try { dirHandle = (await dbMetaGet('exportDir')) || null; } catch (e) { dirHandle = null; }

  const all = await dbRecordsAll();
  all.sort((a, b) => b.updatedAt - a.updatedAt);
  state.records = all;

  let rec = all[0];
  if (!rec) {
    rec = newRecord('internal');
    state.records.push(rec);
    await dbRecordPut(rec);
  }

  bindEvents();
  await loadRecord(rec);
  setSaveState(false);

  window.addEventListener('beforeunload', () => { /* 已自动保存 */ });
}

document.addEventListener('DOMContentLoaded', init);

/* 调试入口：控制台里可用 __FB 查看内部状态 / 手动调用 */
window.__FB = {
  state: state,
  TEMPLATES: TEMPLATES,
  makeZip: makeZip,
  crc32: crc32,
  buildSummaryImage: buildSummaryImage,
  copySummaryImage: copySummaryImage,
  prepareSend: prepareSend,
  exportImagesToFolder: exportImagesToFolder,
  fileBase: fileBase,
  recordFolderName: recordFolderName,
  renderDirBox: renderDirBox,
  renderSendHint: renderSendHint,
  PHOTO_ROOT: PHOTO_ROOT,
  bind: bind,
  setDirHandle: (h) => { dirHandle = h; renderDirBox(); renderSendHint(); },
  getDirHandle: () => dirHandle,
  saveCurrent: saveCurrent,
  loadRecord: loadRecord,
  renderImages: renderImages,
  dbRecordsAll: dbRecordsAll,
  dbAllImages: dbAllImages,
  dbImagePut: dbImagePut,
  dbImagesOf: dbImagesOf
};

})();
