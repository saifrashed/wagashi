'use strict';
/* Wagashi – XSD model. Parses XSD files into a lazily-built node tree. No dependencies. */
const XSD_NS = 'http://www.w3.org/2001/XMLSchema';

const Xsd = (() => {
  const FACETS = ['length', 'minLength', 'maxLength', 'minInclusive', 'maxInclusive',
    'minExclusive', 'maxExclusive', 'totalDigits', 'fractionDigits', 'whiteSpace'];

  const kids = (el, ...names) => Array.from(el.children).filter(c =>
    c.namespaceURI === XSD_NS && (names.length === 0 || names.includes(c.localName)));
  const local = q => (q ? q.slice(q.indexOf(':') + 1) : q);
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();

  function docOf(el) {
    if (!el) return '';
    const ann = kids(el, 'annotation')[0];
    if (!ann) return '';
    return kids(ann, 'documentation').map(d => clean(d.textContent)).filter(Boolean).join(' ');
  }

  class Registry {
    constructor() {
      this.elements = new Map();
      this.complexTypes = new Map();
      this.simpleTypes = new Map();
      this.groups = new Map();
      this.attributeGroups = new Map();
      this.attributes = new Map();
      this.files = [];
      this.docs = [];
      this.decls = new Map();
      this.errors = [];
      this.unresolved = new Set();
    }
  }

  function register(reg) {
    const maps = {
      element: reg.elements, complexType: reg.complexTypes, simpleType: reg.simpleTypes,
      group: reg.groups, attributeGroup: reg.attributeGroups, attribute: reg.attributes,
    };
    const walk = (parent, file, ns) => {
      for (const c of kids(parent)) {
        if (c.localName === 'redefine') { walk(c, file, ns); continue; }
        const map = maps[c.localName];
        const name = c.getAttribute('name');
        if (map && name && !map.has(name)) map.set(name, { el: c, file, ns });
      }
    };
    for (const { name, doc } of reg.docs) {
      reg.files.push(name);
      walk(doc.documentElement, name, doc.documentElement.getAttribute('targetNamespace') || '');
    }
  }

  function load(files) {
    const reg = new Registry();
    for (const f of files) {
      const doc = new DOMParser().parseFromString(f.text, 'application/xml');
      const perr = doc.getElementsByTagName('parsererror')[0];
      if (perr) { reg.errors.push(`${f.name}: ${clean(perr.textContent).slice(0, 200)}`); continue; }
      const root = doc.documentElement;
      if (root.namespaceURI !== XSD_NS || root.localName !== 'schema') {
        reg.errors.push(`${f.name}: not an XML Schema (root element is <${root.nodeName}>)`);
        continue;
      }
      reg.docs.push({ name: f.name, doc });
      const m = /^\uFEFF?\s*(<\?xml[^>]*\?>)/.exec(f.text);
      reg.decls.set(f.name, m ? m[1] : '');
    }
    register(reg);
    return reg;
  }

  // Fresh registry over the same (possibly edited) documents.
  function rebuild(old) {
    const reg = new Registry();
    reg.docs = old.docs;
    reg.decls = old.decls;
    reg.errors = old.errors;
    register(reg);
    return reg;
  }

  function serialize(reg) {
    const ser = new XMLSerializer();
    return reg.docs.map(({ name, doc }) => {
      const decl = (reg.decls.get(name) || '<?xml version="1.0" encoding="UTF-8"?>')
        .replace(/encoding\s*=\s*(["'])[^"']*\1/, 'encoding="UTF-8"');
      return { name, text: `${decl}\n${ser.serializeToString(doc).replace(/^<\?xml[^>]*\?>\s*/, '')}\n` };
    });
  }

  function resolveType(reg, el, q) {
    const i = q.indexOf(':');
    const prefix = i < 0 ? null : q.slice(0, i);
    const name = q.slice(i + 1);
    if (el.lookupNamespaceURI(prefix) === XSD_NS) return { builtin: true, name: q };
    const c = reg.complexTypes.get(name);
    if (c) return { def: c, complex: true, name };
    const s = reg.simpleTypes.get(name);
    if (s) return { def: s, complex: false, name };
    reg.unresolved.add(q);
    return { unresolved: true, name: q };
  }

  const emptyInfo = base => ({ base, facets: {}, enums: [], patterns: [], list: false });
  const cloneInfo = i => ({ ...i, facets: { ...i.facets }, enums: i.enums.slice(), patterns: i.patterns.slice() });

  function simpleInfoFromRes(reg, res, depth) {
    if (depth > 25 || res.unresolved || res.builtin) return emptyInfo(res.name);
    return simpleInfoFromEl(reg, res.def.el, depth + 1);
  }

  function applyFacets(info, parent) {
    const own = [];
    for (const f of kids(parent)) {
      const v = f.getAttribute('value');
      if (f.localName === 'enumeration') own.push({ value: v, doc: docOf(f) });
      else if (f.localName === 'pattern') info.patterns.push(v);
      else if (FACETS.includes(f.localName)) info.facets[f.localName] = v;
    }
    if (own.length) info.enums = own;
  }

  function simpleInfoFromEl(reg, st, depth) {
    if (depth > 25) return emptyInfo('?');
    const restr = kids(st, 'restriction')[0];
    const list = kids(st, 'list')[0];
    const union = kids(st, 'union')[0];
    if (restr) {
      let info;
      const bq = restr.getAttribute('base');
      const inner = kids(restr, 'simpleType')[0];
      if (bq) info = simpleInfoFromRes(reg, resolveType(reg, restr, bq), depth);
      else if (inner) info = simpleInfoFromEl(reg, inner, depth + 1);
      else info = emptyInfo('xs:anySimpleType');
      info = cloneInfo(info);
      applyFacets(info, restr);
      return info;
    }
    if (list) {
      const iq = list.getAttribute('itemType');
      const item = iq ? simpleInfoFromRes(reg, resolveType(reg, list, iq), depth)
        : simpleInfoFromEl(reg, kids(list, 'simpleType')[0] || st, depth + 1);
      return { ...emptyInfo(`list of ${item.base}`), list: true };
    }
    if (union) {
      const members = (union.getAttribute('memberTypes') || '').split(/\s+/).filter(Boolean);
      return emptyInfo(`union(${members.join(', ')}${kids(union, 'simpleType').length ? ' …' : ''})`);
    }
    return emptyInfo('xs:anySimpleType');
  }

  function facetSummary(info) {
    const f = info.facets;
    const p = [];
    if (f.length) p.push(`${f.length} chars`);
    else if (f.minLength && f.maxLength) p.push(`${f.minLength}-${f.maxLength} chars`);
    else if (f.maxLength) p.push(`max ${f.maxLength} chars`);
    else if (f.minLength && f.minLength !== '0') p.push(`min ${f.minLength} chars`);
    const lo = f.minInclusive ?? (f.minExclusive != null ? '>' + f.minExclusive : null);
    const hi = f.maxInclusive ?? (f.maxExclusive != null ? '<' + f.maxExclusive : null);
    if (lo != null && hi != null) p.push(`${lo}..${hi}`);
    else if (lo != null) p.push(`min ${lo}`);
    else if (hi != null) p.push(`max ${hi}`);
    if (f.totalDigits) p.push(`${f.totalDigits} digits`);
    if (f.fractionDigits) p.push(`${f.fractionDigits} decimals`);
    if (info.enums.length) p.push(`${info.enums.length} values`);
    if (info.patterns.length) p.push('pattern');
    return p.join(', ');
  }

  const facetText = (name, info) => {
    const s = facetSummary(info);
    return s ? `${name} (${s})` : name;
  };

  const namedText = (name, info) => {
    const f = facetSummary(info);
    return `${name} (${info.base}${f ? ', ' + f : ''})`;
  };

  const occurs = (el, attr, dflt) => {
    const v = el.getAttribute(attr);
    if (v == null) return dflt;
    if (v === 'unbounded') return Infinity;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? dflt : n;
  };

  let nextId = 1;
  class Node {
    constructor(kind, props) {
      this.kind = kind;
      this.id = nextId++;
      this.parent = null;
      this.expanded = false;
      this.recursive = false;
      this.min = 1;
      this.max = 1;
      this.doc = '';
      this.typeText = '';
      this.build = null;
      this._children = null;
      Object.assign(this, props);
    }
    get children() {
      if (!this._children) {
        this._children = this.build ? this.build() : [];
        for (const c of this._children) c.parent = this;
      }
      return this._children;
    }
    get isCompositor() { return this.kind === 'sequence' || this.kind === 'choice' || this.kind === 'all'; }
    get xpath() {
      if (this._xp == null) {
        const base = this.parent ? this.parent.xpath : '';
        if (this.kind === 'element') this._xp = `${base}/${this.name}`;
        else if (this.kind === 'attribute') this._xp = `${base}/@${this.name}`;
        else this._xp = base;
      }
      return this._xp;
    }
    get xpathAnyNs() {
      const parts = [];
      for (let n = this; n; n = n.parent) {
        if (n.kind === 'element') parts.unshift(`*[local-name()='${n.name}']`);
        else if (n.kind === 'attribute') parts.unshift(`@*[local-name()='${n.name}']`);
      }
      return '/' + parts.join('/');
    }
    get pathNames() {
      const out = [];
      for (let n = this; n; n = n.parent) {
        if (n.kind === 'element') out.unshift(n.name);
        else if (n.kind === 'attribute') out.unshift('@' + n.name);
      }
      return out;
    }
  }

  function cardinality(n) {
    if (n.kind === 'attribute') return n.min ? 'required' : 'optional';
    const mx = n.max === Infinity ? '∞' : n.max;
    return `${n.min}..${mx}`;
  }

  function makeAttribute(reg, el, src) {
    const refQ = el.getAttribute('ref');
    let decl = el;
    let from = src;
    if (refQ) {
      const d = reg.attributes.get(local(refQ));
      if (d) { decl = d.el; from = d; } else reg.unresolved.add(refQ);
    }
    const n = new Node('attribute', {
      name: refQ ? local(refQ) : el.getAttribute('name'),
      min: el.getAttribute('use') === 'required' ? 1 : 0,
      doc: docOf(el) || (decl !== el ? docOf(decl) : ''),
      def: decl.getAttribute('default'),
      fixed: decl.getAttribute('fixed'),
      file: from.file, ns: from.ns, el, decl, useEl: el,
    });
    const t = decl.getAttribute('type');
    const inline = kids(decl, 'simpleType')[0];
    if (t) {
      const res = resolveType(reg, decl, t);
      n.info = simpleInfoFromRes(reg, res, 0);
      n.typeName = res.name;
      if (res.builtin || res.unresolved) n.typeText = facetText(t, n.info);
      else n.typeText = namedText(res.name, n.info);
    } else if (inline) {
      n.info = simpleInfoFromEl(reg, inline, 0);
      n.typeText = facetText(n.info.base, n.info);
    } else {
      n.info = emptyInfo('xs:anySimpleType');
      n.typeText = 'xs:anySimpleType';
    }
    return n;
  }

  function attrGroupNodes(reg, el, depth) {
    const q = el.getAttribute('ref');
    const d = q && reg.attributeGroups.get(local(q));
    if (!d) { if (q) reg.unresolved.add(q); return []; }
    if (depth > 20) return [];
    const out = [];
    for (const c of kids(d.el)) {
      if (c.localName === 'attribute') out.push(makeAttribute(reg, c, d));
      else if (c.localName === 'attributeGroup') out.push(...attrGroupNodes(reg, c, depth + 1));
    }
    return out;
  }

  function particle(reg, c, src) {
    switch (c.localName) {
      case 'element': return [makeElement(reg, c, src)];
      case 'sequence': case 'choice': case 'all':
        return [new Node(c.localName, {
          min: occurs(c, 'minOccurs', 1), max: occurs(c, 'maxOccurs', 1), doc: docOf(c),
          file: src.file, ns: src.ns, el: c, useEl: c,
          build: () => kids(c).flatMap(x => particle(reg, x, src)),
        })];
      case 'group': {
        const q = c.getAttribute('ref');
        const d = q && reg.groups.get(local(q));
        if (!d) { if (q) reg.unresolved.add(q); return []; }
        const inner = kids(d.el, 'sequence', 'choice', 'all')[0];
        if (!inner) return [];
        const nodes = particle(reg, inner, d);
        nodes[0].min = occurs(c, 'minOccurs', 1);
        nodes[0].max = occurs(c, 'maxOccurs', 1);
        nodes[0].groupName = local(q);
        nodes[0].useEl = c;
        nodes[0].doc = nodes[0].doc || docOf(d.el);
        return nodes;
      }
      case 'any':
        return [new Node('any', {
          name: 'any', min: occurs(c, 'minOccurs', 1), max: occurs(c, 'maxOccurs', 1),
          anyNs: c.getAttribute('namespace') || '##any', process: c.getAttribute('processContents') || 'strict',
          doc: docOf(c), typeText: `wildcard (${c.getAttribute('namespace') || '##any'})`,
          file: src.file, ns: src.ns, el: c, useEl: c,
        })];
      default: return [];
    }
  }

  function mergeParts(a, b) {
    if (!a.length) return b;
    if (!b.length) return a;
    const plain = n => n.kind === 'sequence' && n.min === 1 && n.max === 1;
    if (a.length === 1 && b.length === 1 && plain(a[0]) && plain(b[0])) {
      return [new Node('sequence', { build: () => [...a[0].children, ...b[0].children] })];
    }
    return [new Node('sequence', { build: () => [...a, ...b] })];
  }

  function contentNodes(reg, ctEl, src, depth) {
    if (depth > 30) return [];
    const parts = [];
    const attrs = [];
    for (const c of kids(ctEl)) {
      switch (c.localName) {
        case 'sequence': case 'choice': case 'all': case 'group':
          parts.push(...particle(reg, c, src)); break;
        case 'attribute': attrs.push(makeAttribute(reg, c, src)); break;
        case 'attributeGroup': attrs.push(...attrGroupNodes(reg, c, 0)); break;
        case 'complexContent': case 'simpleContent': {
          const d = kids(c, 'extension', 'restriction')[0];
          if (!d) break;
          let base = [];
          const bq = d.getAttribute('base');
          if (d.localName === 'extension' && bq) {
            const bt = resolveType(reg, d, bq);
            if (bt.def && bt.complex) base = contentNodes(reg, bt.def.el, bt.def, depth + 1);
          }
          const own = contentNodes(reg, d, src, depth + 1);
          const isAttr = n => n.kind === 'attribute';
          parts.push(...mergeParts(base.filter(n => !isAttr(n)), own.filter(n => !isAttr(n))));
          attrs.push(...base.filter(isAttr), ...own.filter(isAttr));
          break;
        }
        default: break;
      }
    }
    return [...parts, ...attrs];
  }

  // Simple info for a complex type with simpleContent (text value + attributes).
  function simpleContentInfo(reg, ctEl, depth) {
    if (depth > 20) return null;
    const sc = kids(ctEl, 'simpleContent')[0];
    const d = sc && kids(sc, 'extension', 'restriction')[0];
    const bq = d && d.getAttribute('base');
    if (!bq) return null;
    const bt = resolveType(reg, d, bq);
    let info;
    if (bt.def && bt.complex) info = simpleContentInfo(reg, bt.def.el, depth + 1) || emptyInfo('xs:anySimpleType');
    else info = simpleInfoFromRes(reg, bt, 0);
    info = cloneInfo(info);
    if (d.localName === 'restriction') applyFacets(info, d);
    return info;
  }

  function makeElement(reg, el, src) {
    const refQ = el.getAttribute('ref');
    let decl = el;
    let from = src;
    if (refQ) {
      const d = reg.elements.get(local(refQ));
      if (d) { decl = d.el; from = d; } else { reg.unresolved.add(refQ); decl = null; }
    }
    const n = new Node('element', {
      name: refQ ? local(refQ) : el.getAttribute('name'),
      min: occurs(el, 'minOccurs', 1), max: occurs(el, 'maxOccurs', 1),
      doc: docOf(el) || (decl && decl !== el ? docOf(decl) : ''),
      file: from.file, ns: from.ns, isRef: !!refQ, el: decl, decl, useEl: el,
      nillable: !!decl && decl.getAttribute('nillable') === 'true',
      abstract: !!decl && decl.getAttribute('abstract') === 'true',
      def: decl && decl.getAttribute('default'),
      fixed: decl && decl.getAttribute('fixed'),
      substitutionGroup: decl && decl.getAttribute('substitutionGroup'),
      info: null, typeEl: null, typeKind: 'anyType', typeName: '',
    });
    if (!decl) { n.typeKind = 'unresolved'; n.typeText = `unresolved ref ${refQ}`; return n; }

    let typeSrc = from;
    const t = decl.getAttribute('type');
    if (t) {
      const res = resolveType(reg, decl, t);
      n.typeName = res.name;
      if (res.unresolved) { n.typeKind = 'unresolved'; n.typeText = `${t} (unresolved)`; }
      else if (res.builtin) { n.typeKind = 'builtin'; n.info = emptyInfo(t); n.typeText = t; }
      else if (res.complex) { n.typeKind = 'complex'; n.typeEl = res.def.el; typeSrc = res.def; n.typeText = res.name; }
      else {
        n.typeKind = 'simple';
        n.info = simpleInfoFromRes(reg, res, 0);
        n.typeText = namedText(res.name, n.info);
      }
    } else {
      const ic = kids(decl, 'complexType')[0];
      const is = kids(decl, 'simpleType')[0];
      if (ic) { n.typeKind = 'complex'; n.typeEl = ic; }
      else if (is) {
        n.typeKind = 'simple';
        n.info = simpleInfoFromEl(reg, is, 0);
        n.typeText = facetText(n.info.base, n.info);
      }
    }
    if (n.typeKind === 'complex') {
      const sci = simpleContentInfo(reg, n.typeEl, 0);
      if (sci) {
        n.info = sci;
        n.typeText = n.typeName ? namedText(n.typeName, sci) : facetText(sci.base, sci);
      }
      n.build = () => {
        for (let a = n.parent; a; a = a.parent) {
          if (a.kind === 'element' && a.typeEl === n.typeEl) { n.recursive = true; return []; }
        }
        return contentNodes(reg, n.typeEl, typeSrc, 0);
      };
    }
    return n;
  }

  const roots = reg => Array.from(reg.elements.keys());

  // Prefer a global element that no other declaration references (a likely document root).
  function guessRoot(reg) {
    const names = roots(reg);
    if (names.length < 2) return names[0];
    const referenced = new Set();
    const scan = d => {
      for (const c of Array.from(d.el.getElementsByTagNameNS(XSD_NS, 'element'))) {
        const r = c.getAttribute('ref');
        if (r) referenced.add(local(r));
      }
    };
    [reg.elements, reg.complexTypes, reg.groups].forEach(m => m.forEach(scan));
    return names.find(x => !referenced.has(x)) || names[0];
  }

  function makeRoot(reg, name) {
    const d = reg.elements.get(name);
    const n = makeElement(reg, d.el, d);
    n.min = 1;
    n.max = 1;
    return n;
  }

  function flatten(root, limit) {
    const out = [];
    let truncated = false;
    const walk = n => {
      if (out.length >= limit) { truncated = true; return; }
      out.push(n);
      for (const c of n.children) walk(c);
    };
    walk(root);
    return { nodes: out, truncated };
  }

  return {
    load, rebuild, serialize, makeRoot, guessRoot, roots, flatten, facetSummary, cardinality,
    util: { kids, local, docOf, clean },
  };
})();
