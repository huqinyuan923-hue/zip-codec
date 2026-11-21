/**
 * zip-lab Web UI：拖 zip → 文件树 + 预览 + 重打包。
 * 全部计算在浏览器本地完成；库为零依赖的 zip-codec（esbuild 内联单文件）。
 */
import { readZipDetail, ZipError, type ZipEntryDetail } from '../src/reader';
import { writeZip } from '../src/writer';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const drop = $('drop');
const fileInput = $('file') as HTMLInputElement;
const metaEl = $('meta');
const treeEl = $('tree');
const rightPath = document.querySelector('.path')!;
const rightInfo = document.querySelector('.info')!;
const viewer = $('viewer');
const allCb = $('all') as HTMLInputElement;
const repackBtn = $('repack') as HTMLButtonElement;
const statusEl = $('status');

interface EntryNode {
  name: string;          // 全路径（目录一律含尾斜杠）
  isDir: boolean;        // 显式目录标记（虚拟中间层也是目录）
  entry: ZipEntryDetail | null; // 目录虚拟节点为 null
  children: Map<string, EntryNode>;
  checked: boolean;
}

let current: Uint8Array | null = null;
let currentNames: string[] = [];
let selectedPath: string | null = null;
let objectUrl: string | null = null;
let treeRoot: EntryNode | null = null; // 单一树实例：勾选状态只在这里维护

/** 按 '/' 分段构建树；中间虚拟目录显式标记 isDir 且名字补尾斜杠，
 *  与真实目录条目（'dir/'）合并为同一节点。 */
function buildTree(entries: ZipEntryDetail[]): EntryNode {
  const root: EntryNode = { name: '', isDir: true, entry: null, children: new Map(), checked: false };
  for (const e of entries) {
    const isDirEntry = e.name.endsWith('/');
    const segs = e.name.split('/').filter((s) => s.length > 0);
    let node = root;
    for (let i = 0; i < segs.length; i++) {
      const last = i === segs.length - 1;
      const isDirNode = last ? isDirEntry : true;
      const key = segs[i]! + (isDirNode ? '/' : '');
      let child = node.children.get(key);
      if (child === undefined) {
        child = {
          name: segs.slice(0, i + 1).join('/') + (isDirNode ? '/' : ''),
          isDir: isDirNode,
          entry: null,
          children: new Map(),
          checked: false,
        };
        node.children.set(key, child);
      }
      if (last) child.entry = e;
      node = child;
    }
  }
  return root;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(2)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function renderTree(root: EntryNode): void {
  treeEl.textContent = '';
  treeEl.appendChild(renderLevel(root, 0, true));
}

/** 渲染一层节点（返回本层 fragment；子层展开时递归挂载，保证结构完整）。 */
function renderLevel(node: EntryNode, depth: number, open: boolean): DocumentFragment {
  const frag = document.createDocumentFragment();
  const kids = [...node.children.values()].sort((a, b) => {
    const da = a.name.endsWith('/') ? 0 : 1;
    const db = b.name.endsWith('/') ? 0 : 1;
    return da - db || a.name.localeCompare(b.name);
  });
  for (const child of kids) {
    const isDir = child.isDir;
    const wrap = document.createElement('div');
    wrap.className = 'node';
    const row = document.createElement('div');
    row.className = 'row' + (isDir ? ' dir' : '') + (selectedPath === child.name ? ' sel' : '');
    row.style.paddingLeft = `${8 + depth * 16}px`;

    const tw = document.createElement('span');
    tw.className = 'tw';
    tw.textContent = isDir ? (open ? '▾' : '▸') : '';
    row.appendChild(tw);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = child.checked;
    cb.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setChecked(child, cb.checked);
    });
    row.appendChild(cb);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = isDir ? child.name.slice(0, -1).split('/').pop() + '/' : child.name.split('/').pop()!;
    row.appendChild(name);

    const sz = document.createElement('span');
    sz.className = 'sz';
    if (child.entry !== null) {
      sz.textContent = `${fmtSize(child.entry.size)} · m${child.entry.method}`;
      if (child.entry.size !== child.entry.compressedSize) {
        sz.textContent += ` ←${fmtSize(child.entry.compressedSize)}`;
      }
    }
    row.appendChild(sz);

    let expanded = open;
    row.addEventListener('click', () => {
      if (isDir) {
        expanded = !expanded;
        tw.textContent = expanded ? '▾' : '▸';
        wrap.replaceChildren(row);
        if (expanded) wrap.appendChild(renderLevel(child, depth + 1, true));
      } else {
        selectedPath = child.name;
        document.querySelectorAll('.row.sel').forEach((el) => el.classList.remove('sel'));
        row.classList.add('sel');
        void preview(child.entry!);
      }
    });
    wrap.appendChild(row);
    if (isDir && open) wrap.appendChild(renderLevel(child, depth + 1, true));
    frag.appendChild(wrap);
  }
  return frag;
}

function setChecked(node: EntryNode, v: boolean): void {
  node.checked = v;
  for (const c of node.children.values()) setChecked(c, v);
}

function collectChecked(node: EntryNode, out: string[]): void {
  if (node.entry !== null && node.checked) out.push(node.name);
  for (const c of node.children.values()) collectChecked(c, out);
}

function countChecked(node: EntryNode): number {
  let n = node.entry !== null && node.checked ? 1 : 0;
  for (const c of node.children.values()) n += countChecked(c);
  return n;
}

const TEXT_EXT = /\.(txt|md|json|xml|html|css|js|mjs|ts|jsx|tsx|csv|yml|yaml|ini|cfg|toml|log|svg|c|h|cpp|py|rs|go|java|sh|bat|gitignore|editorconfig|lock)$/i;

async function preview(e: ZipEntryDetail): Promise<void> {
  if (objectUrl !== null) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  rightPath.textContent = e.name;
  rightInfo.textContent = `${fmtSize(e.size)}（压缩后 ${fmtSize(e.compressedSize)}）· 方法 ${e.method === 0 ? 'stored' : 'deflate'} · CRC ${e.crc.toString(16).padStart(8, '0')} · 标志 0x${e.flags.toString(16)}${e.isDir ? ' · 目录' : ''}`;
  if (e.isDir || e.size === 0) {
    viewer.textContent = e.isDir ? '（目录条目）' : '（空文件）';
    return;
  }
  if (/\.(png|jpe?g|gif|webp|ico|bmp)$/i.test(e.name)) {
    const data = window.__zip.read(e.name);
    objectUrl = URL.createObjectURL(new Blob([data.slice().buffer as ArrayBuffer]));
    viewer.textContent = '';
    const img = document.createElement('img');
    img.src = objectUrl;
    viewer.appendChild(img);
    return;
  }
  const data = window.__zip.read(e.name);
  const head = data.subarray(0, 4096);
  const looksBinary = [...head.subarray(0, 1024)].includes(0);
  if (!looksBinary && (TEXT_EXT.test(e.name) || e.size < 65536)) {
    viewer.textContent = '';
    const pre = document.createElement('pre');
    pre.textContent = new TextDecoder('utf-8', { fatal: false }).decode(data.subarray(0, 1 << 20)) + (e.size > 1 << 20 ? '\n…（截断显示前 1MB）' : '');
    viewer.appendChild(pre);
  } else {
    // 十六进制预览（前 4KB）
    viewer.textContent = '';
    const pre = document.createElement('pre');
    let s = '';
    for (let i = 0; i < head.length; i += 16) {
      const row = [...head.subarray(i, i + 16)];
      const hex = row.map((b) => b.toString(16).padStart(2, '0')).join(' ');
      const asc = row.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      s += `${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  |${asc}|\n`;
    }
    pre.textContent = s + (e.size > 4096 ? `\n…（二进制，仅显示前 4KB / 共 ${fmtSize(e.size)}）` : '');
    viewer.appendChild(pre);
  }
}

function setStatus(msg: string, err = false): void {
  statusEl.textContent = msg;
  statusEl.className = err ? 'err' : '';
  statusEl.id = 'status';
}

function onFile(bytes: Uint8Array, label: string): void {
  try {
    const t0 = performance.now();
    const zip = readZipDetail(bytes);
    const ms = (performance.now() - t0).toFixed(0);
    window.__zip = zip;
    current = bytes;
    currentNames = zip.entries.map((e) => e.name);
    metaEl.hidden = false;
    treeEl.hidden = false;
    const dirs = zip.entriesDetail.filter((e) => e.isDir).length;
    const files = zip.entriesDetail.length - dirs;
    metaEl.innerHTML =
      `<span class="chip">${label}</span>` +
      `<span class="chip">${fmtSize(bytes.length)}</span>` +
      `<span class="chip">${files} 文件 + ${dirs} 目录</span>` +
      `<span class="chip">${zip.zip64 ? 'ZIP64' : '传统 EOCD'}</span>` +
      (zip.archiveComment ? `<span class="chip">有注释</span>` : '') +
      `<span class="chip">解析 ${ms}ms</span>` +
      (zip.archiveComment ? `<br>注释：${escapeHtml(zip.archiveComment)}` : '');
    selectedPath = null;
    treeRoot = buildTree(zip.entriesDetail);
    for (const c of treeRoot.children.values()) setChecked(c, true);
    renderTree(treeRoot);
    allCb.checked = true;
    repackBtn.disabled = false;
    setStatus(`解析成功：${zip.entriesDetail.length} 条目，${ms}ms`);
    rightPath.textContent = '（未选择条目）';
    rightInfo.textContent = '';
    viewer.textContent = '点左侧条目预览内容。';
  } catch (err) {
    const e = err as ZipError;
    metaEl.hidden = true;
    treeEl.hidden = true;
    repackBtn.disabled = true;
    setStatus(`解析失败：${e instanceof ZipError ? `[${e.code}] ` : ''}${e.message}`, true);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void f.arrayBuffer().then((ab) => onFile(new Uint8Array(ab), f.name));
});
for (const ev of ['dragover', 'dragenter']) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hover'); });
}
for (const ev of ['dragleave', 'drop']) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hover'); });
}
drop.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) void f.arrayBuffer().then((ab) => onFile(new Uint8Array(ab), f.name));
});

allCb.addEventListener('change', () => {
  if (treeRoot === null) return;
  for (const c of treeRoot.children.values()) setChecked(c, allCb.checked);
  renderTree(treeRoot);
});

repackBtn.addEventListener('click', () => {
  if (treeRoot === null) return;
  const names: string[] = [];
  collectChecked(treeRoot, names);
  if (names.length === 0) { setStatus('未选中条目', true); return; }
  try {
    const t0 = performance.now();
    const files = names.map((n) => ({ name: n, data: window.__zip.read(n) }));
    const out = writeZip(files, { level: 6 });
    const ms = (performance.now() - t0).toFixed(0);
    const blob = new Blob([out.slice().buffer as ArrayBuffer], { type: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'repacked.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus(`已重打包 ${names.length} 条目（${fmtSize(out.length)}，${ms}ms）并下载`);
  } catch (err) {
    setStatus(`重打包失败：${(err as Error).message}`, true);
  }
});

// 库句柄（供预览回调使用）
declare global {
  interface Window { __zip: ReturnType<typeof readZipDetail> }
}
