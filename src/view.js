'use strict';
/* Atorasu – diagram layout and rendering (plain DOM + SVG, no dependencies). */
class Diagram {
  constructor({ viewport, stage, nodesEl, linesEl }) {
    this.viewport = viewport;
    this.stage = stage;
    this.nodesEl = nodesEl;
    this.linesEl = linesEl;
    this.opts = { showAnn: true, showType: true, showAttr: true };
    this.root = null;
    this.selected = null;
    this.hits = new Set();
    this.zoom = 1;
    this.byId = new Map();
    this.onSelect = () => {};
    this.canvas = document.createElement('canvas').getContext('2d');
    this.F_BOX = 'bold 15px Arial, Helvetica, sans-serif';
    this.F_LBL = '12px Arial, Helvetica, sans-serif';
    this.F_LBLB = 'bold 12px Arial, Helvetica, sans-serif';
    this.LBL_MAX = 300;
    nodesEl.addEventListener('click', e => this.handleClick(e));
    nodesEl.addEventListener('dblclick', e => {
      const box = e.target.closest('.box');
      if (box) this.toggle(this.byId.get(+box.parentNode.dataset.id));
    });
  }

  setRoot(root) {
    this.root = root;
    this.selected = null;
    this.hits = new Set();
    this.render();
  }

  visibleChildren(n) {
    const c = n.children;
    return this.opts.showAttr ? c : c.filter(x => x.kind !== 'attribute');
  }

  textWidth(font, s) {
    this.canvas.font = font;
    return this.canvas.measureText(s).width;
  }

  wrap(text, font, max) {
    const lines = [];
    let cur = '';
    for (const w of text.split(' ')) {
      const t = cur ? `${cur} ${w}` : w;
      if (cur && this.textWidth(font, t) > max) { lines.push(cur); cur = w; } else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  measure(n) {
    const kidsVisible = this.visibleChildren(n);
    const m = { arrow: null, lines: [] };
    if (n.recursive) m.arrow = 'rec';
    else if (kidsVisible.length) m.arrow = n.expanded ? 'open' : 'closed';
    const arrowW = m.arrow ? 20 : 0;
    if (n.isCompositor) {
      m.boxH = 24;
      m.boxW = 40 + arrowW;
    } else {
      m.boxH = 26;
      m.label = n.kind === 'attribute' ? '@' + n.name : n.name;
      m.boxW = Math.max(36, Math.ceil(this.textWidth(this.F_BOX, m.label)) + 22 + arrowW);
    }
    if (this.opts.showType) {
      const card = (n.kind === 'element' || n.isCompositor || n.kind === 'any') && (n.max !== 1 || n.min > 1)
        ? `[${Xsd.cardinality(n)}]` : '';
      const t = [n.groupName ? `group ${n.groupName}` : '', n.typeText, card].filter(Boolean).join('  ');
      if (t) for (const l of this.wrap(t, this.F_LBLB, this.LBL_MAX)) m.lines.push({ t: l, b: true });
    }
    if (this.opts.showAnn && n.doc) {
      for (const l of this.wrap(n.doc, this.F_LBL, this.LBL_MAX)) m.lines.push({ t: l, b: false });
    }
    m.lblW = m.lines.reduce((a, l) => Math.max(a, this.textWidth(l.b ? this.F_LBLB : this.F_LBL, l.t)), 0);
    m.blockH = m.boxH + (m.lines.length ? 4 + m.lines.length * 15 : 0);
    m.colW = Math.max(m.boxW, Math.ceil(m.lblW) + 2);
    n._m = m;
    return m;
  }

  // Places n at column x starting at y=top; returns the next free y.
  layout(n, x, top) {
    const m = this.measure(n);
    const VGAP = 10;
    n._x = x;
    const kids = n.expanded ? this.visibleChildren(n) : [];
    n._vis = kids;
    if (!kids.length) {
      n._top = top;
      n._cy = top + m.boxH / 2;
      return top + m.blockH + VGAP;
    }
    n._cx = x + m.colW + (n.isCompositor ? 26 : 44);
    let t = top;
    for (const c of kids) t = this.layout(c, n._cx, t);
    let cy = (kids[0]._cy + kids[kids.length - 1]._cy) / 2;
    if (cy - m.boxH / 2 < top) {
      const d = top - (cy - m.boxH / 2);
      for (const c of kids) this.shift(c, d);
      cy += d;
      t += d;
    }
    n._cy = cy;
    n._top = cy - m.boxH / 2;
    return Math.max(t, n._top + m.blockH + VGAP);
  }

  shift(n, d) {
    n._cy += d;
    n._top += d;
    for (const c of n._vis) this.shift(c, d);
  }

  esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  compIcon(n) {
    let inner;
    if (n.kind === 'sequence') {
      inner = '<line x1="3" y1="12" x2="37" y2="12"/><circle cx="12" cy="12" r="2.6"/><circle cx="20" cy="12" r="2.6"/><circle cx="28" cy="12" r="2.6"/>';
    } else if (n.kind === 'choice') {
      inner = '<path d="M5 12h7M12 12l7-5h8M12 12h15M12 12l7 5h8"/><rect x="27" y="5" width="6" height="4"/><rect x="27" y="10" width="6" height="4"/><rect x="27" y="15" width="6" height="4"/>';
    } else {
      inner = '<text x="20" y="16" text-anchor="middle" class="all">all</text>';
    }
    const dash = n.min === 0 ? ' stroke-dasharray="3 2"' : '';
    return `<svg class="comp-svg" width="40" height="24" viewBox="0 0 40 24"><polygon points="7,1 33,1 39,7 39,17 33,23 7,23 1,17 1,7" class="oct"${dash}/>${inner}</svg>`;
  }

  render() {
    this.byId.clear();
    if (!this.root) { this.nodesEl.innerHTML = ''; this.linesEl.innerHTML = ''; return; }
    const MARGIN = 20;
    const bottom = this.layout(this.root, MARGIN, MARGIN);
    let maxX = 0;
    const html = [];
    const paths = [];
    const visit = n => {
      this.byId.set(n.id, n);
      const m = n._m;
      maxX = Math.max(maxX, n._x + m.colW);
      const cls = ['box', n.kind];
      if (n.min === 0) cls.push('opt');
      if (n.max !== 1 && !n.isCompositor) cls.push('multi');
      if (n === this.selected) cls.push('sel');
      if (this.hits.has(n)) cls.push('hit');
      let inner = n.isCompositor ? this.compIcon(n) : `<span class="nm">${this.esc(m.label)}</span>`;
      if (m.arrow === 'rec') inner += '<span class="arrow rec" title="Recursive: this type is already used by an ancestor">↻</span>';
      else if (m.arrow) inner += `<span class="arrow ${m.arrow}"></span>`;
      const lines = m.lines.map(l => `<div class="${l.b ? 'tl' : 'al'}">${this.esc(l.t)}</div>`).join('');
      html.push(`<div class="node" data-id="${n.id}" style="left:${n._x}px;top:${n._top}px">` +
        `<div class="${cls.join(' ')}" style="width:${m.boxW}px;height:${m.boxH}px" title="${this.esc(n.xpath || n.kind)}">${inner}</div>` +
        (lines ? `<div class="lbl" style="width:${Math.ceil(m.lblW) + 4}px">${lines}</div>` : '') + '</div>');
      if (n._vis.length) {
        const x0 = n._x + m.boxW;
        const xm = n._cx - 14;
        const ys = n._vis.map(c => c._cy);
        paths.push(`M${x0} ${n._cy + 0.5}H${xm}`);
        paths.push(`M${xm + 0.5} ${Math.min(...ys)}V${Math.max(...ys) + 1}`);
        for (const c of n._vis) paths.push(`M${xm} ${c._cy + 0.5}H${n._cx}`);
        n._vis.forEach(visit);
      }
    };
    visit(this.root);
    const w = maxX + MARGIN * 2;
    const h = bottom + MARGIN;
    this.nodesEl.innerHTML = html.join('');
    this.linesEl.setAttribute('width', w);
    this.linesEl.setAttribute('height', h);
    this.linesEl.innerHTML = `<path d="${paths.join('')}"/>`;
    this.stage.style.width = w + 'px';
    this.stage.style.height = h + 'px';
  }

  rerender() {
    const l = this.viewport.scrollLeft;
    const t = this.viewport.scrollTop;
    this.render();
    this.viewport.scrollLeft = l;
    this.viewport.scrollTop = t;
  }

  handleClick(e) {
    const box = e.target.closest('.box');
    if (!box) return;
    const n = this.byId.get(+box.parentNode.dataset.id);
    const arrow = e.target.closest('.arrow');
    if (arrow && !arrow.classList.contains('rec')) this.toggle(n);
    else this.select(n);
  }

  toggle(n) {
    if (!n || !this.visibleChildren(n).length || n.recursive) return;
    n.expanded = !n.expanded;
    this.rerender();
  }

  select(n) {
    this.selected = n;
    this.rerender();
    this.onSelect(n);
  }

  reveal(n) {
    for (let a = n.parent; a; a = a.parent) a.expanded = true;
    this.selected = n;
    this.render();
    this.scrollTo(n);
    this.onSelect(n);
  }

  scrollTo(n) {
    const z = this.zoom;
    const vp = this.viewport;
    const left = n._x * z;
    const cy = n._cy * z;
    const needX = left < vp.scrollLeft + 10 || left + 150 > vp.scrollLeft + vp.clientWidth;
    const needY = cy < vp.scrollTop + 20 || cy > vp.scrollTop + vp.clientHeight - 40;
    if (needX) vp.scrollLeft = Math.max(0, left - vp.clientWidth * 0.25);
    if (needY) vp.scrollTop = Math.max(0, cy - vp.clientHeight * 0.4);
  }

  setZoom(z) {
    this.zoom = Math.min(2, Math.max(0.3, z));
    this.stage.style.zoom = this.zoom;
  }
}
