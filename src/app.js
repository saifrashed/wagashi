'use strict';
/* Wagashi – application glue: file loading, search, details panel. */
(() => {
  const $ = id => document.getElementById(id);
  const diagram = new Diagram({
    viewport: $('viewport'), stage: $('stage'), nodesEl: $('nodes'), linesEl: $('lines'),
  });
  const state = { reg: null, root: null, flat: null, rootName: null, savedDepth: 0 };
  const hist = { undo: [], redo: [] };
  const SEARCH_INDEX_LIMIT = 150000;
  const EXPAND_ALL_LIMIT = 4000;

  const status = (msg, warn) => {
    $('status').textContent = msg;
    $('status').classList.toggle('warn', !!warn);
  };

  async function decode(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
    if (buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
    const head = new TextDecoder('latin1').decode(buf.subarray(0, 200));
    const enc = /encoding=["']([\w-]+)["']/i.exec(head);
    try { return new TextDecoder(enc ? enc[1] : 'utf-8').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
  }

  async function openFiles(list) {
    if (!(await confirmDiscard())) return;
    const files = Array.from(list).filter(f => /\.(xsd|xml)$/i.test(f.name));
    if (!files.length) { status('No .xsd files found in selection.', true); return; }
    status('Loading…');
    const loaded = [];
    for (const f of files) loaded.push({ name: f.webkitRelativePath || f.name, text: await decode(f) });
    loadSchemas(loaded);
  }

  function loadSchemas(loaded) {
    const reg = Xsd.load(loaded);
    if (!Xsd.roots(reg).length) {
      status(reg.errors.length ? reg.errors.join(' | ') : 'No global elements found in the selected schema(s).', true);
      return;
    }
    state.reg = reg;
    hist.undo = [];
    hist.redo = [];
    state.savedDepth = 0;
    refreshControls();
    openRoot(Xsd.guessRoot(reg));
    const warns = [];
    if (reg.errors.length) warns.push(`${reg.errors.length} file(s) skipped: ${reg.errors[0]}`);
    if (reg.unresolved.size) {
      const u = Array.from(reg.unresolved);
      warns.push(`${u.length} unresolved reference(s): ${u.slice(0, 3).join(', ')}${u.length > 3 ? '…' : ''} – open the referenced files together`);
    }
    status(`${reg.files.join(', ')} – ${reg.elements.size} global element(s)${warns.length ? ' – ' + warns.join(' – ') : ''}`, warns.length > 0);
  }

  function expandTo(n, depth) {
    n.expanded = true;
    for (const c of n.children) {
      if (c.isCompositor) expandTo(c, depth);
      else if (depth > 0 && c.kind === 'element') expandTo(c, depth - 1);
    }
  }

  function openRoot(name) {
    $('root-select').value = name;
    state.rootName = name;
    state.root = Xsd.makeRoot(state.reg, name);
    state.flat = null;
    expandTo(state.root, 1);
    resetSearch();
    diagram.setRoot(state.root);
    showDetails(null);
    $('viewport').scrollTo(0, 0);
    diagram.scrollTo(state.root);
  }

  // ---------- search ----------
  function nodeText(n) {
    const enums = n.info ? n.info.enums.map(e => e.value).join(' ') : '';
    return `${n.name} ${n.typeText} ${n.typeName || ''} ${n.doc} ${enums}`.toLowerCase();
  }

  function search() {
    const q = $('search').value.trim().toLowerCase();
    if (!q || !state.root) { resetSearch(); return; }
    if (!state.flat) state.flat = Xsd.flatten(state.root, SEARCH_INDEX_LIMIT);
    const { nodes, truncated } = state.flat;
    const byPath = q.startsWith('/');
    const terms = q.split(/\s+/);
    const out = [];
    for (const n of nodes) {
      if (n.isCompositor) continue;
      const ok = byPath ? n.xpath.toLowerCase().includes(q) : terms.every(t => nodeText(n).includes(t));
      if (ok) out.push(n);
      if (out.length >= 1000) break;
    }
    diagram.hits = new Set(out);
    diagram.rerender();
    renderResults(out, truncated);
  }

  function renderResults(list, truncated) {
    const box = $('results');
    box.innerHTML = '';
    box.hidden = false;
    if (!list.length) {
      const d = document.createElement('div');
      d.className = 'r-empty';
      d.textContent = 'No matches';
      box.append(d);
    }
    for (const n of list) {
      const row = document.createElement('div');
      row.className = 'r-row';
      row.textContent = '/ ' + n.pathNames.join(' / ');
      if (n.typeText) {
        const t = document.createElement('span');
        t.className = 'r-type';
        t.textContent = n.typeText;
        row.append(t);
      }
      row.addEventListener('click', () => {
        box.querySelectorAll('.r-row.active').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        diagram.reveal(n);
      });
      box.append(row);
    }
    status(`${list.length}${list.length >= 1000 ? '+' : ''} match(es)${truncated ? ' (index truncated for very large schema)' : ''}`);
  }

  function resetSearch() {
    $('search').value = '';
    $('results').hidden = true;
    $('results').innerHTML = '';
    if (diagram.hits.size) { diagram.hits = new Set(); diagram.rerender(); }
  }

  // ---------- details ----------
  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = old; }, 900);
  }

  function showDetails(n) {
    const box = $('details');
    box.innerHTML = '';
    if (!n) {
      box.innerHTML = '<div class="d-empty">Select a node to see its type, XPath and documentation.</div>';
      if (state.reg && state.reg.docs.length) {
        const bar = document.createElement('div');
        bar.className = 'd-actions';
        bar.append(button('+ Global element', 'Add a new top-level element to the schema', () => addGlobal()));
        box.prepend(bar);
      }
      return;
    }
    const add = (label, value, opts = {}) => {
      if (value == null || value === '' || value === false) return;
      const row = document.createElement('div');
      row.className = 'd-row';
      const l = document.createElement('div');
      l.className = 'd-label';
      l.textContent = label;
      const v = document.createElement('div');
      v.className = 'd-value' + (opts.mono ? ' mono' : '');
      v.textContent = value;
      row.append(l, v);
      if (opts.copy) {
        const b = document.createElement('button');
        b.className = 'copy';
        b.textContent = 'Copy';
        b.addEventListener('click', () => copy(value, b));
        row.append(b);
      }
      box.append(row);
    };
    const kindName = { element: 'Element', attribute: 'Attribute', sequence: 'Sequence', choice: 'Choice', all: 'All', any: 'Wildcard (any)' }[n.kind];
    const h = document.createElement('h2');
    h.textContent = n.isCompositor ? kindName : (n.kind === 'attribute' ? '@' : '') + n.name;
    box.append(h);
    box.append(actionBar(n));
    add('Kind', kindName);
    add(n.isCompositor ? 'Inside XPath' : 'XPath', n.xpath, { mono: true, copy: true });
    if (!n.isCompositor) add('XPath (any namespace)', n.xpathAnyNs, { mono: true, copy: true });
    if (n.kind === 'element' || n.kind === 'attribute') {
      const tk = { complex: 'Complex type', simple: 'Simple type', builtin: 'Built-in type', anyType: 'xs:anyType', unresolved: 'Unresolved' }[n.typeKind];
      add('Type', n.typeName || (n.typeKind === 'complex' ? '(anonymous complex type)' : n.typeText || 'xs:anySimpleType'));
      if (n.kind === 'element') add('Type kind', tk + (n.typeKind === 'complex' && !n.typeName ? ' (inline)' : ''));
    }
    if (n.info) {
      add('Base type', n.info.base);
      add('Restrictions', Object.entries(n.info.facets).map(([k, v]) => `${k}: ${v}`).join('\n'));
      add('Patterns', n.info.patterns.join('\n'), { mono: true });
    }
    if (n.kind === 'attribute') add('Use', n.min ? 'required' : 'optional');
    else {
      add('Occurs', `minOccurs ${n.min}, maxOccurs ${n.max === Infinity ? 'unbounded' : n.max}`);
      if (n.kind === 'element') add('Presence', n.min === 0 ? 'optional' : 'required');
    }
    add('Default', n.def);
    add('Fixed', n.fixed);
    add('Nillable', n.nillable && 'true');
    add('Abstract', n.abstract && 'true');
    add('Substitution group', n.substitutionGroup);
    add('Group', n.groupName);
    if (n.kind === 'any') add('Namespace', n.anyNs);
    if (n.recursive) add('Note', 'Recursive – this type is already used by an ancestor, so it is not expanded further.');
    add('Documentation', n.doc);
    if (n.info && n.info.enums.length) {
      const h3 = document.createElement('h3');
      h3.textContent = `Enumeration (${n.info.enums.length})`;
      box.append(h3);
      const ul = document.createElement('ul');
      ul.className = 'enum';
      for (const e of n.info.enums) {
        const li = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = e.value;
        li.append(code);
        if (e.doc) li.append(' – ' + e.doc);
        ul.append(li);
      }
      box.append(ul);
    }
    add('Namespace', n.ns || '(no namespace)');
    add('Source', n.file);
  }


  // ---------- modal ----------
  function ask(message, ok = 'OK', cancel = 'Cancel', danger = false) {
    return new Promise(resolve => {
      const m = $('modal');
      m.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'm-box';
      const p = document.createElement('p');
      p.textContent = message;
      const row = document.createElement('div');
      row.className = 'm-buttons';
      const done = v => {
        m.hidden = true;
        document.removeEventListener('keydown', onKey, true);
        resolve(v);
      };
      const onKey = e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
      };
      if (cancel) row.append(button(cancel, '', () => done(false)));
      const okBtn = button(ok, '', () => done(true));
      okBtn.classList.add(danger ? 'danger' : 'primary');
      row.append(okBtn);
      box.append(p, row);
      m.append(box);
      m.hidden = false;
      document.addEventListener('keydown', onKey, true);
      okBtn.focus();
    });
  }
  const tell = message => ask(message, 'OK', null);

  function button(label, title, onClick, extra) {
    const b = document.createElement('button');
    b.textContent = label;
    if (title) b.title = title;
    if (extra) b.className = extra;
    b.addEventListener('click', onClick);
    return b;
  }

  // ---------- history / state ----------
  const isDirty = () => hist.undo.length !== state.savedDepth;

  function refreshControls() {
    const has = !!(state.reg && state.reg.docs.length);
    const sel = $('root-select');
    sel.innerHTML = '';
    if (has) for (const name of Xsd.roots(state.reg)) sel.add(new Option(name, name));
    if (state.rootName) sel.value = state.rootName;
    sel.disabled = !has;
    ['search', 'btn-search', 'btn-reset', 'btn-expand', 'btn-collapse', 'btn-export'].forEach(id => { $(id).disabled = !has; });
    $('btn-undo').disabled = !hist.undo.length;
    $('btn-redo').disabled = !hist.redo.length;
    $('welcome').hidden = has;
    $('dirty').hidden = !isDirty();
  }

  function sigOf(n) {
    const parts = [];
    for (let c = n; c.parent; c = c.parent) parts.unshift(c.parent.children.indexOf(c));
    return parts.join('/');
  }

  function nodeAt(sig) {
    if (sig == null || !state.root) return null;
    let n = state.root;
    if (sig === '') return n;
    for (const i of sig.split('/')) {
      n = n.children[+i];
      if (!n) return null;
    }
    return n;
  }

  function collectExpanded() {
    const out = [];
    const walk = (n, sig) => {
      if (n.expanded) out.push(sig);
      if (n._children) n._children.forEach((c, i) => walk(c, sig === '' ? String(i) : `${sig}/${i}`));
    };
    if (state.root) walk(state.root, '');
    return out;
  }

  function findByEl(parent, el) {
    for (const c of parent.children) {
      if (c.useEl === el || c.el === el) return c;
      if (c.isCompositor) {
        const r = findByEl(c, el);
        if (r) return r;
      }
    }
    return null;
  }

  function snapshot() {
    return {
      files: Xsd.serialize(state.reg), rootName: state.rootName, expanded: collectExpanded(),
      sel: diagram.selected ? sigOf(diagram.selected) : null,
    };
  }

  // Rebuilds the diagram from the (edited) registry, keeping expansion and selection where possible.
  function install(reg, ctx) {
    state.reg = reg;
    const names = Xsd.roots(reg);
    $('search').value = '';
    $('results').hidden = true;
    $('results').innerHTML = '';
    diagram.hits = new Set();
    if (!names.length) {
      state.root = null;
      state.rootName = null;
      diagram.setRoot(null);
      showDetails(null);
      refreshControls();
      return;
    }
    const sameRoot = names.includes(ctx.rootName);
    state.rootName = sameRoot ? ctx.rootName : Xsd.guessRoot(reg);
    state.root = Xsd.makeRoot(reg, state.rootName);
    state.flat = null;
    state.root.expanded = true;
    if (sameRoot && ctx.expanded) {
      for (const sig of ctx.expanded) { const n = nodeAt(sig); if (n) n.expanded = true; }
    } else {
      expandTo(state.root, 1);
    }
    let sel = null;
    if (ctx.selEl && ctx.selParentSig != null) {
      const p = nodeAt(ctx.selParentSig);
      sel = p && findByEl(p, ctx.selEl);
    }
    if (!sel && ctx.selSig != null) sel = nodeAt(ctx.selSig);
    diagram.setRoot(state.root);
    refreshControls();
    if (sel) diagram.reveal(sel); else showDetails(null);
  }

  function restore(snap) {
    install(Xsd.load(snap.files), { rootName: snap.rootName, expanded: snap.expanded, selSig: snap.sel });
  }

  // Runs a mutation on the schema DOM with undo support. mutator returns hints for restoring selection.
  function commit(mutator) {
    const before = snapshot();
    let hint;
    try {
      hint = mutator() || {};
    } catch (e) {
      restore(before);
      tell(`Could not apply the change: ${e.message}`);
      return false;
    }
    hist.undo.push(before);
    if (hist.undo.length > 60) { hist.undo.shift(); state.savedDepth--; }
    hist.redo = [];
    install(Xsd.rebuild(state.reg), { rootName: state.rootName, expanded: before.expanded, selSig: before.sel, ...hint });
    return true;
  }

  function undo() {
    if (!hist.undo.length) return;
    hist.redo.push(snapshot());
    restore(hist.undo.pop());
  }
  function redo() {
    if (!hist.redo.length) return;
    hist.undo.push(snapshot());
    restore(hist.redo.pop());
  }

  async function confirmDiscard() {
    if (!isDirty()) return true;
    return ask('You have unsaved changes. Discard them?', 'Discard', 'Cancel', true);
  }

  // ---------- actions ----------
  const labelOf = n => (n.name ? `“${n.name}”` : n.kind);

  function actionBar(n) {
    const bar = document.createElement('div');
    bar.className = 'd-actions';
    const editable = n.kind === 'element' || n.kind === 'attribute' ? !!n.decl : !!n.el;
    const isElem = n.kind === 'element' && !!n.decl;
    const canChild = isElem || (n.isCompositor && !!n.el);
    const add = (label, title, enabled, fn, cls) => {
      const b = button(label, title, fn, cls);
      b.disabled = !enabled;
      bar.append(b);
    };
    add('Edit', 'Edit this node', editable, () => openEditor(n), 'primary');
    add('+ Element', 'Add a child element', canChild, () => addNode(n, 'element'));
    add('+ Attribute', 'Add an attribute to this element', isElem, () => addNode(n, 'attribute'));
    add('+ Sibling', 'Add a node next to this one', !!n.useEl && !!n.parent, () => addNode(n, 'sibling'));
    add('+ Choice', 'Add a choice group inside', canChild, () => addNode(n, 'choice'));
    add('+ Sequence', 'Add a sequence group inside', canChild, () => addNode(n, 'sequence'));
    add('↑', 'Move up', Edit.canMove(n, -1), () => moveNode(n, -1));
    add('↓', 'Move down', Edit.canMove(n, 1), () => moveNode(n, 1));
    add('Delete', 'Delete this node and everything below it', !!n.useEl, () => deleteNode(n), 'danger');
    return bar;
  }

  async function addNode(n, what) {
    const plan = Edit.plan(n, what);
    if (plan.error) { await tell(plan.error); return; }
    if (plan.confirm && !(await ask(plan.confirm, 'Continue'))) return;
    const selParentSig = what === 'sibling' ? sigOf(n.parent) : sigOf(n);
    let created;
    const ok = commit(() => {
      created = Edit.add(state.reg, n, what);
      return { selParentSig, get selEl() { return created; } };
    });
    const node = diagram.selected;
    if (ok && node && (what === 'element' || what === 'attribute' || what === 'sibling')) openEditor(node, true);
  }

  async function addGlobal() {
    let created;
    const ok = commit(() => {
      created = Edit.addGlobal(state.reg, state.root ? state.root.file : null);
      return { rootName: created.getAttribute('name'), expanded: null };
    });
    if (ok && state.root) { diagram.select(state.root); openEditor(state.root, true); }
  }

  async function deleteNode(n) {
    const refs = Edit.refCount(state.reg, n);
    const below = n.children.length ? ' and everything below it' : '';
    let msg = `Delete ${labelOf(n)}${below}?`;
    if (refs) msg += `\n\n${refs} other element(s) reference it and will become unresolved.`;
    const note = Edit.describe(state.reg, n).owner;
    if (note) msg += `\n\n${note}`;
    if (!(await ask(msg, 'Delete', 'Cancel', true))) return;
    const selSig = n.parent ? sigOf(n.parent) : null;
    commit(() => { Edit.remove(n); return { selSig }; });
  }

  function moveNode(n, dir) {
    commit(() => {
      const el = Edit.move(n, dir);
      return { selParentSig: sigOf(n.parent), selEl: el };
    });
  }

  // ---------- editor form ----------
  function openEditor(n, focusName) {
    const d = Edit.describe(state.reg, n);
    const box = $('details');
    box.innerHTML = '';
    const h = document.createElement('h2');
    h.textContent = `Edit ${d.kind === 'element' || d.kind === 'attribute' ? (d.kind === 'attribute' ? '@' : '') + d.name : d.kind}`;
    box.append(h);
    if (d.owner) { const o = document.createElement('div'); o.className = 'e-note'; o.textContent = d.owner; box.append(o); }
    const err = document.createElement('div');
    err.className = 'e-error';
    err.hidden = true;
    box.append(err);

    const f = {};
    const wrap = (label, ...nodes) => {
      const w = document.createElement('div');
      w.className = 'e-field';
      if (label) { const l = document.createElement('label'); l.textContent = label; w.append(l); }
      w.append(...nodes);
      return w;
    };
    const input = (type, value, extra = {}) => {
      const i = document.createElement('input');
      i.type = type;
      i.value = value;
      Object.assign(i, extra);
      return i;
    };
    const area = (value, mono) => {
      const t = document.createElement('textarea');
      t.value = value;
      if (mono) t.className = 'mono';
      return t;
    };
    const hint = text => { const e = document.createElement('div'); e.className = 'e-hint'; e.textContent = text; return e; };

    if (d.hasName) {
      f.name = input('text', d.name, { disabled: d.isRef, spellcheck: false });
      box.append(wrap('Name', f.name, ...(d.isRef ? [hint('This is a reference to a global element; rename that element instead.')] : [])));
      f.type = input('text', d.type, { placeholder: d.typeHint, spellcheck: false, autocomplete: 'off' });
      const dl = document.createElement('datalist');
      dl.id = 'type-list';
      for (const t of Edit.typeNames(state.reg)) dl.append(new Option(t));
      f.type.setAttribute('list', 'type-list');
      box.append(wrap('Type', f.type, dl));
    }
    if (d.hasOccurs) {
      f.min = input('number', d.min, { min: 0 });
      f.max = input('number', d.max === 'unbounded' ? '' : d.max, { min: 0 });
      f.unb = input('checkbox', '');
      f.unb.checked = d.max === 'unbounded';
      const syncMax = () => { f.max.disabled = f.unb.checked; };
      f.unb.addEventListener('change', syncMax);
      syncMax();
      const unbLabel = document.createElement('label');
      unbLabel.className = 'inline';
      unbLabel.append(f.unb, 'unbounded');
      const row = document.createElement('div');
      row.className = 'e-row';
      row.append(f.min, f.max, unbLabel);
      box.append(wrap('Occurs (min / max)', row));
    }
    if (d.hasUse) {
      f.use = document.createElement('select');
      f.use.add(new Option('optional', 'optional'));
      f.use.add(new Option('required', 'required'));
      f.use.value = d.use;
      box.append(wrap('Use', f.use));
    }
    if (d.hasName) {
      f.def = input('text', d.def);
      f.fixed = input('text', d.fixed);
      const row = document.createElement('div');
      row.className = 'e-row';
      row.append(wrap('Default', f.def), wrap('Fixed', f.fixed));
      box.append(row);
      if (d.kind === 'element') {
        f.nillable = input('checkbox', '');
        f.nillable.checked = d.nillable;
        const l = document.createElement('label');
        l.className = 'inline';
        l.append(f.nillable, 'nillable');
        box.append(wrap('', l));
      }
    }
    f.doc = area(d.doc);
    box.append(wrap('Documentation', f.doc));
    if (d.restrictable) {
      const fs = document.createElement('fieldset');
      const lg = document.createElement('legend');
      lg.textContent = 'Restrictions';
      fs.append(lg);
      f.minLength = input('text', d.minLength);
      f.maxLength = input('text', d.maxLength);
      f.minInclusive = input('text', d.minInclusive);
      f.maxInclusive = input('text', d.maxInclusive);
      const r1 = document.createElement('div');
      r1.className = 'e-row';
      r1.append(wrap('Min length', f.minLength), wrap('Max length', f.maxLength));
      const r2 = document.createElement('div');
      r2.className = 'e-row';
      r2.append(wrap('Min value', f.minInclusive), wrap('Max value', f.maxInclusive));
      f.patterns = area(d.patterns.join('\n'), true);
      f.enums = area(d.enums.join('\n'), true);
      fs.append(r1, r2, wrap('Pattern (regex, one per line)', f.patterns), wrap('Allowed values (one per line)', f.enums));
      box.append(fs);
    } else if (d.hasName) {
      box.append(hint('Restrictions are defined by the named type. Choose a built-in type to add restrictions here.'));
    }

    const lines = t => t.value.split('\n').map(x => x.trim()).filter(Boolean);
    const read = () => ({
      name: f.name ? f.name.value.trim() : d.name,
      type: f.type ? f.type.value.trim() : '',
      min: f.min ? f.min.value.trim() : d.min,
      max: f.unb ? (f.unb.checked ? 'unbounded' : f.max.value.trim()) : d.max,
      use: f.use ? f.use.value : d.use,
      def: f.def ? f.def.value : '', fixed: f.fixed ? f.fixed.value : '',
      nillable: f.nillable ? f.nillable.checked : false,
      doc: f.doc.value,
      minLength: f.minLength ? f.minLength.value.trim() : '', maxLength: f.maxLength ? f.maxLength.value.trim() : '',
      minInclusive: f.minInclusive ? f.minInclusive.value.trim() : '', maxInclusive: f.maxInclusive ? f.maxInclusive.value.trim() : '',
      patterns: f.patterns ? lines(f.patterns) : [], enums: f.enums ? lines(f.enums) : [],
    });

    const cancel = () => showDetails(diagram.selected === n ? n : diagram.selected);
    const save = async () => {
      const v = read();
      const problem = Edit.validate(d, v);
      if (problem) { err.textContent = problem; err.hidden = false; return; }
      const warn = Edit.typeReplacesContent(n, v);
      if (warn && !(await ask(warn + ' Continue?', 'Continue'))) return;
      const wasRoot = n === state.root;
      const selSig = sigOf(n);
      commit(() => {
        Edit.apply(state.reg, n, v);
        return { selSig, ...(wasRoot && d.hasName && !d.isRef ? { rootName: v.name } : {}) };
      });
    };
    const row = document.createElement('div');
    row.className = 'e-buttons';
    row.append(button('Save', 'Apply changes (Ctrl/Cmd+Enter)', save, 'primary'), button('Cancel', 'Discard changes (Esc)', cancel));
    box.append(row);
    box.onkeydown = e => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox'))) { e.preventDefault(); save(); }
    };
    const first = focusName && f.name && !f.name.disabled ? f.name : (f.name || f.doc);
    first.focus();
    if (first === f.name) first.select();
  }

  // ---------- export ----------
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function exportSchemas() {
    if (!state.reg || !state.reg.docs.length) return;
    const files = Xsd.serialize(state.reg);
    const top = files[0].name.split('/')[0];
    const strip = files.length > 1 && files.every(f => f.name.includes('/') && f.name.split('/')[0] === top) ? 1 : 0;
    const out = files.map(f => ({ name: f.name.split('/').slice(strip).join('/'), text: f.text }));
    const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    try {
      if (invoke) {
        const where = await invoke('export_files', { files: out });
        if (!where) return;
        status(`Exported to ${where}`);
      } else {
        out.forEach((f, i) => setTimeout(() => download(f.name.split('/').pop(), f.text), i * 300));
        status(`Exported ${out.length} file(s)`);
      }
      state.savedDepth = hist.undo.length;
      refreshControls();
    } catch (e) {
      tell(`Export failed: ${e}`);
    }
  }

  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-export').addEventListener('click', exportSchemas);
  window.addEventListener('beforeunload', e => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

  diagram.onSelect = showDetails;

  // ---------- toolbar ----------
  $('btn-open').addEventListener('click', () => { $('file-input').value = ''; $('file-input').click(); });
  $('btn-folder').addEventListener('click', () => { $('folder-input').value = ''; $('folder-input').click(); });
  $('file-input').addEventListener('change', e => openFiles(e.target.files));
  $('folder-input').addEventListener('change', e => openFiles(e.target.files));
  const loadText = async (name, text, unsaved) => {
    if (!(await confirmDiscard())) return;
    loadSchemas([{ name, text }]);
    if (unsaved) { state.savedDepth = -1; refreshControls(); }
  };
  const loadSample = () => loadText('sample.xsd', SAMPLE_XSD);
  const loadNew = () => loadText('new-schema.xsd', Edit.blankSchema(), true);
  $('btn-sample').addEventListener('click', loadSample);
  $('btn-sample2').addEventListener('click', loadSample);
  $('btn-new').addEventListener('click', loadNew);
  $('btn-new2').addEventListener('click', loadNew);
  $('root-select').addEventListener('change', e => openRoot(e.target.value));
  $('btn-search').addEventListener('click', search);
  $('btn-reset').addEventListener('click', resetSearch);
  $('search').addEventListener('keydown', e => {
    if (e.key === 'Enter') search();
    else if (e.key === 'Escape') resetSearch();
  });
  const bindOpt = (id, key) => $(id).addEventListener('change', e => { diagram.opts[key] = e.target.checked; diagram.rerender(); });
  bindOpt('chk-ann', 'showAnn');
  bindOpt('chk-type', 'showType');
  bindOpt('chk-attr', 'showAttr');

  $('btn-expand').addEventListener('click', () => {
    if (!state.root) return;
    let count = 0;
    let capped = false;
    const queue = [state.root];
    while (queue.length) {
      const n = queue.shift();
      if (count > EXPAND_ALL_LIMIT) { capped = true; break; }
      count++;
      n.expanded = true;
      queue.push(...n.children);
    }
    diagram.render();
    status(capped ? `Expanded the first ${EXPAND_ALL_LIMIT} nodes (schema is large).` : 'Expanded all.');
  });
  $('btn-collapse').addEventListener('click', () => {
    if (!state.root) return;
    const walk = n => { n.expanded = false; if (n._children) n._children.forEach(walk); };
    walk(state.root);
    state.root.expanded = true;
    diagram.render();
  });

  const zoom = d => {
    diagram.setZoom(diagram.zoom + d);
    $('zoom-label').textContent = Math.round(diagram.zoom * 100) + '%';
  };
  $('btn-zoom-in').addEventListener('click', () => zoom(0.1));
  $('btn-zoom-out').addEventListener('click', () => zoom(-0.1));
  $('viewport').addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 0.1 : -0.1); }
  }, { passive: false });

  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (!mod) {
      if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && $('modal').hidden && diagram.selected && diagram.selected.useEl) {
        e.preventDefault();
        deleteNode(diagram.selected);
      }
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); exportSchemas(); return; }
    if (k === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (k === 'y' && !typing) { e.preventDefault(); redo(); return; }
    if (k === 'f') { e.preventDefault(); $('search').focus(); $('search').select(); }
    else if (k === 'o') { e.preventDefault(); $('btn-open').click(); }
    else if (k === '=' || k === '+') { e.preventDefault(); zoom(0.1); }
    else if (k === '-') { e.preventDefault(); zoom(-0.1); }
  });

  // ---------- drag & drop ----------
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('dropzone').hidden = false; });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropzone').hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').hidden = true;
    if (e.dataTransfer && e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
  });
})();
