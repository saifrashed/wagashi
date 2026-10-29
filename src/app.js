'use strict';
/* Atorasu – application glue: file loading, search, details panel. */
(() => {
  const $ = id => document.getElementById(id);
  const diagram = new Diagram({
    viewport: $('viewport'), stage: $('stage'), nodesEl: $('nodes'), linesEl: $('lines'),
  });
  const state = { reg: null, root: null, flat: null };
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
    const sel = $('root-select');
    sel.innerHTML = '';
    for (const name of Xsd.roots(reg)) sel.add(new Option(name, name));
    sel.disabled = false;
    ['search', 'btn-search', 'btn-reset', 'btn-expand', 'btn-collapse'].forEach(id => { $(id).disabled = false; });
    $('welcome').hidden = true;
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

  diagram.onSelect = showDetails;

  // ---------- toolbar ----------
  $('btn-open').addEventListener('click', () => { $('file-input').value = ''; $('file-input').click(); });
  $('btn-folder').addEventListener('click', () => { $('folder-input').value = ''; $('folder-input').click(); });
  $('file-input').addEventListener('change', e => openFiles(e.target.files));
  $('folder-input').addEventListener('change', e => openFiles(e.target.files));
  const loadSample = () => loadSchemas([{ name: 'sample.xsd', text: SAMPLE_XSD }]);
  $('btn-sample').addEventListener('click', loadSample);
  $('btn-sample2').addEventListener('click', loadSample);
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
    if (!mod) return;
    const k = e.key.toLowerCase();
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
