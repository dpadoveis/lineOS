import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import {
  ACCENT,
  GROUP_COLOR,
  GROUP_COLORS,
  GROUP_HEAD,
  GROUP_NEW_HEIGHT,
  GROUP_NEW_WIDTH,
  HISTORY_LIMIT,
  NODE_MAX_HEIGHT,
  NODE_MAX_WIDTH,
  NODE_MIN_HEIGHT,
  NODE_MIN_WIDTH,
  NODE_WIDTH,
  TOOLS
} from './constants.js';
import {
  boundsForGroup,
  clampGroupHeight,
  clampGroupWidth,
  clipToBorder,
  newUid,
  nextId,
  nodeHeight,
  nodeWidth,
  reconcileGroups,
  shade,
  snapValue
} from './geometry.js';
import { download, flowFromPayload, flowPayload, isFlowGraph, nodeFromPayload, nodePayload } from './payload.js';
import { flowPngBlob, saveFlowAsPng } from './exportPng.js';
import * as api from './api.js';
import { organizeLayout } from './organize.js';

const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 560;
const SIDEBAR_DEFAULT = 290;

const initialState = {
  q: '',
  // Tool sidebar: collapsible and resizable, with no button in the header.
  // Width and state live in localStorage so they survive a reload.
  boxOpen: true,
  sidebarWidth: SIDEBAR_DEFAULT,
  saveOpen: false,
  // The Actions dropdown (import, sharing), anchored on its own header button.
  // It lives next to saveOpen because the two close in the same situations --
  // and never stand open together.
  actionsOpen: false,
  // A blank document: the editor is now always reached through the home,
  // either opening a flow or on "New diagram" -- there is no demo plane left.
  nodes: [],
  edges: [],
  // Group boxes: {id, name, x, y, w, h, col}. They are drawn behind the nodes
  // and hold no list of members -- whichever nodes rest inside the rectangle
  // belong to it (node.g, rewritten by reconcileGroups on every move).
  groups: [],
  pan: { x: 0, y: 0 },
  scale: 1,
  cursor: { x: 0, y: 0 },
  drag: null,
  // Dragging the resize handle: {id, sx, sy, w0, h0} in world coordinates, so
  // the result does not depend on the zoom.
  resize: null,
  // Dragging / resizing a group box. `gdrag.mates` is the list of nodes inside
  // the box when the drag started, with their offset from its corner: that is
  // what makes the box carry its content.
  gdrag: null,
  gresize: null,
  panning: null,
  link: null,
  // The node whose name is being edited, and the field's draft.
  renaming: null,
  renameDraft: '',
  hover: null,
  sel: null,
  // Ctrl+click piles nodes up here (the ids). `sel` still marks the last one
  // touched; `multi` is what "create group" and a multiple drag work on. It is
  // emptied as soon as a plain click lands anywhere.
  multi: [],
  // The group being renamed inline, and its draft; and the group whose colour
  // palette is open in the header.
  gRenaming: null,
  gRenameDraft: '',
  palette: null,
  menu: null,
  clip: null,
  theme: 'dark',
  status: '',
  // ── Server persistence ──
  // flow: the open flow ({id, slug, name, version, hasDraft}), or null while
  // the document exists only in this tab.
  flow: null,
  dirty: false,
  saving: false,
  // Number of the version merely being viewed (null = the current document).
  viewing: null,
  library: { open: false, items: [], carregando: false, busca: '', lixeira: false },
  // `versions.open` is the history dropdown, anchored on the document name.
  versions: { open: false, items: [], arquivos: [], carregando: false },
  // ── Tool catalog ──
  // The built-in ones come from TOOLS; these are the ones users registered on
  // the server (GET /api/tools), and they show up at the top of the list.
  tools: { custom: [], loading: false },
  // The tool modal serves two gestures: registering a new tool and editing one
  // already registered. `mode` says which, and in 'edit' the modal picks the
  // tool itself, from a dropdown of the ones this server holds.
  toolModal: { open: false, saving: false, error: null, mode: 'create' },
  // Where the tool being edited is used, asked of the server when the modal
  // picks one. `key` says which tool the answer is about, so a stale reply
  // never unlocks the delete button of another tool.
  toolUsage: { key: null, loading: false, count: 0, flows: [], error: false },
  // ── Permission on the open flow ──
  // 'view' | 'edit' | 'full'. A new flow (not yet saved) is always 'full'.
  // The server decides: this only avoids offering what would be refused.
  permission: 'full',
  isOwner: true,
  // The sharing dropdown, anchored on the header's Share button.
  share: { open: false, loading: false, state: null, error: null, notice: null },
  // Undo / redo: only what the header needs to enable the two buttons. The
  // stacks themselves live in histRef, outside the state (they must not
  // re-render).
  history: { canUndo: false, canRedo: false }
};

function reducer(state, patch) {
  return { ...state, ...patch };
}

export function useFlowEditor(options = {}) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [heights, setHeights] = useState({});
  const viewportRef = useRef(null);
  const nodeElRefs = useRef(new Map());
  const afterCommitRef = useRef(null);

  // Resolve function-form patches eagerly against this render's `state`
  // (always current, since handlers are recreated every render) instead of
  // handing the function to dispatch/reducer to resolve later - dispatching
  // functions as useReducer actions here triggered a runaway re-render loop.
  const setState = (patch, cb) => {
    dispatch(typeof patch === 'function' ? patch(state) : patch);
    if (cb) afterCommitRef.current = cb;
  };

  useEffect(() => {
    if (afterCommitRef.current) {
      const cb = afterCommitRef.current;
      afterCommitRef.current = null;
      cb();
    }
  });

  const nh = (n) => nodeHeight(n, heights);
  const nw = (n) => nodeWidth(n);
  // A flow shared as 'view' opens normally and accepts no change; 'full' is
  // the one that also shares and deletes.
  const canEdit = state.permission !== 'view';
  const canManage = state.permission === 'full';
  // Used as `if (readOnly()) return;` at the head of every action that changes
  // the document -- the server would refuse anyway, and saying so here beats
  // letting someone edit only to lose the work on save.
  const readOnly = () => {
    if (canEdit) return false;
    setState({ status: 'view only — this diagram was shared with you as read-only' });
    return true;
  };
  // Displayed name: the custom one when there is one, else the stack's.
  const title = (n) => n.label || n.n;
  const light = state.theme === 'light';
  const inkAccent = light ? shade(ACCENT, 0.62) : ACCENT;

  const registerNodeRef = (id) => (el) => {
    if (el) nodeElRefs.current.set(id, el);
    else nodeElRefs.current.delete(id);
  };

  // Mirrors the original applyView() height-measurement pass: after any
  // change to node content/layout, re-measure real DOM heights so edge
  // clipping and layout math track actual (not estimated) node size.
  useLayoutEffect(() => {
    setHeights((prev) => {
      let changed = false;
      const hs = {};
      nodeElRefs.current.forEach((el, id) => {
        const oh = el.offsetHeight;
        hs[id] = oh;
        if (prev[id] !== oh) changed = true;
      });
      return changed && Object.keys(hs).length ? hs : prev;
    });
  }, [state.nodes]);

  function fitScale(r) {
    // Boxes count as much as cards: a flow holding only an empty group still
    // has something to frame.
    const boxes = state.nodes
      .map((n) => ({ x: n.x, y: n.y, w: nw(n), h: nh(n) }))
      .concat(state.groups.map((g) => ({ x: g.x, y: g.y, w: g.w, h: g.h })));
    if (!boxes.length) return 1;
    const ext = boxes.reduce(
      (a, b) => ({
        x: Math.max(a.x, Math.abs(b.x), Math.abs(b.x + b.w)),
        y: Math.max(a.y, Math.abs(b.y), Math.abs(b.y + b.h))
      }),
      { x: 1, y: 1 }
    );
    return Math.min((r.width / 2 - 30) / ext.x, (r.height / 2 - 30) / ext.y);
  }

  const center = () => {
    const el = viewportRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const ns = Math.min(1, Math.max(0.4, fitScale(r)));
    setState({ pan: { x: Math.round(r.width * 0.5), y: Math.round(r.height * 0.5) }, scale: ns });
  };

  useEffect(() => {
    let t = null;
    try {
      t = localStorage.getItem('flow-theme');
    } catch (err) {
      t = null;
    }
    let prefs = {};
    if (t === 'light' || t === 'dark') prefs.theme = t;
    try {
      const w = parseInt(localStorage.getItem('flow-sidebar-width'), 10);
      if (w) prefs.sidebarWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w));
      const open = localStorage.getItem('flow-sidebar-open');
      if (open === '0' || open === '1') prefs.boxOpen = open === '1';
    } catch (err) {
      /* localStorage blocked: the defaults apply */
    }
    if (Object.keys(prefs).length) setState(prefs);
    loadCustomTools();
    // The route decides what to open: #/flow/<ref> loads from the server,
    // #/new starts blank.
    if (options.flowRef) openFlow(options.flowRef);
    else requestAnimationFrame(() => center());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', state.theme || 'dark');
  }, [state.theme]);

  useEffect(() => {
    function onKeyDown(e) {
      const t = e.target || {};
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
      // With the modal open the plane's shortcuts are suspended (the modal
      // handles Esc itself): otherwise Delete would remove a node behind the
      // window.
      if (state.toolModal.open) return;
      const k = (e.key || '').toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (k === 'c') {
          copySelected();
          e.preventDefault();
        }
        if (k === 'v') {
          pasteNode();
          e.preventDefault();
        }
        if (k === 's') {
          saveVersion();
          e.preventDefault();
        }
        if (k === 'd') {
          const s = state.sel;
          if (s && s.type === 'node') {
            duplicate(s.id);
            e.preventDefault();
          }
        }
        if (k === 'g') {
          groupSelection();
          e.preventDefault();
        }
        // Ctrl+Z undoes, Ctrl+Y (or Ctrl+Shift+Z) redoes. Inside a text field
        // the shortcut never reaches here -- the browser's own undo applies.
        if (k === 'z') {
          if (e.shiftKey) redo();
          else undo();
          e.preventDefault();
        }
        if (k === 'y') {
          redo();
          e.preventDefault();
        }
        return;
      }
      if (k === 'escape') {
        setState({ menu: null, saveOpen: false, actionsOpen: false, link: null, palette: null, multi: [] });
        if (state.renaming) cancelRename();
        if (state.gRenaming) cancelGroupRename();
      }
      if (k === 'f2') {
        const s = state.sel;
        if (s && s.type === 'node') {
          startRename(s.id);
          e.preventDefault();
        } else if (s && s.type === 'group') {
          startGroupRename(s.id);
          e.preventDefault();
        }
      }
      if (k === 'delete' || k === 'backspace') {
        const s = state.sel;
        // Several nodes selected: the key clears the whole selection at once.
        if (state.multi.length > 1) removeNodes(state.multi);
        else if (s && s.type === 'node') removeNode(s.id);
        else if (s && s.type === 'edge') removeEdge(s.id);
        // Deleting a box never deletes what it holds -- "Delete group and
        // nodes" in the context menu is the explicit way to do that.
        else if (s && s.type === 'group') removeGroup(s.id);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  function toWorld(e) {
    const el = viewportRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const { pan, scale } = state;
    return { x: (e.clientX - r.left - pan.x) / scale, y: (e.clientY - r.top - pan.y) / scale };
  }
  const snap = (v) => snapValue(v);
  // Membership is geometry: after anything that moves, adds or resizes a node,
  // this re-answers "which box is it in?" for every node at once. It returns
  // the same array when no answer changed, so it costs nothing on the paths
  // where no group is involved.
  const settle = (nodes, groups) => reconcileGroups(nodes, groups || state.groups, heights);

  const addTool = (t) => {
    if (readOnly()) return;
    const el = viewportRef.current;
    const r = el ? el.getBoundingClientRect() : { width: 900, height: 600 };
    const { pan, scale } = state;
    const j = (state.nodes.length % 5) * 34;
    const x = snap((r.width * 0.55 - pan.x) / scale - NODE_WIDTH / 2 + j);
    const y = snap((r.height * 0.5 - pan.y) / scale - 48 + j);
    const id = nextId(state.nodes);
    setState((s) => ({
      nodes: settle(
        s.nodes.concat([
          // `tool` keeps the custom tool's slug (null for the built-in ones):
          // it is what resolves the icon at draw time.
          { id, n: t.n, c: t.c, k: t.k, col: t.col, x, y, desc: null, meta: [], tool: t.slug || null, g: null, uid: newUid() }
        ]),
        s.groups
      ),
      sel: { type: 'node', id },
      multi: [],
      status: t.n + ' added'
    }));
  };

  // `tag` groups consecutive changes into a single history step -- see the
  // "Undo / redo" block. Typing a description always passes the same label.
  const patch = (id, fields, tag) => {
    if (readOnly()) return;
    if (tag) tagHistory(tag);
    setState((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...fields } : n)) }));
  };

  const removeNode = (id) => {
    if (readOnly()) return;
    return setState((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      edges: s.edges.filter((e) => e.from !== id && e.to !== id),
      sel: null,
      multi: s.multi.filter((x) => x !== id),
      menu: null,
      status: 'node removed'
    }));
  };

  // The multiple version, for a Ctrl+click selection.
  const removeNodes = (ids) => {
    if (readOnly()) return;
    const doomed = new Set(ids);
    if (!doomed.size) return;
    setState((s) => ({
      nodes: s.nodes.filter((n) => !doomed.has(n.id)),
      edges: s.edges.filter((e) => !doomed.has(e.from) && !doomed.has(e.to)),
      sel: null,
      multi: [],
      menu: null,
      status: doomed.size + ' nodes removed'
    }));
  };

  const editEdge = (id) => {
    if (readOnly()) return;
    setState(
      (s) => ({
        edges: s.edges.map((x) => (x.id === id ? { ...x, label: x.label === null || x.label === undefined ? '' : x.label } : x)),
        sel: { type: 'edge', id },
        menu: null,
        status: 'describe the edge (input, output…)'
      }),
      () =>
        setTimeout(() => {
          const el = document.querySelector('[data-elabel="' + id + '"]');
          if (el) {
            el.focus();
            el.select();
          }
        }, 30)
    );
  };
  const removeEdge = (id) => {
    if (readOnly()) return;
    setState((s) => ({ edges: s.edges.filter((e) => e.id !== id), sel: null, status: 'edge removed' }));
  };

  const duplicate = (id) => {
    if (readOnly()) return;
    const src = state.nodes.find((n) => n.id === id);
    if (!src) return;
    const nid = nextId(state.nodes);
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = nid;
    copy.x = snap(src.x + 48);
    copy.y = snap(src.y + 48);
    copy.uid = newUid();
    setState((s) => ({
      nodes: settle(s.nodes.concat([copy]), s.groups),
      sel: { type: 'node', id: nid },
      multi: [],
      menu: null,
      status: 'node duplicated'
    }));
  };

  function write(text, msg) {
    setState({ clip: text, menu: null, saveOpen: false, status: msg });
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => setState({ status: 'copied internally (clipboard blocked)' }));
    }
  }
  const copyMeta = (id) => {
    const n = state.nodes.find((x) => x.id === id);
    if (!n) return;
    write(JSON.stringify(nodePayload(n), null, 2), n.n + ' metadata copied');
  };
  const copySelected = () => {
    const s = state.sel;
    if (!s || s.type !== 'node') {
      setState({ status: 'select a node to copy' });
      return;
    }
    copyMeta(s.id);
  };
  function addFromPayload(p, at) {
    // A whole-flow JSON (flow.json, "Copy flow") replaces the document; a
    // single-node JSON is appended to the current plane.
    if (isFlowGraph(p)) {
      const doc = flowFromPayload(p);
      if (!doc) return false;
      applyDocument(doc, null, doc.nodes.length + ' nodes pasted as a new flow');
      return true;
    }
    const node = nodeFromPayload(p, state.nodes, at);
    if (!node) return false;
    setState((s) => ({
      // Pasted into a box, it joins the group; pasted outside, it joins none.
      nodes: settle(s.nodes.concat([node]), s.groups),
      sel: { type: 'node', id: node.id },
      multi: [],
      menu: null,
      status: node.n + ' pasted'
    }));
    return true;
  }
  const pasteNode = (at) => {
    if (readOnly()) return;
    const local = state.clip;
    const tryText = (txt) => {
      try {
        return addFromPayload(JSON.parse(txt), at);
      } catch (err) {
        return false;
      }
    };
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard
        .readText()
        .then((txt) => {
          if (!tryText(txt) && local) tryText(local);
        })
        .catch(() => {
          if (local) tryText(local);
          else setState({ status: 'nothing to paste' });
        });
    } else if (local) tryText(local);
    else setState({ status: 'nothing to paste' });
  };

  // File import: the same reading as "Copy flow (JSON)", only the source is a
  // .json from disk. A whole flow replaces the document and arrives unsaved
  // (flow: null), so nothing on the server is overwritten by accident; a
  // single-node JSON lands on the current plane.
  const importJson = (file) => {
    if (!file || readOnly()) return;
    setState({ actionsOpen: false, menu: null, status: 'reading ' + file.name + '…' });
    const reader = new FileReader();
    reader.onerror = () => setState({ status: 'could not read ' + file.name });
    reader.onload = () => {
      let p = null;
      try {
        p = JSON.parse(String(reader.result));
      } catch (err) {
        setState({ status: file.name + ': invalid JSON' });
        return;
      }
      if (isFlowGraph(p)) {
        const doc = flowFromPayload(p);
        if (!doc) {
          setState({ status: file.name + ': flow JSON is malformed' });
          return;
        }
        applyDocument(doc, null, doc.nodes.length + ' nodes imported from ' + file.name + ' — save it to keep it', {
          permission: 'full',
          isOwner: true
        });
        return;
      }
      if (!addFromPayload(p)) setState({ status: file.name + ': not a flow or node JSON' });
    };
    reader.readAsText(file);
  };

  const saveJson = () => {
    download(new Blob([JSON.stringify(flowPayload(state.nodes, state.edges, state.groups), null, 2)], { type: 'application/json' }), 'flow.json');
    setState({ saveOpen: false, status: 'flow.json downloaded' });
  };
  const copyJson = () => write(JSON.stringify(flowPayload(state.nodes, state.edges, state.groups), null, 2), 'flow copied as JSON');
  const savePng = () => {
    if (!state.nodes.length && !state.groups.length) {
      setState({ saveOpen: false, status: 'nothing to export' });
      return;
    }
    saveFlowAsPng(state.nodes, state.edges, state.groups, heights, inkAccent, iconBySlug);
    setState({ saveOpen: false, status: 'flow.png downloaded' });
  };

  const organize = () => {
    if (readOnly() || !state.nodes.length) return;
    const { positions, layerCount } = organizeLayout(state.nodes, state.edges, nh);
    setState(
      (s) => ({
        // The automatic layout ignores the boxes, so the nodes it moves may
        // well land in another one -- settle() is what keeps that honest.
        nodes: settle(s.nodes.map((n) => (positions[n.id] ? { ...n, ...positions[n.id] } : n)), s.groups),
        status: 'organized into ' + layerCount + ' layers, no overlap'
      }),
      () => center()
    );
  };

  // ── Server persistence ────────────────────────────────────────────
  // The document goes to the API in the same format as the file export
  // (flowPayload), which is the contract documented in the README.

  // Async handlers cannot read `state` after an await (the closure belongs to
  // the previous render); these refs always carry the freshly committed value.
  const docRef = useRef({ nodes: [], edges: [], groups: [], flow: null });
  docRef.current = { nodes: state.nodes, edges: state.edges, groups: state.groups, flow: state.flow };

  const libRef = useRef(initialState.library);
  libRef.current = state.library;
  const lib = (fields) => {
    libRef.current = { ...libRef.current, ...fields };
    setState({ library: libRef.current });
  };

  // The catalog of registered tools.
  const toolsRef = useRef(initialState.tools);
  toolsRef.current = state.tools;
  const setTools = (fields) => {
    toolsRef.current = { ...toolsRef.current, ...fields };
    setState({ tools: toolsRef.current });
  };

  const versionsRef = useRef(initialState.versions);
  versionsRef.current = state.versions;
  const setVersions = (fields) => {
    versionsRef.current = { ...versionsRef.current, ...fields };
    setState({ versions: versionsRef.current });
  };

  // ── Undo / redo ───────────────────────────────────────────────────
  // The versioned document is the triple (nodes, edges, groups). Each step
  // keeps the three array references -- the reducer never mutates in place, so
  // copying the reference already freezes the state of that instant.
  //
  // The push is done by an effect on nodes/edges rather than by each action:
  // that way no new path has to remember to stack anything. The price is
  // having to GROUP (histTagRef): a drag changes the nodes on every mousemove
  // and typing a description changes them on every key -- without a label, one
  // Ctrl+Z would undo a single pixel or a single letter. A `live:*` label
  // groups until the mouse comes up; the others group by 1.5 s of inactivity.
  const histRef = useRef({ past: [], future: [], tag: null, at: 0 });
  const docSnapRef = useRef({ nodes: initialState.nodes, edges: initialState.edges, groups: initialState.groups });
  const histTagRef = useRef(null);
  // Set when undo/redo itself (or a document switch) writes nodes/edges: that
  // change must not become a new step.
  const histSkipRef = useRef(false);

  const tagHistory = (tag) => {
    histTagRef.current = tag;
  };
  const endHistoryStroke = () => {
    histRef.current.tag = null;
  };
  const resetHistory = () => {
    histRef.current = { past: [], future: [], tag: null, at: 0 };
    histSkipRef.current = true;
  };

  useEffect(() => {
    const prev = docSnapRef.current;
    if (prev.nodes === state.nodes && prev.edges === state.edges && prev.groups === state.groups) return;
    docSnapRef.current = { nodes: state.nodes, edges: state.edges, groups: state.groups };
    const h = histRef.current;
    const tag = histTagRef.current;
    histTagRef.current = null;
    if (!histSkipRef.current) {
      const now = Date.now();
      const sameStroke =
        h.past.length &&
        tag &&
        tag === h.tag &&
        (tag.indexOf('live:') === 0 || now - h.at < 1500);
      if (!sameStroke) {
        h.past.push(prev);
        if (h.past.length > HISTORY_LIMIT) h.past.shift();
      }
      h.future = [];
      h.tag = tag;
      h.at = now;
    }
    histSkipRef.current = false;
    const canUndo = h.past.length > 0;
    const canRedo = h.future.length > 0;
    if (canUndo !== state.history.canUndo || canRedo !== state.history.canRedo) {
      setState({ history: { canUndo, canRedo } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.nodes, state.edges, state.groups]);

  // State dropped on undo/redo: selection, menus and any interaction in
  // progress would point at nodes that may no longer exist.
  const cleanForHistory = {
    sel: null,
    multi: [],
    menu: null,
    link: null,
    drag: null,
    resize: null,
    gdrag: null,
    gresize: null,
    palette: null,
    renaming: null,
    renameDraft: '',
    gRenaming: null,
    gRenameDraft: ''
  };

  const undo = () => {
    const h = histRef.current;
    if (!h.past.length) {
      setState({ status: 'nothing to undo' });
      return;
    }
    const target = h.past.pop();
    h.future.push({ nodes: state.nodes, edges: state.edges, groups: state.groups });
    h.tag = null;
    histSkipRef.current = true;
    setState({ ...cleanForHistory, nodes: target.nodes, edges: target.edges, groups: target.groups, status: 'undo' });
  };

  const redo = () => {
    const h = histRef.current;
    if (!h.future.length) {
      setState({ status: 'nothing to redo' });
      return;
    }
    const target = h.future.pop();
    h.past.push({ nodes: state.nodes, edges: state.edges, groups: state.groups });
    h.tag = null;
    histSkipRef.current = true;
    setState({ ...cleanForHistory, nodes: target.nodes, edges: target.edges, groups: target.groups, status: 'redo' });
  };

  // Any change to nodes/edges dirties the document. pristineRef makes an
  // exception for the initial load and for documents arriving already saved
  // from the server.
  const pristineRef = useRef(true);
  useEffect(() => {
    if (pristineRef.current) {
      pristineRef.current = false;
      return;
    }
    if (!state.dirty) setState({ dirty: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.nodes, state.edges, state.groups]);

  const failure = (err, prefixo) =>
    setState({
      saving: false,
      status: (prefixo ? prefixo + ': ' : '') + ((err && err.message) || 'unexpected failure')
    });

  function applyDocument(doc, flow, msg, extra) {
    pristineRef.current = true;
    // New document, new history: undoing back into the previous document
    // would make no sense at all.
    resetHistory();
    setState(
      {
        nodes: doc.nodes,
        edges: doc.edges,
        groups: doc.groups || [],
        flow,
        dirty: false,
        saving: false,
        viewing: null,
        sel: null,
        multi: [],
        palette: null,
        menu: null,
        saveOpen: false,
        actionsOpen: false,
        status: msg,
        ...(extra || {})
      },
      () => center()
    );
  }

  const askName = (padrao) => {
    const v = window.prompt('Flow name', padrao || '');
    return v === null ? null : v.trim();
  };

  async function loadLibrary() {
    lib({ carregando: true });
    try {
      const items = await api.listFlows(libRef.current.busca, libRef.current.lixeira);
      lib({ items, carregando: false });
    } catch (err) {
      lib({ carregando: false });
      failure(err, 'library');
    }
  }

  const openLibrary = (lixeira) => {
    setVersions({ open: false });
    lib({ open: true, lixeira: !!lixeira });
    setState({ menu: null, saveOpen: false });
    loadLibrary();
  };
  const closeLibrary = () => lib({ open: false });
  // Debounced search: without it every keystroke fires a GET at the API, which
  // runs under a 0.60 CPU ceiling.
  const searchTimerRef = useRef(null);
  const searchLibrary = (v) => {
    lib({ busca: v });
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(loadLibrary, 250);
  };
  const toggleTrash = () => {
    lib({ lixeira: !libRef.current.lixeira });
    loadLibrary();
  };

  const newFlow = () => {
    lib({ open: false });
    setVersions({ open: false });
    applyDocument({ nodes: [], edges: [], groups: [] }, null, 'new flow — save it to keep it', {
      permission: 'full',
      isOwner: true
    });
  };

  async function openFlow(id) {
    setState({ saving: true, status: 'opening…' });
    try {
      const f = await api.openFlow(id);
      const doc = flowFromPayload(f.graph) || { nodes: [], edges: [], groups: [] };
      lib({ open: false });
      setVersions({ open: false });
      applyDocument(
        doc,
        { id: f.id, slug: f.slug, name: f.name, version: f.current_version, hasDraft: f.has_draft },
        f.graph_source === 'draft'
          ? f.name + ' — unsaved draft (v' + f.current_version + ' is the latest version)'
          : f.name + ' — version ' + f.current_version,
        // The permission is the server's, not the client's: it arrives with the flow.
        { permission: f.permission || 'full', isOwner: !!f.is_owner }
      );
    } catch (err) {
      failure(err, 'open');
    }
  }

  async function saveVersion(note) {
    if (readOnly()) return;
    const { nodes, edges, groups, flow } = docRef.current;
    if (!flow) {
      saveAsNew();
      return;
    }
    setState({ saving: true, saveOpen: false, menu: null, status: 'saving version…' });
    try {
      const v = await api.saveVersion(flow.id, flowPayload(nodes, edges, groups), flow.version, note);
      setState({
        saving: false,
        dirty: false,
        viewing: null,
        flow: { ...flow, version: v.version, hasDraft: false },
        status: 'version ' + v.version + ' saved'
      });
      if (versionsRef.current.open) reloadVersions();
    } catch (err) {
      // 409: another tab saved first. We do not overwrite -- the user decides.
      if (err.status === 409) {
        setState({
          saving: false,
          status: err.message + ' — reopen the flow or use "Save as new"'
        });
        return;
      }
      failure(err, 'save');
    }
  }

  async function saveAsNew(requested) {
    const { nodes, edges, groups, flow } = docRef.current;
    const suggestion = requested || (flow ? flow.name + ' (copy)' : 'Untitled flow');
    const name = requested !== undefined ? requested : askName(suggestion);
    if (!name) return;
    setState({ saving: true, saveOpen: false, menu: null, status: 'creating on the server…' });
    try {
      const f = await api.createFlow(name, flowPayload(nodes, edges, groups), null, 'initial version');
      setState({
        saving: false,
        dirty: false,
        viewing: null,
        flow: { id: f.id, slug: f.slug, name: f.name, version: f.current_version, hasDraft: false },
        // Whoever creates it owns it: the blank document becomes their flow.
        permission: 'full',
        isOwner: true,
        status: '"' + f.name + '" created on the server'
      });
      if (libRef.current.open) loadLibrary();
      // The history dropdown may be open precisely because of the invitation
      // to save: there is a version 1 to list now.
      if (versionsRef.current.open) reloadVersions();
    } catch (err) {
      failure(err, 'create');
    }
  }

  async function renameFlow(id, nomeAtual) {
    const target = id || (docRef.current.flow && docRef.current.flow.id);
    if (!target) return;
    const name = askName(nomeAtual || (docRef.current.flow && docRef.current.flow.name));
    if (!name) return;
    try {
      const f = await api.renameFlow(target, { name: name });
      const aberto = docRef.current.flow;
      if (aberto && aberto.id === f.id) {
        setState({ flow: { ...aberto, name: f.name, slug: f.slug }, status: 'renamed' });
      } else {
        setState({ status: 'renamed' });
      }
      if (libRef.current.open) loadLibrary();
    } catch (err) {
      failure(err, 'rename');
    }
  }

  async function deleteFlow(id, purgar) {
    const question = purgar
      ? 'Permanently delete this flow, with every version and attachment?'
      : 'Move this flow to the trash?';
    if (!window.confirm(question)) return;
    try {
      await api.deleteFlow(id, purgar);
      const aberto = docRef.current.flow;
      if (aberto && aberto.id === id) {
        // The open flow no longer exists: the document stays on screen, but
        // detached from the server, so nothing is lost without warning.
        setState({ flow: null, dirty: true, status: 'flow deleted — the document stays open, unlinked' });
      } else {
        setState({ status: purgar ? 'flow permanently deleted' : 'flow moved to the trash' });
      }
      loadLibrary();
    } catch (err) {
      failure(err, 'delete');
    }
  }

  async function restoreFlow(id) {
    try {
      await api.restoreFlow(id);
      setState({ status: 'flow restored from the trash' });
      loadLibrary();
    } catch (err) {
      failure(err, 'restore');
    }
  }

  async function reloadVersions() {
    const flow = docRef.current.flow;
    if (!flow) return;
    setVersions({ carregando: true });
    try {
      const [items, arquivos] = await Promise.all([
        api.listVersions(flow.id),
        api.listFiles(flow.id)
      ]);
      setVersions({ items, arquivos, carregando: false });
    } catch (err) {
      setVersions({ carregando: false });
      failure(err, 'history');
    }
  }

  // The dropdown opens even with no stored flow: in that case it shows the
  // invitation to save, instead of refusing the click with a status message.
  const openVersionsPanel = () => {
    lib({ open: false });
    setState({ menu: null, saveOpen: false });
    if (docRef.current.flow) {
      setVersions({ open: true });
      reloadVersions();
    } else {
      setVersions({ open: true, items: [], arquivos: [], carregando: false });
    }
  };
  const closeVersionsPanel = () => setVersions({ open: false });
  // The single trigger on the document name in the header.
  const toggleHistory = () => {
    if (versionsRef.current.open) closeVersionsPanel();
    else openVersionsPanel();
  };

  async function viewVersion(number) {
    const flow = docRef.current.flow;
    if (!flow) return;
    try {
      const v = await api.openVersion(flow.id, number);
      const doc = flowFromPayload(v.graph);
      if (!doc) throw new Error('version in an unexpected format');
      applyDocument(doc, flow, 'viewing version ' + number + ' — save to promote it', {
        viewing: number
      });
    } catch (err) {
      failure(err, 'open version');
    }
  }

  async function restoreVersion(number) {
    const flow = docRef.current.flow;
    if (!flow) return;
    try {
      // The server creates a NEW version holding the old content: the history
      // stays immutable.
      const v = await api.restoreVersion(flow.id, number);
      const doc = flowFromPayload(v.graph);
      applyDocument(
        doc,
        { ...flow, version: v.version, hasDraft: false },
        'version ' + number + ' restored as version ' + v.version
      );
      reloadVersions();
    } catch (err) {
      failure(err, 'restore version');
    }
  }

  async function uploadPng() {
    const { nodes, edges, groups, flow } = docRef.current;
    if (!flow) {
      setState({ saveOpen: false, status: 'save the flow before uploading the PNG' });
      return;
    }
    if (!nodes.length && !groups.length) {
      setState({ saveOpen: false, status: 'nothing to export' });
      return;
    }
    setState({ saving: true, saveOpen: false, status: 'rendering the PNG…' });
    try {
      const blob = await flowPngBlob(nodes, edges, groups, heights, inkAccent, iconBySlug);
      if (!blob) throw new Error('could not render the PNG');
      const a = await api.uploadFile(
        flow.id,
        blob,
        flow.slug + '-v' + flow.version + '.png',
        'png'
      );
      setState({ saving: false, status: 'PNG uploaded (' + Math.round(a.size_bytes / 1024) + ' KB)' });
      if (versionsRef.current.open) reloadVersions();
    } catch (err) {
      failure(err, 'upload PNG');
    }
  }

  async function deleteFile(assetId) {
    try {
      await api.deleteFile(assetId);
      setState({ status: 'attachment removed' });
      reloadVersions();
    } catch (err) {
      failure(err, 'remove attachment');
    }
  }

  // Autosave: 3 s of inactivity write the draft (flows.draft_graph) without
  // creating a version. Only "Save version" enters the history -- without that
  // separation the autosave would produce hundreds of useless versions.
  useEffect(() => {
    if (!state.dirty || !state.flow || !canEdit) return;
    const t = setTimeout(() => {
      const { nodes, edges, groups, flow } = docRef.current;
      if (!flow) return;
      api
        .saveDraft(flow.id, flowPayload(nodes, edges, groups))
        .then(() => setState({ status: 'draft autosaved' }))
        // Silent on purpose: a network failure during autosave must not
        // interrupt the editing, and the content stays on screen.
        .catch(() => {});
    }, 3000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.dirty, state.flow, state.nodes, state.edges, state.groups]);

  // Warn on leaving only when there is nowhere to recover from: with a flow
  // open, the draft has been (or is about to be) autosaved.
  useEffect(() => {
    if (!state.dirty || state.flow) return;
    const notify = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', notify);
    return () => window.removeEventListener('beforeunload', notify);
  }, [state.dirty, state.flow]);


  // ── Sharing ───────────────────────────────────────────────────────
  // The menu's three paths (user, link, email) write the same two server
  // tables, always with an explicit permission level.

  const shareRef = useRef(initialState.share);
  shareRef.current = state.share;
  const setShare = (fields) => {
    shareRef.current = { ...shareRef.current, ...fields };
    setState({ share: shareRef.current });
  };

  // The link the other side opens. Built from this tab's URL rather than from
  // a constant, so it holds both in dev (localhost:5173) and published
  // (/flow-editor/).
  const shareUrl = (token) =>
    window.location.origin + window.location.pathname + '#/share/' + encodeURIComponent(token);

  async function loadShare() {
    const flow = docRef.current.flow;
    if (!flow) return;
    setShare({ loading: true, error: null });
    try {
      setShare({ state: await api.sharingState(flow.id), loading: false });
    } catch (err) {
      setShare({ loading: false, error: (err && err.message) || 'could not load the sharing state' });
    }
  }

  const toggleShare = () => {
    if (shareRef.current.open) {
      setShare({ open: false, notice: null, error: null });
      return;
    }
    // Sharing is reached from inside the Actions menu, and its panel hangs
    // from the same button: the menu steps aside for it.
    setState({ saveOpen: false, actionsOpen: false, menu: null });
    setShare({ open: true, notice: null, error: null });
    if (docRef.current.flow) loadShare();
  };

  // The Actions button: import and sharing, under one dropdown. Opening it
  // closes whatever else hangs from the header, the sharing panel included --
  // they share the same corner of the screen.
  const toggleActions = () => {
    const open = !state.actionsOpen;
    if (open && shareRef.current.open) setShare({ open: false, notice: null, error: null });
    setState({ actionsOpen: open, saveOpen: false, menu: null });
  };

  const copyToClipboard = (text, msg) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => setShare({ notice: msg }))
        .catch(() => setShare({ notice: 'copy this link: ' + text }));
    } else {
      setShare({ notice: 'copy this link: ' + text });
    }
  };

  async function shareWithUser(email, permission, pronto) {
    const flow = docRef.current.flow;
    if (!flow) return;
    setShare({ loading: true, error: null, notice: null });
    try {
      const s = await api.shareWithUser(flow.id, email, permission);
      if (pronto) pronto();
      setShare({ loading: false, notice: s.name + ' now has access (' + s.permission + ')' });
      loadShare();
    } catch (err) {
      setShare({ loading: false, error: (err && err.message) || 'could not share it' });
    }
  }

  async function changeSharePermission(shareId, permission) {
    const flow = docRef.current.flow;
    if (!flow) return;
    try {
      await api.changeSharePermission(flow.id, shareId, permission);
      setShare({ notice: 'permission updated', error: null });
      loadShare();
    } catch (err) {
      setShare({ error: (err && err.message) || 'could not change the permission' });
    }
  }

  async function revokeShare(shareId) {
    const flow = docRef.current.flow;
    if (!flow) return;
    try {
      await api.revokeShare(flow.id, shareId);
      setShare({ notice: 'access removed', error: null });
      loadShare();
    } catch (err) {
      setShare({ error: (err && err.message) || 'could not remove the access' });
    }
  }

  async function createShareLink(permission) {
    const flow = docRef.current.flow;
    if (!flow) return;
    setShare({ loading: true, error: null, notice: null });
    try {
      // The token comes back only once (the server keeps the hash), which is
      // why it goes straight to the clipboard.
      const link = await api.createShareLink(flow.id, permission);
      setShare({ loading: false });
      copyToClipboard(shareUrl(link.token), 'link copied — it grants "' + permission + '"');
      loadShare();
    } catch (err) {
      setShare({ loading: false, error: (err && err.message) || 'could not create the link' });
    }
  }

  async function revokeShareLink(linkId) {
    const flow = docRef.current.flow;
    if (!flow) return;
    try {
      await api.revokeShareLink(flow.id, linkId);
      setShare({ notice: 'link revoked', error: null });
      loadShare();
    } catch (err) {
      setShare({ error: (err && err.message) || 'could not revoke the link' });
    }
  }

  async function sendShareEmail(to, permission, message) {
    const flow = docRef.current.flow;
    if (!flow) return;
    setShare({ loading: true, error: null, notice: null });
    try {
      const base = window.location.origin + window.location.pathname;
      const r = await api.shareByEmail(flow.id, to, permission, message, base);
      setShare({ loading: false });
      if (r.sent) {
        setShare({ notice: 'email sent to ' + r.to });
      } else {
        // A server without SMTP: the link exists, and the sender is the
        // user's own mail client.
        window.location.href = r.mailto;
        setShare({ notice: 'opening your mail client — the link is in the message' });
      }
      loadShare();
    } catch (err) {
      setShare({ loading: false, error: (err && err.message) || 'could not send the email' });
    }
  }


  // ── Groups ────────────────────────────────────────────────────────
  // A group is a rectangle drawn behind the nodes. It keeps no list of what it
  // holds: a node belongs to the box whose rectangle contains its centre, and
  // that answer is recomputed on every move (settle()). Dragging a node out of
  // the box is therefore all it takes to leave the group, and dragging one in
  // is all it takes to join.

  const patchGroup = (id, fields, tag) => {
    if (readOnly()) return;
    if (tag) tagHistory(tag);
    setState((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, ...fields } : g)) }));
  };

  // Ctrl+click (or Shift) piles nodes into `multi`; a plain click reduces the
  // selection to the node under the cursor.
  const toggleMulti = (id) => {
    const base = state.multi.length
      ? state.multi
      : state.sel && state.sel.type === 'node'
        ? [state.sel.id]
        : [];
    const multi = base.indexOf(id) >= 0 ? base.filter((x) => x !== id) : base.concat([id]);
    setState({
      multi,
      sel: multi.length ? { type: 'node', id } : null,
      menu: null,
      saveOpen: false,
      palette: null,
      status: multi.length
        ? multi.length + (multi.length === 1 ? ' node' : ' nodes') + ' selected — right click to group them (Ctrl+G)'
        : 'selection cleared'
    });
  };

  // The nodes a group action applies to: the Ctrl+click pile, or the single
  // selected node when there is no pile.
  const selectedNodeIds = () => {
    if (state.multi.length) return state.multi;
    return state.sel && state.sel.type === 'node' ? [state.sel.id] : [];
  };

  const newGroup = (box, name) => ({
    id: nextId(state.groups),
    name: name || 'Group ' + (state.groups.length + 1),
    ...box,
    // Each new box takes the next colour of the palette, so two boxes side by
    // side never come out identical.
    col: GROUP_COLORS[state.groups.length % GROUP_COLORS.length] || GROUP_COLOR
  });

  // "Create group" over a selection: the box is drawn around the nodes, with a
  // margin and room for the title bar.
  const groupSelection = () => {
    if (readOnly()) return;
    const ids = selectedNodeIds();
    const list = state.nodes.filter((n) => ids.indexOf(n.id) >= 0);
    if (!list.length) {
      setState({ menu: null, status: 'select nodes with Ctrl+click, then group them' });
      return;
    }
    const g = newGroup(boundsForGroup(list, heights));
    setState((s) => {
      const groups = s.groups.concat([g]);
      return {
        groups,
        nodes: settle(s.nodes, groups),
        // The pile ends here: inside the box each node is dragged on its own
        // again, which is the whole point of a group being just a box.
        multi: [],
        sel: { type: 'group', id: g.id },
        menu: null,
        status: 'group with ' + list.length + ' nodes — drag the box to move them together'
      };
    });
  };

  // An empty box, from the plane's context menu. It is the same object: it
  // just starts with nothing inside.
  const addGroup = (at) => {
    if (readOnly()) return;
    const p = at || { x: 0, y: 0 };
    const g = newGroup({
      x: snap(p.x - GROUP_NEW_WIDTH / 2),
      y: snap(p.y - GROUP_HEAD),
      w: GROUP_NEW_WIDTH,
      h: GROUP_NEW_HEIGHT
    });
    setState((s) => {
      const groups = s.groups.concat([g]);
      return {
        groups,
        // A box dropped over existing nodes takes them in.
        nodes: settle(s.nodes, groups),
        sel: { type: 'group', id: g.id },
        multi: [],
        menu: null,
        status: 'empty group — drop nodes inside it, or drag it by its bar'
      };
    });
  };

  // Removing the box only removes the box: the nodes stay where they are and
  // simply stop belonging to anything.
  const removeGroup = (id) => {
    if (readOnly()) return;
    setState((s) => {
      const groups = s.groups.filter((g) => g.id !== id);
      return {
        groups,
        nodes: settle(s.nodes, groups),
        sel: null,
        menu: null,
        palette: null,
        gRenaming: s.gRenaming === id ? null : s.gRenaming,
        status: 'group removed — the nodes stay on the plane'
      };
    });
  };

  const removeGroupWithNodes = (id) => {
    if (readOnly()) return;
    const doomed = new Set(state.nodes.filter((n) => n.g === id).map((n) => n.id));
    if (doomed.size && !window.confirm('Delete this group and the ' + doomed.size + ' nodes inside it?')) return;
    setState((s) => {
      const groups = s.groups.filter((g) => g.id !== id);
      return {
        groups,
        nodes: settle(s.nodes.filter((n) => !doomed.has(n.id)), groups),
        edges: s.edges.filter((e) => !doomed.has(e.from) && !doomed.has(e.to)),
        sel: null,
        multi: [],
        menu: null,
        palette: null,
        status: 'group and ' + doomed.size + ' nodes removed'
      };
    });
  };

  // Shrinks (or grows) the box back onto what it holds. An empty box has
  // nothing to fit itself to, so it is left alone.
  const fitGroup = (id) => {
    if (readOnly()) return;
    const inside = state.nodes.filter((n) => n.g === id);
    if (!inside.length) {
      setState({ menu: null, status: 'the group is empty — nothing to fit it to' });
      return;
    }
    const box = boundsForGroup(inside, heights);
    setState((s) => ({
      groups: s.groups.map((g) => (g.id === id ? { ...g, ...box } : g)),
      menu: null,
      status: 'group fitted to its ' + inside.length + ' nodes'
    }));
  };

  const setGroupColor = (id, col) => {
    patchGroup(id, { col });
    setState({ palette: null, status: 'group colour changed' });
  };
  const togglePalette = (id) => setState((s) => ({ palette: s.palette === id ? null : id, menu: null }));

  // Renaming: the same shape as a node's, with the draft in a ref so that
  // Enter and blur cannot commit twice.
  const gRenameRef = useRef(null);

  const startGroupRename = (id) => {
    if (readOnly()) return;
    const g = state.groups.find((x) => x.id === id);
    if (!g) return;
    gRenameRef.current = { id, draft: g.name };
    setState(
      { gRenaming: id, gRenameDraft: g.name, sel: { type: 'group', id }, menu: null, palette: null, status: 'renaming the group — Enter confirms, Esc cancels' },
      () =>
        setTimeout(() => {
          const el = document.querySelector('[data-grename="' + id + '"]');
          if (el) {
            el.focus();
            el.select();
          }
        }, 30)
    );
  };
  const changeGroupRename = (v) => {
    if (gRenameRef.current) gRenameRef.current = { ...gRenameRef.current, draft: v };
    setState({ gRenameDraft: v });
  };
  const cancelGroupRename = () => {
    gRenameRef.current = null;
    setState({ gRenaming: null, gRenameDraft: '', status: 'rename cancelled' });
  };
  const commitGroupRename = (id) => {
    const r = gRenameRef.current;
    if (!r || r.id !== id) return;
    gRenameRef.current = null;
    const name = (r.draft || '').trim().slice(0, 160) || 'Group';
    setState((s) => ({
      groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)),
      gRenaming: null,
      gRenameDraft: '',
      status: 'group renamed to "' + name + '"'
    }));
  };

  // Dragging the box. The nodes inside are captured here, with their offset
  // from the corner: from then on the drag is a rigid translation, so the
  // content keeps its arrangement instead of being re-laid out.
  const startGroupDrag = (e, g) => {
    if (e.button !== 0) {
      setState({ sel: { type: 'group', id: g.id }, menu: null });
      return;
    }
    e.stopPropagation();
    const w = toWorld(e);
    const mates = canEdit
      ? state.nodes.filter((n) => n.g === g.id).map((n) => ({ id: n.id, ox: n.x - g.x, oy: n.y - g.y }))
      : [];
    setState({
      gdrag: canEdit ? { id: g.id, dx: w.x - g.x, dy: w.y - g.y, mates } : null,
      sel: { type: 'group', id: g.id },
      multi: [],
      menu: null,
      saveOpen: false,
      palette: null,
      status: g.name + ' — ' + mates.length + ' nodes move with the box'
    });
  };

  const startGroupResize = (e, g) => {
    e.stopPropagation();
    e.preventDefault();
    if (readOnly()) return;
    const w = toWorld(e);
    setState({
      gresize: { id: g.id, sx: w.x, sy: w.y, w0: g.w, h0: g.h },
      sel: { type: 'group', id: g.id },
      menu: null,
      saveOpen: false,
      status: 'resizing ' + g.name + ' — nodes join or leave as the edge passes them'
    });
  };

  // Mouse down on a node: selection, and the drag of everything selected.
  const startNodeDrag = (e, n) => {
    e.stopPropagation();
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const piled = state.multi.indexOf(n.id) >= 0;
    if (e.button !== 0) {
      // The right button only opens the menu. A node already in the pile keeps
      // it -- that is how the menu comes to offer "Create group".
      if (!piled) setState({ multi: [], sel: { type: 'node', id: n.id } });
      return;
    }
    if (additive) {
      toggleMulti(n.id);
      return;
    }
    const w = toWorld(e);
    // Dragging one of several selected nodes moves the whole pile; every other
    // click reduces the selection to this node, and inside a group that is
    // what lets a single node be moved without disturbing the others.
    const together = piled && state.multi.length > 1;
    const mates = together
      ? state.nodes.filter((m) => m.id !== n.id && state.multi.indexOf(m.id) >= 0).map((m) => ({ id: m.id, ox: m.x - n.x, oy: m.y - n.y }))
      : [];
    setState({
      // Without edit permission a node is selectable but not draggable: moving
      // it only for the server to refuse the save would be worse.
      drag: canEdit ? { id: n.id, dx: w.x - n.x, dy: w.y - n.y, mates } : null,
      sel: { type: 'node', id: n.id },
      multi: together ? state.multi : [],
      menu: null,
      saveOpen: false,
      palette: null,
      status: together ? state.multi.length + ' nodes moving together' : title(n)
    });
  };

  // ── Resizing and renaming a node ──────────────────────────────────

  const clampWidth = (v) => Math.round(Math.max(NODE_MIN_WIDTH, Math.min(NODE_MAX_WIDTH, v)));
  const clampHeight = (v) => Math.round(Math.max(NODE_MIN_HEIGHT, Math.min(NODE_MAX_HEIGHT, v)));

  // Dragging the handle (bottom-right corner). A double click returns the node
  // to its natural size -- default width, height dictated by the content.
  const startResize = (e, n, reset) => {
    e.stopPropagation();
    e.preventDefault();
    if (readOnly()) return;
    if (reset) {
      resetNodeSize(n.id);
      return;
    }
    const w = toWorld(e);
    setState({
      resize: { id: n.id, sx: w.x, sy: w.y, w0: nw(n), h0: nh(n) },
      sel: { type: 'node', id: n.id },
      menu: null,
      saveOpen: false,
      status: 'resizing ' + title(n) + ' — double click the handle to reset'
    });
  };

  const resetNodeSize = (id) =>
    setState((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, w: null, h: null } : n)),
      resize: null,
      menu: null,
      status: 'size reset'
    }));

  // The name draft lives in a ref, not only in state: the commit arrives both
  // through Enter and through blur, and the ref is what keeps the second from
  // rewriting what the first already saved.
  const renameRef = useRef(null);

  const startRename = (id) => {
    if (readOnly()) return;
    const n = state.nodes.find((x) => x.id === id);
    if (!n) return;
    const draft = n.label || n.n;
    renameRef.current = { id, draft };
    setState(
      { renaming: id, renameDraft: draft, sel: { type: 'node', id }, menu: null, saveOpen: false, status: 'renaming — Enter confirms, Esc cancels' },
      () =>
        setTimeout(() => {
          const el = document.querySelector('[data-rename="' + id + '"]');
          if (el) {
            el.focus();
            el.select();
          }
        }, 30)
    );
  };

  const changeRename = (v) => {
    if (renameRef.current) renameRef.current = { ...renameRef.current, draft: v };
    setState({ renameDraft: v });
  };

  const cancelRename = () => {
    renameRef.current = null;
    setState({ renaming: null, renameDraft: '', status: 'rename cancelled' });
  };

  // `label` is the nickname; `n` (the technical stack name) never changes and
  // stays printed below it. Clearing the field -- or typing the stack name
  // itself -- undoes the nickname.
  const commitRename = (id) => {
    const r = renameRef.current;
    if (!r || r.id !== id) return;
    renameRef.current = null;
    const node = state.nodes.find((x) => x.id === id);
    if (!node) {
      setState({ renaming: null, renameDraft: '' });
      return;
    }
    const v = (r.draft || '').trim().slice(0, 160);
    const label = !v || v === node.n ? null : v;
    if (label === (node.label || null)) {
      setState({ renaming: null, renameDraft: '', status: title(node) });
      return;
    }
    setState((s) => ({
      nodes: s.nodes.map((x) => (x.id === id ? { ...x, label } : x)),
      renaming: null,
      renameDraft: '',
      status: label ? 'renamed to "' + label + '" (' + node.n + ')' : 'custom name removed — back to ' + node.n
    }));
  };

  const onDown = (e) => {
    if (e.button !== 0) {
      setState({ menu: null });
      return;
    }
    setState({ panning: { sx: e.clientX, sy: e.clientY, px: state.pan.x, py: state.pan.y }, sel: null, multi: [], palette: null, menu: null, saveOpen: false, actionsOpen: false });
  };
  const onCanvasMenu = (e) => {
    e.preventDefault();
    const w = toWorld(e);
    setState({ menu: { x: e.clientX, y: e.clientY, type: 'canvas', at: { x: w.x, y: w.y } } });
  };
  const onMove = (e) => {
    const w = toWorld(e);
    const st = { cursor: { x: Math.round(w.x), y: Math.round(-w.y) } };
    const { drag, resize, panning, link, gdrag, gresize } = state;
    if (resize) {
      const lw = clampWidth(resize.w0 + (w.x - resize.sx));
      const lh = clampHeight(resize.h0 + (w.y - resize.sy));
      // A whole drag is a single history step.
      tagHistory('live:resize:' + resize.id);
      st.nodes = state.nodes.map((n) => (n.id === resize.id ? { ...n, w: lw, h: lh } : n));
    } else if (drag) {
      tagHistory('live:drag:' + drag.id);
      const x = snap(w.x - drag.dx), y = snap(w.y - drag.dy);
      // The nodes dragged along keep the offset measured when the drag began.
      const mates = {};
      drag.mates.forEach((m) => (mates[m.id] = m));
      st.nodes = state.nodes.map((n) => {
        if (n.id === drag.id) return { ...n, x, y };
        const m = mates[n.id];
        return m ? { ...n, x: x + m.ox, y: y + m.oy } : n;
      });
    } else if (gdrag) {
      tagHistory('live:gdrag:' + gdrag.id);
      const x = snap(w.x - gdrag.dx), y = snap(w.y - gdrag.dy);
      st.groups = state.groups.map((g) => (g.id === gdrag.id ? { ...g, x, y } : g));
      // The box carries its content: a rigid translation, so nothing inside
      // shifts relative to anything else.
      const mates = {};
      gdrag.mates.forEach((m) => (mates[m.id] = m));
      st.nodes = state.nodes.map((n) => {
        const m = mates[n.id];
        return m ? { ...n, x: x + m.ox, y: y + m.oy } : n;
      });
    } else if (gresize) {
      tagHistory('live:gresize:' + gresize.id);
      const gw = clampGroupWidth(gresize.w0 + (w.x - gresize.sx));
      const gh = clampGroupHeight(gresize.h0 + (w.y - gresize.sy));
      st.groups = state.groups.map((g) => (g.id === gresize.id ? { ...g, w: gw, h: gh } : g));
      st.nodes = state.nodes;
    } else if (panning) st.pan = { x: panning.px + (e.clientX - panning.sx), y: panning.py + (e.clientY - panning.sy) };
    else if (link) st.link = { ...link, x: w.x, y: w.y };
    // Membership is settled live, not on drop: the box lights up the moment a
    // node's centre crosses its edge, and the whole gesture stays one history
    // step (the same `live:` tag) instead of gaining one at mouse-up.
    if (st.nodes) st.nodes = settle(st.nodes, st.groups || state.groups);
    setState(st);
  };
  const onUp = () => {
    const { link, hover } = state;
    if (link && hover && hover !== link.from && canEdit) {
      const from = link.from;
      const to = hover;
      const exists = state.edges.some((x) => x.from === from && x.to === to);
      if (!exists) setState((s) => ({ edges: s.edges.concat([{ id: nextId(s.edges), from, to, label: null }]), status: 'edge created' }));
    } else if (link) setState({ status: 'drop the edge on another node' });
    // End of the stroke: the next drag starts a new history step.
    endHistoryStroke();
    setState({ drag: null, resize: null, gdrag: null, gresize: null, panning: null, link: null });
  };
  const onWheel = (e) => {
    const el = viewportRef.current;
    if (!el) return;
    const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const ns = Math.min(2.2, Math.max(0.35, state.scale * f));
    const r = el.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const { pan, scale } = state;
    setState({ scale: ns, pan: { x: mx - (mx - pan.x) * (ns / scale), y: my - (my - pan.y) * (ns / scale) } });
  };
  const zoomTo = (ns) => {
    const el = viewportRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mx = r.width / 2, my = r.height / 2;
    const { pan, scale } = state;
    const s2 = Math.min(2.2, Math.max(0.35, ns));
    setState({ scale: s2, pan: { x: mx - (mx - pan.x) * (s2 / scale), y: my - (my - pan.y) * (s2 / scale) } });
  };

  const toggleTheme = () => {
    const t = light ? 'dark' : 'light';
    try {
      localStorage.setItem('flow-theme', t);
    } catch (err) {
      /* ignore */
    }
    setState({ theme: t, menu: null, saveOpen: false, status: t === 'light' ? 'light theme' : 'dark theme' });
  };

  // ── Sidebar ───────────────────────────────────────────────────────

  const storePref = (chave, valor) => {
    try {
      localStorage.setItem(chave, valor);
    } catch (err) {
      /* ignore */
    }
  };

  const toggleSidebar = () => {
    const open = !state.boxOpen;
    storePref('flow-sidebar-open', open ? '1' : '0');
    setState({ boxOpen: open, menu: null });
  };

  // The drag fires on every mousemove: the ref avoids a re-render when the
  // clamped width has not changed (at the end of the range), and the write is
  // deferred so localStorage is not hit hundreds of times during one drag.
  const widthRef = useRef(initialState.sidebarWidth);
  widthRef.current = state.sidebarWidth;
  const prefTimerRef = useRef(null);
  const resizeSidebar = (largura) => {
    const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(largura)));
    if (w === widthRef.current) return;
    widthRef.current = w;
    clearTimeout(prefTimerRef.current);
    prefTimerRef.current = setTimeout(() => storePref('flow-sidebar-width', String(w)), 300);
    setState({ sidebarWidth: w });
  };

  // ── Custom tools ──────────────────────────────────────────────────

  async function loadCustomTools() {
    setTools({ loading: true });
    try {
      setTools({ custom: await api.listTools(), loading: false });
    } catch (err) {
      // Silent on purpose: without the server the built-in catalog still
      // works, and the error would show before the user asked for anything.
      setTools({ loading: false });
    }
  }

  const openToolModal = () =>
    setState({ toolModal: { open: true, saving: false, error: null, mode: 'create' }, menu: null, saveOpen: false });
  const openEditToolModal = () =>
    setState({
      toolModal: { open: true, saving: false, error: null, mode: 'edit' },
      toolUsage: { key: null, loading: false, count: 0, flows: [], error: false },
      menu: null,
      saveOpen: false
    });
  const closeToolModal = () =>
    setState({
      toolModal: { open: false, saving: false, error: null, mode: 'create' },
      toolUsage: { key: null, loading: false, count: 0, flows: [], error: false }
    });

  // The key a usage answer is filed under. A built-in has no id, so it answers
  // to its name.
  const toolKey = (t) => (t && t.custom ? 'c' + t.id : t ? 'b' + t.n : null);

  async function checkToolUsage(tool) {
    if (!tool) return;
    const key = toolKey(tool);
    setState({ toolUsage: { key, loading: true, count: 0, flows: [], error: false } });
    try {
      // Both references at once: the slug a registered tool leaves in the
      // node, and the name a node made from a built-in carries instead.
      const names = [tool.n];
      if (tool.builtin && tool.builtin !== tool.n) names.push(tool.builtin);
      const usage = await api.toolUsage(tool.slug, names);
      setState({
        toolUsage: { key, loading: false, count: usage.count, flows: usage.flows, error: false }
      });
    } catch (err) {
      // Without an answer the delete button stays locked: refusing to delete
      // is the safe side of not knowing.
      setState({ toolUsage: { key, loading: false, count: 0, flows: [], error: true } });
    }
  }

  async function createCustomTool(draft) {
    setState({ toolModal: { open: true, saving: true, error: null, mode: 'create' } });
    try {
      const tool = await api.createTool(draft);
      setTools({ custom: [tool].concat(toolsRef.current.custom) });
      setState({
        toolModal: { open: false, saving: false, error: null, mode: 'create' },
        // The search is cleared so the tool just created is visible in the
        // list. Nothing about the OPEN FLOW is touched here: the catalog is
        // the user's, not the document's.
        q: '',
        status: '"' + tool.name + '" added to the tool catalog'
      });
    } catch (err) {
      const msg =
        err && err.status === 422
          ? 'the server rejected the tool (check name, color and image)'
          : (err && err.message) || 'could not save the tool';
      setState({ toolModal: { open: true, saving: false, error: msg, mode: 'create' } });
    }
  }

  // Editing writes to the CATALOG, never to a graph: a node copied its look
  // when it was added, so the plane stays as it is and only the icon, resolved
  // live by slug, follows the tool.
  async function updateCustomTool(target, draft) {
    setState({ toolModal: { open: true, saving: true, error: null, mode: 'edit' } });
    try {
      // A built-in has no row yet: editing one materialises it, tagged with
      // the built-in it stands for so the sidebar serves the row instead.
      const tool = target.id
        ? await api.updateTool(target.id, draft)
        : await api.createTool({ ...draft, builtin: target.n });
      setTools({
        custom: target.id
          ? toolsRef.current.custom.map((t) => (t.id === tool.id ? tool : t))
          : [tool].concat(toolsRef.current.custom)
      });
      setState({
        toolModal: { open: false, saving: false, error: null, mode: 'create' },
        q: '',
        status: '"' + tool.name + '" updated in the tool catalog'
      });
    } catch (err) {
      const msg =
        err && err.status === 422
          ? 'the server rejected the change (check name, color and image)'
          : (err && err.message) || 'could not save the tool';
      setState({ toolModal: { open: true, saving: false, error: msg, mode: 'edit' } });
    }
  }

  // Removing a tool from the catalog. The server is the guard: it refuses
  // (409) while any diagram still holds a node made from this tool, and the
  // message it sends back names them.
  async function deleteCustomTool(tool) {
    const inModal = state.toolModal.open;
    const ok = window.confirm(
      'Remove "' + tool.n + '" from the tool catalog?\n' +
        (tool.custom
          ? 'Nodes already on the plane are kept — they fall back to their initials.'
          : 'It is a built-in tool: it leaves the sidebar for everyone on this server.')
    );
    if (!ok) return;
    try {
      if (tool.id) {
        await api.deleteTool(tool.id);
      } else {
        // A built-in with no row: the row IS how it leaves the catalog, since
        // the built-in list itself lives in the source.
        await api.createTool({
          name: tool.n,
          category: tool.c,
          initials: tool.k,
          color: tool.col,
          tags: tool.tags || '',
          icon: null,
          builtin: tool.n,
          hidden: true
        });
      }
      await loadCustomTools();
      setState({
        toolModal: { open: false, saving: false, error: null, mode: 'create' },
        toolUsage: { key: null, loading: false, count: 0, flows: [], error: false },
        q: '',
        status: '"' + tool.n + '" removed from the catalog'
      });
    } catch (err) {
      const msg = (err && err.message) || 'could not remove the tool';
      if (inModal) setState({ toolModal: { open: true, saving: false, error: msg, mode: 'edit' } });
      else setState({ status: msg });
    }
  }

  // The catalog as displayed: the registered tools first (they are the user's
  // own), then the built-in ones. `slug` exists only on registered tools, and
  // it is what travels into the node.
  //
  // A row carrying `builtin` STANDS FOR one of the built-in entries -- it is
  // what editing a built-in produces -- so that entry drops out of the list
  // and the row takes its place. A hidden row takes its place with nothing:
  // that is a built-in deleted from the catalog.
  const rows = state.tools.custom || [];
  const replaced = {};
  rows.forEach((t) => {
    if (t.builtin) replaced[t.builtin] = true;
  });
  const customTools = rows
    .filter((t) => !t.hidden)
    .map((t) => ({
      id: t.id,
      slug: t.slug,
      n: t.name,
      c: t.category,
      k: t.initials,
      col: t.color,
      tags: t.tags || '',
      icon: t.icon || null,
      builtin: t.builtin || null,
      custom: true
    }));
  const catalog = customTools.concat(
    TOOLS.filter((t) => !replaced[t.n]).map((t) => ({
      ...t,
      id: null,
      slug: null,
      icon: null,
      builtin: null,
      custom: false
    }))
  );

  // Icons by slug: the node keeps only the reference, the image is resolved
  // here at draw time (canvas and PNG).
  const iconBySlug = {};
  customTools.forEach((t) => {
    if (t.icon) iconBySlug[t.slug] = t.icon;
  });

  const needle = state.q.trim().toLowerCase();
  const results = catalog
    .filter((t) => !needle || (t.n + ' ' + t.c + ' ' + t.tags).toLowerCase().includes(needle))
    .map((t) => ({
      ...t,
      dim: t.col + '1f',
      add: () => addTool(t)
    }));

  return {
    state,
    setState,
    viewportRef,
    registerNodeRef,
    nh,
    accent: inkAccent,
    light,
    toWorld,
    snap,
    center,
    organize,
    addTool,
    patch,
    removeNode,
    editEdge,
    removeEdge,
    duplicate,
    copyMeta,
    copySelected,
    pasteNode,
    addFromPayload,
    saveJson,
    copyJson,
    importJson,
    savePng,
    onDown,
    onMove,
    onUp,
    // Groups
    groupSelection,
    addGroup,
    removeGroup,
    removeGroupWithNodes,
    fitGroup,
    setGroupColor,
    togglePalette,
    startGroupDrag,
    startGroupResize,
    startGroupRename,
    changeGroupRename,
    commitGroupRename,
    cancelGroupRename,
    startNodeDrag,
    toggleMulti,
    removeNodes,
    selectedNodeIds,
    startResize,
    resetNodeSize,
    startRename,
    changeRename,
    commitRename,
    cancelRename,
    nodeTitle: title,
    nw,
    onWheel,
    onCanvasMenu,
    zoomTo,
    toggleTheme,
    undo,
    redo,
    tagHistory,
    // Permission
    canEdit,
    canManage,
    // Sharing
    toggleShare,
    toggleActions,
    shareWithUser,
    changeSharePermission,
    revokeShare,
    createShareLink,
    revokeShareLink,
    copyShareLink: (token) => copyToClipboard(shareUrl(token), 'link copied'),
    sendShareEmail,
    results,
    toolCount: catalog.length,
    iconBySlug,
    clipStop: (e) => e.stopPropagation(),
    // Sidebar
    toggleSidebar,
    resizeSidebar,
    // Custom tools
    // The whole catalog, unfiltered: the tool modal offers every registered
    // tool and every category, whatever the sidebar search happens to show.
    catalog,
    openEditToolModal,
    checkToolUsage,
    updateCustomTool,
    openToolModal,
    closeToolModal,
    createCustomTool,
    deleteCustomTool,
    // Persistence
    newFlow,
    openFlow,
    saveVersion,
    saveAsNew,
    renameFlow,
    deleteFlow,
    restoreFlow,
    openLibrary,
    closeLibrary,
    searchLibrary,
    toggleTrash,
    openVersionsPanel,
    closeVersionsPanel,
    toggleHistory,
    viewVersion,
    restoreVersion,
    uploadPng,
    deleteFile,
    fileUrl: api.fileUrl
  };
}
