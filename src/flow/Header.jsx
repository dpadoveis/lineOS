import { useRef } from 'react';
import HistoryMenu from './HistoryMenu.jsx';
import ShareMenu from './ShareMenu.jsx';
import Brand from '../app/Brand.jsx';

export default function Header({
  saveOpen,
  onToggleSave,
  onSavePng,
  onSaveJson,
  onCopyJson,
  onSaveVersion,
  onSaveAsNew,
  onUploadPng,
  // Actions: one dropdown holding import and sharing, left of Save. Sharing
  // needs a whole panel, so the menu only opens it -- the panel then hangs
  // from the same button.
  actionsOpen,
  onToggleActions,
  onImportJson,
  flow,
  dirty,
  saving,
  viewing,
  onOpenLibrary,
  onNewFlow,
  onRename,
  // History: the document name is the trigger; there is no button of its own.
  historyOpen,
  onToggleHistory,
  history,
  // Back to the home (this user's recent diagrams).
  onHome,
  // Sharing: an entry in the Actions menu, and a panel anchored on it. Only
  // full control can manage who else gets in.
  canManage,
  shareOpen,
  onToggleShare,
  share,
  permission,
  // Undo / redo: the two small buttons on the right, before the theme.
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  themeIcon,
  onToggleTheme,
  onOrganize
}) {
  const fileRef = useRef(null);
  const docName = flow ? flow.name : 'untitled';
  const caption = saving
    ? 'saving…'
    : viewing
      ? 'viewing v' + viewing
      : flow
        ? 'v' + flow.version + (dirty ? ' · changed' : ' · saved')
        : dirty
          ? 'unsaved'
          : 'new';

  return (
    <header className="fe-header">
      <button className="fe-home-link" onClick={onHome} title="Back to your diagrams">
        <Brand subtitle="ALL DIAGRAMS" />
      </button>

      {/* Identity of the open document and, on click, its version history. */}
      <div className="fe-doc-anchor">
        <button
          className={'fe-doc' + (historyOpen ? ' fe-doc-on' : '')}
          title="Version history"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onToggleHistory}
        >
          <span className="fe-doc-name">
            {docName}
            {dirty && <span className="fe-doc-dot" title="unsaved changes">•</span>}
          </span>
          <span className="fe-doc-sub">
            {caption}
            <span className="fe-doc-caret">▾</span>
          </span>
        </button>
        {historyOpen && (
          <HistoryMenu
            versions={history.versions}
            flow={flow}
            viewing={viewing}
            onClose={onToggleHistory}
            onView={history.onView}
            onRestore={history.onRestore}
            onRename={onRename}
            onSaveAsNew={onSaveAsNew}
            onRemoveAsset={history.onRemoveAsset}
            assetUrl={history.assetUrl}
          />
        )}
      </div>

      {permission === 'view' && (
        <span className="fe-readonly" title="This diagram was shared with you as read-only">
          view only
        </span>
      )}

      <button className="fe-btn" onClick={() => onOpenLibrary(false)}>
        <span className="fe-btn-accent-mark">▤</span>Flows
      </button>

      <button className="fe-ghost-btn" onClick={onNewFlow}>New</button>

      <div className="fe-spacer" />

      {/* Zoom and coordinates moved out of here: they now float in the
          top-right corner of the plane, just below the Save button. */}
      <div className="fe-hist">
        <button className="fe-hist-btn" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}>
          ↶
        </button>
        <button className="fe-hist-btn" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={onRedo}>
          ↷
        </button>
      </div>

      <button className="fe-icon-toggle" title="Toggle light / dark" onClick={onToggleTheme}>
        {themeIcon}
      </button>

      <button className="fe-organize-btn" title="Arrange nodes into layers" onClick={onOrganize}>
        <span style={{ font: "600 11px 'IBM Plex Mono', monospace" }}>⋮⋮</span>Arrange
      </button>

      {/* Actions: import and sharing under one button, left of Save. The
          sharing panel is anchored here too, so it opens exactly where the
          entry that asked for it was. */}
      <div className="fe-actions-anchor">
        <button
          className={'fe-btn' + (actionsOpen || shareOpen ? ' fe-btn-on' : '')}
          onClick={onToggleActions}
        >
          <span className="fe-btn-accent-mark">⚙</span>Actions<span className="fe-caret">▾</span>
        </button>
        {actionsOpen && (
          <div className="fe-save-menu">
            <button className="fe-menu-item" onClick={() => fileRef.current && fileRef.current.click()}>
              <span className="fe-menu-item-title">
                <span className="fe-menu-item-mark">↑</span>Import from JSON
              </span>
              <span className="fe-menu-item-sub">opens a flow.json from your computer</span>
            </button>
            {canManage && (
              <button className="fe-menu-item" onClick={onToggleShare}>
                <span className="fe-menu-item-title">
                  <span className="fe-menu-item-mark">⇱</span>Share diagram
                </span>
                <span className="fe-menu-item-sub">people, links and email invitations</span>
              </button>
            )}
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const file = e.target.files && e.target.files[0];
            // Clear the input so picking the same file again still fires
            // another change.
            e.target.value = '';
            if (file) onImportJson(file);
          }}
        />
        {canManage && shareOpen && (
          <ShareMenu
            flow={flow}
            state={share.state}
            loading={share.loading}
            error={share.error}
            notice={share.notice}
            smtpReady={share.smtpReady}
            onClose={onToggleShare}
            onShareUser={share.onShareUser}
            onChangePermission={share.onChangePermission}
            onRevokeShare={share.onRevokeShare}
            onCreateLink={share.onCreateLink}
            onRevokeLink={share.onRevokeLink}
            onCopyLink={share.onCopyLink}
            onSendEmail={share.onSendEmail}
          />
        )}
      </div>

      {/* Save closes the header on the right; its menu opens edge-aligned. */}
      <div className="fe-save-anchor">
        <button className="fe-btn" onClick={onToggleSave}>
          <span className="fe-btn-accent-mark">↓</span>Save<span className="fe-caret">▾</span>
        </button>
        {saveOpen && (
          <div className="fe-save-menu">
            <button className="fe-menu-item" onClick={onSaveVersion}>
              <span className="fe-menu-item-title">Save version</span>
              <span className="fe-menu-item-sub">Ctrl+S · enters the server history</span>
            </button>
            <button className="fe-menu-item" onClick={onSaveAsNew}>
              <span className="fe-menu-item-title">Save as new…</span>
              <span className="fe-menu-item-sub">creates another flow on the server</span>
            </button>
            <button className="fe-menu-item" onClick={onUploadPng}>
              <span className="fe-menu-item-title">Image (PNG) → server</span>
              <span className="fe-menu-item-sub">attaches the rendered plane to the flow</span>
            </button>
            <div className="fe-menu-sep" />
            <button className="fe-menu-item" onClick={onSavePng}>
              <span className="fe-menu-item-title">Image (PNG)</span>
              <span className="fe-menu-item-sub">downloads the rendered plane</span>
            </button>
            <button className="fe-menu-item" onClick={onSaveJson}>
              <span className="fe-menu-item-title">JSON (download)</span>
              <span className="fe-menu-item-sub">the whole flow as a file</span>
            </button>
            <button className="fe-menu-item" onClick={onCopyJson}>
              <span className="fe-menu-item-title">JSON (copy)</span>
              <span className="fe-menu-item-sub">paste into another lineOS editor</span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
