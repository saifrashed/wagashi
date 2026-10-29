'use strict';
/* Wagashi – schema editing. All operations mutate the source XSD DOM; the diagram is rebuilt from it. */
const Edit = (() => {
  const { kids, local, docOf, clean } = Xsd.util;
  const NS = XSD_NS;
  const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
  const NAME_RE = /^[\p{L}_][\p{L}\p{N}_.\-]*$/u;
  const BUILTIN = ['string', 'normalizedString', 'token', 'boolean', 'decimal', 'integer', 'positiveInteger',
    'nonNegativeInteger', 'negativeInteger', 'nonPositiveInteger', 'long', 'int', 'short', 'byte',
    'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte', 'double', 'float', 'date', 'dateTime',
    'time', 'duration', 'gYear', 'gYearMonth', 'gMonth', 'gDay', 'gMonthDay', 'base64Binary', 'hexBinary',
    'anyURI', 'ID', 'IDREF', 'language', 'NMTOKEN', 'Name', 'NCName', 'QName', 'anyType', 'anySimpleType'];
  const PARTICLES = ['element', 'sequence', 'choice', 'all', 'group', 'any'];
  const ATTRS = ['attribute', 'attributeGroup', 'anyAttribute'];

  const mk = (doc, name) => {
    const p = doc.documentElement.prefix;
    return doc.createElementNS(NS, p ? `${p}:${name}` : name);
  };
  const builtinQ = (doc, name) => {
    const p = doc.documentElement.prefix;
    return p ? `${p}:${name}` : name;
  };
  const isRootChild = el => el.parentNode === el.ownerDocument.documentElement;
  const isBuiltinQ = (el, q) => {
    const i = q.indexOf(':');
    return el.lookupNamespaceURI(i < 0 ? null : q.slice(0, i)) === NS;
  };

  // ---------- whitespace-preserving DOM insertion/removal ----------
  const depthOf = el => {
    let d = 0;
    for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) d++;
    return d;
  };
  const unitOf = doc => {
    for (const c of doc.documentElement.childNodes) {
      const m = c.nodeType === 3 && /\n([ \t]+)$/.exec(c.data);
      if (m) return m[1];
    }
    return '  ';
  };
  const blank = n => n.nodeType === 3 && !n.data.trim();

  function insert(parent, child, ref = null) {
    const doc = parent.ownerDocument;
    const unit = unitOf(doc);
    const d = depthOf(parent);
    const ind = '\n' + unit.repeat(d + 1);
    const text = s => doc.createTextNode(s);
    if (ref) {
      parent.insertBefore(child, ref);
      parent.insertBefore(text(ind), ref);
    } else if (parent.children.length) {
      parent.children[parent.children.length - 1].after(text(ind), child);
    } else if (Array.from(parent.childNodes).every(blank)) {
      while (parent.firstChild) parent.removeChild(parent.firstChild);
      parent.append(text(ind), child, text('\n' + unit.repeat(d)));
    } else {
      parent.append(child);
    }
  }

  function detach(el) {
    const p = el.previousSibling;
    if (p && blank(p)) p.remove();
    el.remove();
  }

  const setAttr = (el, name, val, dflt) => {
    if (val == null || val === '' || val === dflt) el.removeAttribute(name);
    else el.setAttribute(name, val);
  };

  function setDoc(el, text) {
    text = text.trim();
    const ann = kids(el, 'annotation')[0];
    const docs = ann ? kids(ann, 'documentation') : [];
    if (!text) {
      if (ann && kids(ann).length === docs.length) detach(ann);
      else docs.forEach(detach);
      return;
    }
    if (docs.length) {
      docs[0].textContent = text;
      docs.slice(1).forEach(detach);
      return;
    }
    const doc = el.ownerDocument;
    const a = ann || mk(doc, 'annotation');
    if (!ann) insert(el, a, el.children[0] || null);
    const d = mk(doc, 'documentation');
    d.textContent = text;
    insert(a, d, null);
  }

  // ---------- types ----------
  function qualify(root, name, ns) {
    if (!ns) return name;
    const prefix = root.lookupPrefix(ns);
    if (prefix) return `${prefix}:${name}`;
    if (root.lookupNamespaceURI(null) === ns) return name;
    root.setAttributeNS(XMLNS_NS, 'xmlns:tns', ns);
    return `tns:${name}`;
  }

  function normType(reg, doc, value) {
    const v = value.trim();
    if (!v) return '';
    const root = doc.documentElement;
    const i = v.indexOf(':');
    const pre = i < 0 ? null : v.slice(0, i);
    const name = v.slice(i + 1);
    if (pre !== null) {
      return (pre === 'xs' || pre === 'xsd') && root.lookupNamespaceURI(pre) !== NS ? builtinQ(doc, name) : v;
    }
    const def = reg.complexTypes.get(name) || reg.simpleTypes.get(name);
    if (def) return qualify(root, name, def.ns);
    return BUILTIN.includes(name) ? builtinQ(doc, name) : v;
  }

  function typeNames(reg) {
    return [
      ...BUILTIN.map(n => 'xs:' + n),
      ...Array.from(reg.simpleTypes.keys()),
      ...Array.from(reg.complexTypes.keys()),
    ];
  }

  function restrictable(decl) {
    if (kids(decl, 'complexType').length) return false;
    const t = decl.getAttribute('type');
    if (t) return isBuiltinQ(decl, t);
    const st = kids(decl, 'simpleType')[0];
    if (!st) return true;
    const r = kids(st, 'restriction')[0];
    return !!r && r.hasAttribute('base');
  }

  const facetVal = (r, name) => {
    const f = r && kids(r, name)[0];
    return f ? f.getAttribute('value') || '' : '';
  };

  function ownerNote(n) {
    const el = n.el || n.useEl;
    if (!el) return null;
    let top = el;
    while (top.parentNode && top.parentNode !== top.ownerDocument.documentElement) top = top.parentNode;
    const nm = top.getAttribute && top.getAttribute('name');
    if (nm && ['complexType', 'group', 'attributeGroup'].includes(top.localName)) {
      return `Part of ${top.localName} “${nm}” – changes apply wherever it is used.`;
    }
    return null;
  }

  // ---------- form model ----------
  function describe(reg, n) {
    const decl = n.decl || n.el;
    const use = n.useEl || n.el;
    const isNamed = n.kind === 'element' || n.kind === 'attribute';
    const d = {
      kind: n.kind, isRef: !!n.isRef, name: n.name || '', owner: ownerNote(n),
      hasName: isNamed,
      isGlobal: n.kind === 'element' && use === decl && isRootChild(decl),
      hasUse: n.kind === 'attribute',
      min: String(n.min), max: n.max === Infinity ? 'unbounded' : String(n.max),
      use: n.min ? 'required' : 'optional',
      def: '', fixed: '', nillable: false, type: '', typeHint: '', doc: '',
      restrictable: false, minLength: '', maxLength: '', minInclusive: '', maxInclusive: '', patterns: [], enums: [],
    };
    d.hasOccurs = (n.kind === 'element' && !d.isGlobal) || n.isCompositor || n.kind === 'any';
    const docEl = isNamed ? decl : (n.el || use);
    d.doc = docEl ? docOf(docEl) : '';
    if (!isNamed) return d;
    d.def = decl.getAttribute('default') || '';
    d.fixed = decl.getAttribute('fixed') || '';
    d.nillable = decl.getAttribute('nillable') === 'true';
    const st = kids(decl, 'simpleType')[0];
    const r = st && kids(st, 'restriction')[0];
    d.type = decl.getAttribute('type') || (r ? r.getAttribute('base') || '' : '');
    d.typeHint = kids(decl, 'complexType')[0] ? '(inline complex type)' : st && !r ? '(inline list/union type)' : 'xs:anyType';
    d.restrictable = restrictable(decl);
    if (d.restrictable && r) {
      d.minLength = facetVal(r, 'minLength');
      d.maxLength = facetVal(r, 'maxLength');
      d.minInclusive = facetVal(r, 'minInclusive');
      d.maxInclusive = facetVal(r, 'maxInclusive');
      d.patterns = kids(r, 'pattern').map(f => f.getAttribute('value') || '');
      d.enums = kids(r, 'enumeration').map(f => f.getAttribute('value') || '');
    }
    return d;
  }

  function validate(d, v) {
    if (d.hasName && !d.isRef && !NAME_RE.test(v.name)) return 'The name must be a valid XML name (letters, digits, “_”, “-”, “.”; not starting with a digit).';
    if (d.hasOccurs) {
      if (!/^\d+$/.test(v.min)) return 'Min occurs must be a whole number (0 or more).';
      if (v.max !== 'unbounded' && !/^\d+$/.test(v.max)) return 'Max occurs must be a whole number or “unbounded”.';
      if (v.max !== 'unbounded' && +v.max < +v.min) return 'Max occurs cannot be smaller than min occurs.';
    }
    if (d.restrictable) {
      for (const k of ['minLength', 'maxLength']) if (v[k] && !/^\d+$/.test(v[k])) return 'Lengths must be whole numbers.';
      if (v.minLength && v.maxLength && +v.minLength > +v.maxLength) return 'Min length cannot be larger than max length.';
    }
    return null;
  }

  function typeReplacesContent(n, v) {
    const ct = n.decl && kids(n.decl, 'complexType')[0];
    if (!ct || !v.type.trim()) return null;
    const count = ct.getElementsByTagNameNS(NS, 'element').length + ct.getElementsByTagNameNS(NS, 'attribute').length;
    return `Setting a type replaces the inline complex type${count ? ` and its ${count} child node(s)` : ''}.`;
  }

  const facetKey = x => JSON.stringify([x.minLength, x.maxLength, x.minInclusive, x.maxInclusive, x.patterns, x.enums]);

  function setFacet(r, name, value) {
    const ex = kids(r, name)[0];
    if (!value) { if (ex) detach(ex); return; }
    if (ex) { ex.setAttribute('value', value); return; }
    const f = mk(r.ownerDocument, name);
    f.setAttribute('value', value);
    insert(r, f, null);
  }

  function setFacetList(r, name, values) {
    const existing = kids(r, name);
    const have = new Set(existing.map(e => e.getAttribute('value')));
    existing.filter(e => !values.includes(e.getAttribute('value'))).forEach(detach);
    for (const val of values) {
      if (have.has(val)) continue;
      const f = mk(r.ownerDocument, name);
      f.setAttribute('value', val);
      insert(r, f, null);
      have.add(val);
    }
  }

  function applyType(reg, n, v, o) {
    const decl = n.decl;
    const doc = decl.ownerDocument;
    const typeChanged = v.type.trim() !== o.type;
    const facetsChanged = o.restrictable && facetKey(v) !== facetKey(o);
    if (!typeChanged && !facetsChanged) return;
    const type = normType(reg, doc, v.type);
    let st = kids(decl, 'simpleType')[0];
    let r = st && kids(st, 'restriction')[0];
    const wants = o.restrictable && (v.minLength || v.maxLength || v.minInclusive || v.maxInclusive || v.patterns.length || v.enums.length);
    if (o.restrictable && (wants || r)) {
      if (!r) {
        const base = type || builtinQ(doc, 'string');
        decl.removeAttribute('type');
        st = mk(doc, 'simpleType');
        insert(decl, st, null);
        r = mk(doc, 'restriction');
        insert(st, r, null);
        r.setAttribute('base', base);
      } else if (typeChanged) {
        r.setAttribute('base', type || builtinQ(doc, 'string'));
      }
      setFacet(r, 'minLength', v.minLength);
      setFacet(r, 'maxLength', v.maxLength);
      setFacet(r, 'minInclusive', v.minInclusive);
      setFacet(r, 'maxInclusive', v.maxInclusive);
      setFacetList(r, 'pattern', v.patterns);
      setFacetList(r, 'enumeration', v.enums);
      if (kids(st).length === 1 && kids(r).length === 0) {
        decl.setAttribute('type', r.getAttribute('base'));
        detach(st);
      }
      return;
    }
    if (type) decl.setAttribute('type', type); else decl.removeAttribute('type');
    if (type && typeChanged) kids(decl, 'complexType').forEach(detach);
  }

  function apply(reg, n, v) {
    const o = describe(reg, n);
    const decl = n.decl || n.el;
    const use = n.useEl || n.el;
    if (o.hasName && !o.isRef && v.name !== o.name) {
      decl.setAttribute('name', v.name);
      if (isRootChild(decl) && decl.localName === 'element') {
        for (const { doc } of reg.docs) {
          for (const e of doc.getElementsByTagNameNS(NS, 'element')) {
            const r = e.getAttribute('ref');
            if (r && local(r) === o.name) e.setAttribute('ref', r.slice(0, r.length - o.name.length) + v.name);
          }
        }
      }
    }
    if (o.hasOccurs) {
      if (v.min !== o.min) setAttr(use, 'minOccurs', v.min, '1');
      if (v.max !== o.max) setAttr(use, 'maxOccurs', v.max, '1');
    }
    if (o.hasUse && v.use !== o.use) setAttr(use, 'use', v.use === 'required' ? 'required' : '', '');
    if (o.hasName) {
      if (v.def !== o.def) setAttr(decl, 'default', v.def, '');
      if (v.fixed !== o.fixed) setAttr(decl, 'fixed', v.fixed, '');
      if (n.kind === 'element' && v.nillable !== o.nillable) setAttr(decl, 'nillable', v.nillable ? 'true' : '', '');
      applyType(reg, n, v, o);
    }
    if (v.doc.trim() !== o.doc.trim()) setDoc(o.hasName ? decl : (n.el || use), v.doc);
  }

  // ---------- structure: add / remove / move ----------
  const contentOf = typeEl => {
    const cc = kids(typeEl, 'complexContent', 'simpleContent')[0];
    return (cc && kids(cc, 'extension', 'restriction')[0]) || typeEl;
  };

  function ensureHolder(container) {
    const h = kids(container, 'sequence', 'choice', 'all')[0];
    if (h) return h;
    if (kids(container, 'group').length) return null;
    const s = mk(container.ownerDocument, 'sequence');
    insert(container, s, kids(container, ...ATTRS)[0] || null);
    return s;
  }

  const labelOf = n => (n.name ? `“${n.name}”` : n.kind);

  // Validates an add; returns { error } or { confirm: message-or-null }.
  function plan(n, what) {
    if (what === 'sibling') {
      const el = n.useEl;
      if (!el || !n.parent || isRootChild(el)) return { error: 'Select a node inside a structure to add a sibling next to it.' };
      return { confirm: null };
    }
    if (n.isCompositor) {
      if (!n.el) return { error: 'This group is merged from an inherited type. Select a node inside it instead.' };
      if (what === 'attribute') return { error: 'Attributes belong to an element. Select the element instead.' };
      return { confirm: null };
    }
    if (n.kind !== 'element' || !n.decl) return { error: 'Children can only be added to elements and groups.' };
    const decl = n.decl;
    if (n.typeKind === 'unresolved') return { error: 'The type of this element cannot be found, so it cannot be extended. Open the schema file that defines it too.' };
    if (n.typeKind === 'complex') {
      const cont = contentOf(n.typeEl);
      if (what !== 'attribute') {
        if (kids(n.typeEl, 'simpleContent').length) return { error: 'This element holds text with attributes; it cannot contain child elements.' };
        if (!kids(cont, 'sequence', 'choice', 'all').length && kids(cont, 'group').length) return { error: 'This type is built from a group reference. Add children inside that group instead.' };
      }
      return { confirm: null };
    }
    if (n.typeKind === 'simple' || n.typeKind === 'builtin') {
      const t = decl.getAttribute('type');
      if (what === 'attribute') {
        if (!t) return { error: 'This element has an inline simple type; set a named type first or use a complex element.' };
        return { confirm: `${labelOf(n)} currently holds a simple value (${t}). Adding an attribute turns it into a complex type with simple content; the value type is kept.` };
      }
      return { confirm: `${labelOf(n)} currently holds a simple value (${t || 'inline simple type'}). Adding child elements turns it into a complex type and removes the simple type.` };
    }
    return { confirm: null };
  }

  function uniqueName(scopeEl, tag, base) {
    let top = scopeEl;
    while (top.parentNode && top.parentNode !== top.ownerDocument.documentElement) top = top.parentNode;
    const used = new Set(Array.from(top.getElementsByTagNameNS(NS, tag)).map(e => e.getAttribute('name')));
    if (!used.has(base)) return base;
    let i = 2;
    while (used.has(base + i)) i++;
    return base + i;
  }

  function newNode(scopeEl, what) {
    const doc = scopeEl.ownerDocument;
    const el = mk(doc, what);
    el.setAttribute('name', uniqueName(scopeEl, what, what === 'element' ? 'NewElement' : 'newAttribute'));
    el.setAttribute('type', builtinQ(doc, 'string'));
    return el;
  }

  function add(reg, n, what) {
    if (what === 'sibling') {
      const use = n.useEl;
      const parent = use.parentNode;
      const el = newNode(parent, n.kind === 'attribute' ? 'attribute' : 'element');
      insert(parent, el, use.nextElementSibling);
      return el;
    }
    let container;
    if (n.isCompositor) {
      container = n.el;
    } else {
      const decl = n.decl;
      const doc = decl.ownerDocument;
      let typeEl = n.typeKind === 'complex' ? n.typeEl : null;
      if (!typeEl) {
        const t = decl.getAttribute('type');
        decl.removeAttribute('type');
        kids(decl, 'simpleType').forEach(detach);
        typeEl = mk(doc, 'complexType');
        insert(decl, typeEl, null);
        if (what === 'attribute' && t) {
          const sc = mk(doc, 'simpleContent');
          insert(typeEl, sc, null);
          const ext = mk(doc, 'extension');
          ext.setAttribute('base', t);
          insert(sc, ext, null);
        }
      }
      container = contentOf(typeEl);
      if (what !== 'attribute') container = ensureHolder(container);
      if (!container) throw new Error('Cannot add here.');
    }
    const el = what === 'element' || what === 'attribute' ? newNode(container, what) : mk(container.ownerDocument, what);
    insert(container, el, null);
    return el;
  }

  function addGlobal(reg, file) {
    const entry = reg.docs.find(d => d.name === file) || reg.docs[0];
    const root = entry.doc.documentElement;
    const el = newNode(root, 'element');
    insert(root, el, null);
    return el;
  }

  function refCount(reg, n) {
    if (!n.decl || !isRootChild(n.decl) || n.kind !== 'element') return 0;
    let c = 0;
    for (const { doc } of reg.docs) {
      for (const e of doc.getElementsByTagNameNS(NS, 'element')) {
        const r = e.getAttribute('ref');
        if (r && local(r) === n.name) c++;
      }
    }
    return c;
  }

  const catOf = el => (ATTRS.includes(el.localName) ? 'a' : PARTICLES.includes(el.localName) ? 'p' : 'x');
  function neighbour(el, dir) {
    let s = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
    while (s && s.localName === 'annotation') s = dir < 0 ? s.previousElementSibling : s.nextElementSibling;
    return s && s.namespaceURI === NS && catOf(s) !== 'x' && catOf(s) === catOf(el) ? s : null;
  }

  const canMove = (n, dir) => !!n.useEl && !isRootChild(n.useEl) && !!neighbour(n.useEl, dir);

  function move(n, dir) {
    const el = n.useEl;
    const s = neighbour(el, dir);
    const parent = el.parentNode;
    const ref = dir < 0 ? s : s.nextElementSibling;
    detach(el);
    insert(parent, el, ref);
    return el;
  }

  function remove(n) {
    if (!n.useEl) throw new Error('Nothing to delete.');
    detach(n.useEl);
  }

  const blankSchema = () => `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" elementFormDefault="qualified">
  <xs:element name="Root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="Name" type="xs:string"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>
`;

  return { describe, validate, apply, plan, add, addGlobal, remove, move, canMove, refCount, typeNames, typeReplacesContent, blankSchema, clean };
})();
