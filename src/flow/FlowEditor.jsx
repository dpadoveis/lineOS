import { clipToBorder, midPoint, pathFor, shade, straightPath } from './geometry.js';
import { useFlowEditor } from './useFlowEditor.js';
import Header from './Header.jsx';
import Sidebar from './Sidebar.jsx';
import Node from './Node.jsx';
import Group from './Group.jsx';
import EdgeSvg from './EdgeSvg.jsx';
import ContextMenu from './ContextMenu.jsx';
import FlowLibrary from './FlowLibrary.jsx';
import ToolModal from './ToolModal.jsx';
import './FlowEditor.css';

export default function FlowEditor({ flowRef, session, smtpReady, onHome }) {
  const fe = useFlowEditor({ flowRef });
  const { state, setState, nh, accent, light, viewportRef, registerNodeRef } = fe;
  const { nodes, edges, groups, multi, q, link, hover, sel, menu, boxOpen, saveOpen, actionsOpen, pan, scale, cursor, status } = state;
  const { flow, dirty, saving, viewing, library, versions, sidebarWidth, toolModal } = state;
  const { renaming, renameDraft, share } = state;
  const { gRenaming, gRenameDraft, palette } = state;
  const nw = fe.nw;

  const ctr = (n) => ({ x: n.x + nw(n) / 2, y: n.y + nh(n) / 2 });
  const byId = {};
  nodes.forEach((n) => (byId[n.id] = n));
  const deg = {};
  edges.forEach((e) => {
    deg[e.from] = (deg[e.from] || 0) + 1;
    deg[e.to] = (deg[e.to] || 0) + 1;
  });

  const paths = [];
  const labels = [];
  edges.forEach((e) => {
    const a = byId[e.from], b = byId[e.to];
    if (!a || !b) return;
    const ca = ctr(a), cb = ctr(b);
    const s = clipToBorder(ca, cb, nh(a), nw(a)), t = clipToBorder(cb, ca, nh(b), nw(b));
    const on = sel && sel.type === 'edge' && sel.id === e.id;
    const d = pathFor(s, t);
    paths.push({
      id: 'e' + e.id,
      d,
      selected: on,
      onMouseDown: (ev) => {
        ev.stopPropagation();
        setState({ sel: { type: 'edge', id: e.id }, status: 'edge selected · Delete removes · double click labels' });
      },
      onDoubleClick: (ev) => {
        ev.stopPropagation();
        fe.editEdge(e.id);
      },
      onContextMenu: (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        setState({ menu: { x: ev.clientX, y: ev.clientY, type: 'edge', id: e.id }, sel: { type: 'edge', id: e.id } });
      }
    });
    if (e.label !== null && e.label !== undefined) {
      const m = midPoint(s, t);
      labels.push({
        id: e.id,
        x: Math.round(m.x),
        y: Math.round(m.y),
        value: e.label,
        stroke: on ? accent : 'var(--edge1)',
        onChange: (ev) => {
          const v = ev.target.value;
          fe.tagHistory('text:edge:' + e.id);
          setState((st) => ({ edges: st.edges.map((x) => (x.id === e.id ? { ...x, label: v } : x)) }));
        },
        onBlur: (ev) => {
          if (!ev.target.value.trim()) setState((st) => ({ edges: st.edges.map((x) => (x.id === e.id ? { ...x, label: null } : x)) }));
        }
      });
    }
  });

  let pendingPath = null;
  if (link) {
    const a = byId[link.from];
    if (a) {
      const ca = ctr(a);
      const onNode = hover && byId[hover];
      const tgt = onNode ? clipToBorder(ctr(byId[hover]), ca, nh(byId[hover]), nw(byId[hover])) : { x: link.x, y: link.y };
      const s = clipToBorder(ca, tgt, nh(a), nw(a));
      // Over open plane the rubber band is a straight line, so its head
      // points at the cursor; once it lands on a node it takes the curve of
      // the edge it is about to become.
      pendingPath = { d: onNode ? pathFor(s, tgt) : straightPath(s, tgt) };
    }
  }

  // How many nodes a group action would take in: the Ctrl+click pile, or the
  // single selected node.
  const picked = fe.selectedNodeIds();

  let menuItems = [];
  if (menu && menu.type === 'node') {
    const id = menu.id;
    const target = byId[id];
    menuItems = [
      // Grouping heads the list when several nodes are selected: that is the
      // gesture the menu was opened for.
      picked.length > 1
        ? { label: 'Create group', hint: picked.length + ' nodes', col: 'var(--txt)', act: () => fe.groupSelection() }
        : { label: 'Create group', hint: 'Ctrl+G', col: 'var(--txt)', act: () => fe.groupSelection() },
      { label: 'Rename node', hint: 'F2', col: 'var(--txt)', act: () => fe.startRename(id) },
      { label: 'Reset size', hint: target && (target.w || target.h) ? 'resized' : 'default', col: 'var(--txt)', act: () => fe.resetNodeSize(id) },
      { label: 'Duplicate node', hint: 'Ctrl+D', col: 'var(--txt)', act: () => fe.duplicate(id) },
      { label: 'Copy metadata', hint: 'JSON', col: 'var(--txt)', act: () => fe.copyMeta(id) },
      { label: 'Paste node', hint: 'Ctrl+V', col: 'var(--txt)', act: () => fe.pasteNode() },
      picked.length > 1
        ? { label: 'Delete nodes', hint: picked.length + ' selected', col: '#e07a6a', act: () => fe.removeNodes(picked) }
        : { label: 'Delete node', hint: 'Del', col: '#e07a6a', act: () => fe.removeNode(id) }
    ];
  } else if (menu && menu.type === 'group') {
    const id = menu.id;
    menuItems = [
      { label: 'Rename group', hint: 'F2', col: 'var(--txt)', act: () => fe.startGroupRename(id) },
      { label: 'Group colour', hint: 'palette', col: 'var(--txt)', act: () => fe.togglePalette(id) },
      { label: 'Fit to nodes', hint: 'shrink', col: 'var(--txt)', act: () => fe.fitGroup(id) },
      { label: 'Delete group', hint: 'keeps nodes', col: 'var(--txt)', act: () => fe.removeGroup(id) },
      { label: 'Delete group and nodes', hint: 'Del', col: '#e07a6a', act: () => fe.removeGroupWithNodes(id) }
    ];
  } else if (menu && menu.type === 'edge') {
    const id = menu.id;
    menuItems = [
      { label: 'Edit label', hint: 'edge', col: 'var(--txt)', act: () => fe.editEdge(id) },
      { label: 'Delete edge', hint: 'Del', col: '#e07a6a', act: () => setState({ menu: null }, () => fe.removeEdge(id)) }
    ];
  } else if (menu && menu.type === 'canvas') {
    menuItems = [
      { label: 'Create empty group', hint: 'box', col: 'var(--txt)', act: () => fe.addGroup(menu.at) },
      { label: 'Paste node here', hint: 'Ctrl+V', col: 'var(--txt)', act: () => fe.pasteNode(menu.at) },
      { label: 'Copy flow (JSON)', hint: 'all', col: 'var(--txt)', act: () => fe.copyJson() },
      { label: 'Save version', hint: 'Ctrl+S', col: 'var(--txt)', act: () => fe.saveVersion() },
      { label: 'Center on origin', hint: '0,0', col: 'var(--txt)', act: () => { setState({ menu: null }); fe.center(); } }
    ];
  }

  // The boxes, in the order they are drawn: the last one is on top, which is
  // also the one that claims a node sitting in an overlap.
  const nodeCount = {};
  nodes.forEach((n) => {
    if (n.g) nodeCount[n.g] = (nodeCount[n.g] || 0) + 1;
  });
  const viewGroups = groups.map((g) => ({
    ...g,
    count: nodeCount[g.id] || 0,
    selected: (sel && sel.type === 'group' && sel.id === g.id) || (!!state.gdrag && state.gdrag.id === g.id),
    // Lit while it is being dragged or resized, so it is obvious which nodes
    // are about to join or leave it.
    active: (!!state.gdrag && state.gdrag.id === g.id) || (!!state.gresize && state.gresize.id === g.id),
    // The pastel colours are unreadable as text in the light theme, the same
    // fix the nodes already apply to the tool colour.
    ink: light ? shade(g.col, 0.62) : g.col,
    renaming: gRenaming === g.id,
    renameDraft: gRenaming === g.id ? gRenameDraft : '',
    paletteOpen: palette === g.id
  }));

  const viewNodes = nodes.map((n) => {
    const isSel = (sel && sel.type === 'node' && sel.id === n.id) || multi.indexOf(n.id) >= 0;
    const isTgt = link && hover === n.id && link.from !== n.id;
    const hasDesc = n.desc !== null && n.desc !== undefined;
    return {
      ...n,
      accent,
      dim: n.col + '1f',
      stroke: isTgt
        ? accent
        : multi.indexOf(n.id) >= 0
          ? accent
          : isSel
            ? 'var(--edge2)'
            : 'var(--edge1)',
      shadow: isTgt ? '0 0 0 3px ' + accent + '33' : 'var(--nodesh)',
      cxy: Math.round(n.x + nw(n) / 2) + ', ' + Math.round(-(n.y + nh(n) / 2)),
      degree: (deg[n.id] || 0) + ' conex.',
      hasDesc,
      // In the light theme the tool colours are too pastel for text; the same
      // darkening applied to the accent fixes it.
      stackCol: light ? shade(n.col, 0.62) : n.col,
      renaming: renaming === n.id,
      renameDraft: renaming === n.id ? renameDraft : '',
      resizing: !!state.resize && state.resize.id === n.id,
      // A node in the current Ctrl+click pile gets the accent border, so the
      // selection is visible before the group exists.
      piled: multi.indexOf(n.id) >= 0,
      // The node keeps only the slug; the image comes from the loaded catalog.
      icon: n.tool ? fe.iconBySlug[n.tool] || null : null,
      onMetaKey: (i, v) => fe.patch(n.id, { meta: n.meta.map((x, j) => (j === i ? { ...x, k: v } : x)) }, 'text:metak:' + n.id + ':' + i),
      onMetaVal: (i, v) => fe.patch(n.id, { meta: n.meta.map((x, j) => (j === i ? { ...x, v } : x)) }, 'text:metav:' + n.id + ':' + i),
      onMetaRemove: (i) => fe.patch(n.id, { meta: n.meta.filter((x, j) => j !== i) })
    };
  });

  return (
    <div className="fe-root">
      <Header
        saveOpen={saveOpen}
        onToggleSave={() => setState((s) => ({ saveOpen: !s.saveOpen, actionsOpen: false, menu: null }))}
        onSavePng={fe.savePng}
        onSaveJson={fe.saveJson}
        onCopyJson={fe.copyJson}
        onGravarVersao={() => fe.saveVersion()}
        onGravarComoNovo={() => fe.saveAsNew()}
        onEnviarPng={fe.uploadPng}
        actionsOpen={actionsOpen}
        onToggleActions={fe.toggleActions}
        onImportJson={fe.importJson}
        flow={flow}
        dirty={dirty}
        saving={saving}
        viewing={viewing}
        onHome={onHome}
        permission={state.permission}
        canManage={fe.canManage}
        shareOpen={share.open}
        onToggleShare={fe.toggleShare}
        share={{
          state: share.state,
          loading: share.loading,
          error: share.error,
          notice: share.notice,
          smtpReady: !!smtpReady,
          onShareUser: fe.shareWithUser,
          onChangePermission: fe.changeSharePermission,
          onRevokeShare: fe.revokeShare,
          onCreateLink: fe.createShareLink,
          onRevokeLink: fe.revokeShareLink,
          onCopyLink: fe.copyShareLink,
          onSendEmail: fe.sendShareEmail
        }}
        onAbrirBiblioteca={fe.openLibrary}
        onNovoFluxo={fe.newFlow}
        onRenomear={() => fe.renameFlow()}
        historyOpen={versions.open}
        onToggleHistory={fe.toggleHistory}
        history={{
          versions,
          onView: fe.viewVersion,
          onRestore: fe.restoreVersion,
          onRemoveAsset: fe.deleteFile,
          assetUrl: fe.fileUrl
        }}
        canUndo={state.history.canUndo}
        canRedo={state.history.canRedo}
        onUndo={fe.undo}
        onRedo={fe.redo}
        themeIcon={light ? '☾' : '☀'}
        onToggleTheme={fe.toggleTheme}
        onOrganize={fe.organize}
      />

      <div className="fe-body">
        <Sidebar
          readOnly={!fe.canEdit}
          open={boxOpen}
          width={sidebarWidth}
          onToggle={fe.toggleSidebar}
          onResize={fe.resizeSidebar}
          q={q}
          onSearch={(v) => setState({ q: v })}
          onClearSearch={() => setState({ q: '' })}
          results={fe.results}
          totalCount={fe.toolCount}
          onNewTool={fe.openToolModal}
          onEditTool={fe.openEditToolModal}
          hasTools={fe.catalog.length > 0}
          onRemoveTool={fe.deleteCustomTool}
        />

        {library.open && (
          <FlowLibrary
            library={library}
            abertoId={flow ? flow.id : null}
            onFechar={fe.closeLibrary}
            onBuscar={fe.searchLibrary}
            onAlternarLixeira={fe.toggleTrash}
            onAbrir={fe.openFlow}
            onNovo={fe.newFlow}
            onRenomear={fe.renameFlow}
            onRemover={fe.deleteFlow}
            onRestaurar={fe.restoreFlow}
          />
        )}

        <div
          ref={viewportRef}
          data-vp="1"
          className="fe-canvas"
          onMouseDown={fe.onDown}
          onMouseMove={fe.onMove}
          onMouseUp={fe.onUp}
          onMouseLeave={fe.onUp}
          onWheel={fe.onWheel}
          onContextMenu={fe.onCanvasMenu}
          style={{ backgroundSize: 24 * scale + 'px ' + 24 * scale + 'px', backgroundPosition: pan.x + 'px ' + pan.y + 'px', cursor: state.panning ? 'grabbing' : link ? 'crosshair' : 'default' }}
        >
          <div className="fe-layer" style={{ transform: 'translate(' + pan.x + 'px, ' + pan.y + 'px) scale(' + scale + ')' }}>
            <div className="fe-axis-x" />
            <div className="fe-axis-y" />
            <div className="fe-axis-label" style={{ left: 8, top: 8 }}>0,0</div>
            <div className="fe-axis-label" style={{ left: 520, top: 8 }}>+x</div>
            <div className="fe-axis-label" style={{ left: 8, top: -320 }}>+y</div>

            {/* The boxes come first in the DOM, so they are painted under the
                edges and the cards -- a group is a background, never a lid. */}
            {viewGroups.map((g) => (
              <Group
                key={g.id}
                g={g}
                stop={fe.clipStop}
                onDown={(e) => fe.startGroupDrag(e, g)}
                onMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setState({ menu: { x: e.clientX, y: e.clientY, type: 'group', id: g.id }, sel: { type: 'group', id: g.id }, multi: [] });
                }}
                onResize={fe.startGroupResize}
                onRenameStart={fe.startGroupRename}
                onRenameChange={fe.changeGroupRename}
                onRenameCommit={fe.commitGroupRename}
                onRenameCancel={fe.cancelGroupRename}
                onPalette={fe.togglePalette}
                onColor={fe.setGroupColor}
              />
            ))}

            <EdgeSvg paths={paths} pendingPath={pendingPath} accent={accent} />

            {labels.map((l) => (
              <div key={l.id} className="fe-edge-label" style={{ left: l.x, top: l.y }}>
                <input
                  data-elabel={l.id}
                  value={l.value || ''}
                  onChange={l.onChange}
                  onBlur={l.onBlur}
                  onMouseDown={fe.clipStop}
                  onDoubleClick={fe.clipStop}
                  placeholder="input / output"
                  style={{ borderColor: l.stroke }}
                />
              </div>
            ))}

            {viewNodes.map((n) => (
              <Node
                key={n.id}
                n={n}
                registerRef={registerNodeRef(n.id)}
                stop={fe.clipStop}
                onDown={(e) => fe.startNodeDrag(e, n)}
                onEnter={() => setState({ hover: n.id })}
                onLeave={() => setState((s) => ({ hover: s.hover === n.id ? null : s.hover }))}
                onMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setState({ menu: { x: e.clientX, y: e.clientY, type: 'node', id: n.id }, sel: { type: 'node', id: n.id } });
                }}
                onToggleDesc={(id, hasDesc) => fe.patch(id, { desc: hasDesc ? null : '' })}
                onDesc={(id, v) => fe.patch(id, { desc: v }, 'text:desc:' + id)}
                onToggleMeta={(node) => {
                  if (!(node.meta || []).length) return;
                  fe.patch(node.id, { metaOpen: node.metaOpen === false });
                }}
                onAddMeta={(id) => {
                  fe.patch(id, { meta: (n.meta || []).concat([{ k: '', v: '' }]), metaOpen: true });
                  setState({ sel: { type: 'node', id }, status: 'metadata row added' });
                }}
                onStartLink={(e, id) => {
                  e.stopPropagation();
                  if (!fe.canEdit) return;
                  const w = fe.toWorld(e);
                  setState({ link: { from: id, x: w.x, y: w.y }, status: 'drag to the target node' });
                }}
                onStartResize={fe.startResize}
                onRenameStart={fe.startRename}
                onRenameChange={fe.changeRename}
                onRenameCommit={fe.commitRename}
                onRenameCancel={fe.cancelRename}
              />
            ))}
          </div>

          {/* Zoom and cursor coordinates: they float in the top-right corner
              of the plane, just below the header's Save button. */}
          <div
            className="fe-viewtools"
            onMouseDown={fe.clipStop}
            onWheel={fe.clipStop}
            onContextMenu={(e) => e.stopPropagation()}
          >
            <div className="fe-zoom">
              <button className="fe-zoom-btn" title="Zoom out" onClick={() => fe.zoomTo(scale / 1.2)}>−</button>
              <span className="fe-zoom-pct">{Math.round(scale * 100)}%</span>
              <button className="fe-zoom-btn" title="Zoom in" onClick={() => fe.zoomTo(scale * 1.2)}>+</button>
            </div>
            <div className="fe-coord">
              <span className="fe-coord-axis">x</span>
              <span className="fe-coord-val">{cursor.x}</span>
              <span className="fe-coord-axis">y</span>
              <span className="fe-coord-val">{cursor.y}</span>
            </div>
          </div>

          {nodes.length === 0 && groups.length === 0 && (
            <div className="fe-empty-state">
              <div className="fe-empty-state-inner">
                <span className="fe-empty-state-title">Empty plane</span>
                <span className="fe-empty-state-sub">Search "airflow" in the tool sidebar, on the left.</span>
              </div>
            </div>
          )}

          <div className="fe-statusbar">
            <span>{nodes.length} nodes</span>
            <span>{edges.length} edges</span>
            {groups.length > 0 && <span>{groups.length === 1 ? '1 group' : groups.length + ' groups'}</span>}
            <span className={'fe-status-doc' + (dirty ? ' fe-status-dirty' : '')}>
              {flow
                ? flow.name + ' · v' + flow.version + (dirty ? ' (changed)' : '')
                : dirty
                  ? 'unsaved'
                  : 'new flow'}
            </span>
            <span className="fe-status-msg">{status}</span>
          </div>
        </div>
      </div>

      {toolModal.open && (
        <ToolModal
          catalog={fe.catalog}
          mode={toolModal.mode}
          saving={toolModal.saving}
          error={toolModal.error}
          usage={state.toolUsage}
          onCancel={fe.closeToolModal}
          onCreate={fe.createCustomTool}
          onUpdate={fe.updateCustomTool}
          onUsage={fe.checkToolUsage}
          onDelete={fe.deleteCustomTool}
        />
      )}

      <ContextMenu menu={menu} items={menuItems} />
    </div>
  );
}
