import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../flow/api.js';
import * as opsApi from '../ops/api.js';
import PasswordModal from './PasswordModal.jsx';
import PromoteDiagramModal from './PromoteDiagramModal.jsx';
import NewPipelineModal from './NewPipelineModal.jsx';
import { goFlow, goNew, goLineage, goPipeline } from './route.js';
import HealthBadge from '../ops/HealthBadge.jsx';
import Brand from './Brand.jsx';

const timeAgo = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const minutes = Math.round((Date.now() - d.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.round(hours / 24);
  if (days < 7) return days + 'd ago';
  return d.toLocaleDateString();
};

const ROTULO = { view: 'view only', edit: 'can edit', full: 'full control' };

// Homepage: the diagrams this account touched most recently, its own and the
// ones shared with it. Also includes the data lineage tab showing watched
// pipelines. Opening one is a hash navigation, so the browser Back button
// returns here.
export default function Home({ user, onSignOut, themeIcon, onToggleTheme, view = 'diagrams' }) {
  const [items, setItens] = useState([]);
  const [lineageData, setLineageData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  // Account menu (change password, sign out) and the modal it opens.
  const [menu, setMenu] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [notice, setNotice] = useState(null);
  const accountRef = useRef(null);
  // The "New ▾" menu and the promote-a-diagram modal.
  const [newMenu, setNewMenu] = useState(false);
  const [promovendo, setPromovendo] = useState(false);
  const [creatingPipeline, setCreatingPipeline] = useState(false);
  const newRef = useRef(null);
  // Deletion confirmation modal
  const [deletingPipeline, setDeletingPipeline] = useState(null);

  useEffect(() => {
    if (!menu) return undefined;
    // Closes on an outside click, like the project's other dropdowns.
    const aoClicar = (e) => {
      if (accountRef.current && !accountRef.current.contains(e.target)) setMenu(false);
    };
    document.addEventListener('mousedown', aoClicar);
    return () => document.removeEventListener('mousedown', aoClicar);
  }, [menu]);

  useEffect(() => {
    if (!newMenu) return undefined;
    const aoClicar = (e) => {
      if (newRef.current && !newRef.current.contains(e.target)) setNewMenu(false);
    };
    document.addEventListener('mousedown', aoClicar);
    return () => document.removeEventListener('mousedown', aoClicar);
  }, [newMenu]);

  const load = useCallback(async (q) => {
    setLoading(true);
    try {
      setItens(await api.listFlows(q, false));
      setError(null);
    } catch (err) {
      setError((err && err.message) || 'could not load your diagrams');
    }
    setLoading(false);
  }, []);

  const loadLineage = useCallback(async () => {
    setLoading(true);
    try {
      const data = await opsApi.listPipelines();
      setLineageData(data);
      setError(null);
    } catch (err) {
      setError((err && err.message) || 'could not load lineage');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // Debounce da query: cada tecla dispararia um GET numa API com teto de CPU.
    const t = setTimeout(() => load(query), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, load]);

  useEffect(() => {
    if (view === 'lineage') {
      let alive = true;
      loadLineage().then(() => {
        if (alive) {
          const timer = setInterval(loadLineage, 30000);
          return () => clearInterval(timer);
        }
      });
      return () => {
        alive = false;
      };
    }
  }, [view, loadLineage]);

  async function remove(f) {
    if (!window.confirm('Move "' + f.name + '" to the trash?')) return;
    try {
      await api.deleteFlow(f.id, false);
      load(query);
    } catch (err) {
      setError((err && err.message) || 'could not move it to the trash');
    }
  }

  async function rename(f) {
    const name = window.prompt('Flow name', f.name);
    if (name === null || !name.trim()) return;
    try {
      await api.renameFlow(f.id, { name: name.trim() });
      load(query);
    } catch (err) {
      setError((err && err.message) || 'could not rename it');
    }
  }

  const mine = items.filter((f) => f.is_owner);
  const sharedWithMe = items.filter((f) => !f.is_owner);

  return (
    <div className="fe-home">
      <header className="fe-home-head">
        <div className="fe-home-brand">
          <Brand subtitle="DESIGN · BUILD · OBSERVE" />
        </div>
        <div className="fe-spacer" />
        <button className="fe-icon-toggle" title="Toggle light / dark" onClick={onToggleTheme}>
          {themeIcon}
        </button>
        <div className="fe-account-anchor" ref={accountRef}>
          <button
            className={'fe-home-user' + (menu ? ' fe-home-user-on' : '')}
            title={user.email}
            onClick={() => setMenu((v) => !v)}
          >
            <span className="fe-home-avatar">{(user.name || '?').slice(0, 1).toUpperCase()}</span>
            <span className="fe-home-username">{user.name}</span>
            <span className="fe-caret">▾</span>
          </button>
          {menu && (
            <div className="fe-account-menu">
              <div className="fe-account-id">
                <span className="fe-account-name">{user.name}</span>
                <span className="fe-account-mail">{user.email}</span>
              </div>
              <button
                className="fe-menu-item"
                onClick={() => {
                  setMenu(false);
                  setChangingPassword(true);
                }}
              >
                <span className="fe-menu-item-title">Change password</span>
                <span className="fe-menu-item-sub">signs out every other session</span>
              </button>
              <button className="fe-menu-item" onClick={onSignOut}>
                <span className="fe-menu-item-title">Sign out</span>
                <span className="fe-menu-item-sub">on this device</span>
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="fe-home-body">
        <div className="fe-home-title-row">
          <div>
            <div className="fe-home-tabs">
              <button
                className={'fe-home-tab' + (view === 'diagrams' ? ' fe-home-tab--active' : '')}
                onClick={() => {
                  setQuery('');
                  goFlow(null);
                }}
              >
                Your diagrams
              </button>
              <button
                className={'fe-home-tab' + (view === 'lineage' ? ' fe-home-tab--active' : '')}
                onClick={goLineage}
              >
                Data lineage
              </button>
            </div>
            <h1 className="fe-home-title">
              {view === 'lineage' ? 'Data lineage' : 'Your diagrams'}
            </h1>
            <p className="fe-home-sub">
              {view === 'lineage' ? (
                lineageData && lineageData.unwatched > 0 ? (
                  `${lineageData.unwatched} object${lineageData.unwatched === 1 ? '' : 's'} running that nobody is watching`
                ) : (
                  'Monitor the data pipelines you are watching.'
                )
              ) : (
                'Everything you have built here, most recently edited first.'
              )}
            </p>
          </div>
          <div className="fe-new-dropdown" ref={newRef}>
            <button
              className="fe-btn"
              onClick={() => setNewMenu((v) => !v)}
            >
              <span className="fe-btn-accent-mark">+</span>New
              <span className="fe-caret">▾</span>
            </button>
            {newMenu && (
              <div className="fe-dropdown-menu">
                {view === 'diagrams' && (
                  <>
                    <button
                      className="fe-dropdown-item"
                      onClick={() => {
                        setNewMenu(false);
                        goNew();
                      }}
                    >
                      New diagram
                    </button>
                  </>
                )}
                {view === 'lineage' && (
                  <>
                    <button
                      className="fe-dropdown-item"
                      onClick={() => {
                        setNewMenu(false);
                        setPromovendo(true);
                      }}
                    >
                      Monitor a diagram…
                    </button>
                    <button
                      className="fe-dropdown-item"
                      onClick={() => {
                        setNewMenu(false);
                        setCreatingPipeline(true);
                      }}
                    >
                      New lineage…
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {view === 'diagrams' && (
          <input
            className="fe-home-search"
            value={query}
            placeholder="search by name or description…"
            onChange={(e) => setQuery(e.target.value)}
          />
        )}

        {error && <div className="fe-modal-error">{error}</div>}
        {notice && <div className="fe-home-notice">{notice}</div>}

        {view === 'diagrams' && (
          <>
            {loading && <div className="fe-home-empty">loading…</div>}

            {!loading && !items.length && (
              <div className="fe-home-empty">
                {query
                  ? 'no diagram matches "' + query + '"'
                  : 'Nothing here yet — create your first diagram.'}
              </div>
            )}

            {!loading && !!mine.length && (
              <Section title="Created by you" items={mine} onOpen={goFlow} onRename={rename} onRemove={remove} />
            )}
            {!loading && !!sharedWithMe.length && (
              <Section title="Shared with you" items={sharedWithMe} onOpen={goFlow} />
            )}
          </>
        )}

        {view === 'lineage' && (
          <>
            {loading && <div className="fe-home-empty">loading…</div>}

            {!loading && !lineageData?.items.length && (
              <div className="fe-home-empty">No diagram has been promoted yet.</div>
            )}

            {!loading && !!lineageData?.items.length && (
              <section className="fe-home-section">
                <h2 className="fe-home-section-title">
                  Active
                  <span className="fe-home-count">{lineageData.items.length}</span>
                </h2>
                <div className="fe-home-grid">
                  {lineageData.items.map((p) => (
                    <article key={p.slug} className="fe-card">
                      <button className="fe-card-main" onClick={() => goPipeline(p.slug)}>
                        <span className="fe-card-name">
                          {p.name}
                          <span className="fe-item-tag"><HealthBadge state={p.state} /></span>
                        </span>
                        <span className="fe-card-meta">
                          {p.bound} of {p.total} nodes bound
                        </span>
                        <span className="fe-card-foot">
                          <span className="fe-card-when">{
                            p.collected_age_s === null ? 'never collected' :
                            p.collected_age_s < 120 ? 'collected just now' :
                            p.collected_age_s < 7200 ? `collected ${Math.round(p.collected_age_s / 60)} min ago` :
                            `collected ${Math.round(p.collected_age_s / 3600)} h ago`
                          }</span>
                        </span>
                      </button>
                      <div className="fe-card-actions">
                        <button
                          className="fe-mini-btn"
                          title="Open"
                          onClick={() => goPipeline(p.slug)}
                        >
                          →
                        </button>
                        <button
                          className="fe-mini-btn fe-mini-danger"
                          title="Delete"
                          onClick={() => setDeletingPipeline(p)}
                        >
                          🗑
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {changingPassword && (
        <PasswordModal
          onCancel={() => setChangingPassword(false)}
          onSubmit={async (atual, nova) => {
            await api.changePassword(atual, nova);
            setChangingPassword(false);
            setNotice('Password changed. Every other session was signed out.');
          }}
        />
      )}

      {promovendo && (
        <PromoteDiagramModal
          diagrams={items.filter((f) => f.is_owner)}
          onCancel={() => setPromovendo(false)}
          onPromoted={(slug) => {
            setPromovendo(false);
            goPipeline(slug);
          }}
        />
      )}

      {creatingPipeline && (
        <NewPipelineModal
          onCancel={() => setCreatingPipeline(false)}
          onCreated={(slug) => {
            setCreatingPipeline(false);
            goPipeline(slug);
          }}
        />
      )}

      {deletingPipeline && (
        <div className="fe-modal-overlay" onClick={() => setDeletingPipeline(null)}>
          <div className="fe-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete "{deletingPipeline.name}"?</h2>
            <p>
              The diagram itself is kept. This lineage and every binding to its jobs and tables are
              removed, and cannot be restored — promoting the diagram again starts unbound.
            </p>
            <div className="fe-modal-actions">
              <button className="fe-btn" onClick={() => setDeletingPipeline(null)}>
                Cancel
              </button>
              <button
                className="fe-btn fe-btn-danger"
                onClick={async () => {
                  try {
                    await opsApi.deletePipeline(deletingPipeline.slug);
                    setDeletingPipeline(null);
                    loadLineage();
                  } catch (err) {
                    setError((err && err.message) || 'could not delete lineage');
                    setDeletingPipeline(null);
                  }
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, items, onOpen, onRename, onRemove }) {
  return (
    <section className="fe-home-section">
      <h2 className="fe-home-section-title">
        {title}
        <span className="fe-home-count">{items.length}</span>
      </h2>
      <div className="fe-home-grid">
        {items.map((f) => (
          <article key={f.id} className="fe-card">
            <button className="fe-card-main" onClick={() => onOpen(f.slug || f.id)}>
              <span className="fe-card-name">
                {f.name}
                {f.has_draft && (
                  <span className="fe-item-tag" title="unsaved draft">
                    draft
                  </span>
                )}
              </span>
              <span className="fe-card-meta">
                v{f.current_version} · {f.node_count} nodes · {f.edge_count} edges
              </span>
              {f.description && <span className="fe-card-desc">{f.description}</span>}
              <span className="fe-card-foot">
                <span className="fe-card-when">{timeAgo(f.updated_at)}</span>
                {!f.is_owner && f.owner_name && (
                  <span className="fe-card-owner">by {f.owner_name}</span>
                )}
                {f.is_owner && f.shared_count > 0 && (
                  <span className="fe-card-owner">
                    shared with {f.shared_count}
                  </span>
                )}
                <span className={'fe-perm fe-perm-' + f.permission}>{ROTULO[f.permission]}</span>
              </span>
            </button>
            {(onRename || onRemove) && (
              <div className="fe-card-actions">
                {onRename && (
                  <button className="fe-mini-btn" title="Rename" onClick={() => onRename(f)}>
                    ✎
                  </button>
                )}
                {onRemove && (
                  <button
                    className="fe-mini-btn fe-mini-danger"
                    title="Move to the trash"
                    onClick={() => onRemove(f)}
                  >
                    🗑
                  </button>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
