import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../flow/api.js';
import * as opsApi from '../ops/api.js';
import PasswordModal from './PasswordModal.jsx';
import PromoteDiagramModal from './PromoteDiagramModal.jsx';
import NewPipelineModal from './NewPipelineModal.jsx';
import { goFlow, goNew, goLineage, goPipeline } from './route.js';
import HealthBadge from '../ops/HealthBadge.jsx';

const quando = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const minutos = Math.round((Date.now() - d.getTime()) / 60000);
  if (minutos < 1) return 'just now';
  if (minutos < 60) return minutos + ' min ago';
  const horas = Math.round(minutos / 60);
  if (horas < 24) return horas + 'h ago';
  const dias = Math.round(horas / 24);
  if (dias < 7) return dias + 'd ago';
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
  const [carregando, setCarregando] = useState(true);
  const [error, setError] = useState(null);
  const [busca, setBusca] = useState('');
  // Menu da conta (troca de senha, sair) e o modal que ele abre.
  const [menu, setMenu] = useState(false);
  const [trocandoSenha, setTrocandoSenha] = useState(false);
  const [aviso, setAviso] = useState(null);
  const contaRef = useRef(null);
  // Menu "New ▾" e o modal de promoção de diagrama
  const [newMenu, setNewMenu] = useState(false);
  const [promovendo, setPromovendo] = useState(false);
  const [criandoPipeline, setCriandoPipeline] = useState(false);
  const newRef = useRef(null);
  // Deletion confirmation modal
  const [deletingPipeline, setDeletingPipeline] = useState(null);

  useEffect(() => {
    if (!menu) return undefined;
    // Fecha por clique fora, como os outros dropdowns do projeto.
    const aoClicar = (e) => {
      if (contaRef.current && !contaRef.current.contains(e.target)) setMenu(false);
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

  const carregar = useCallback(async (q) => {
    setCarregando(true);
    try {
      setItens(await api.listFlows(q, false));
      setError(null);
    } catch (err) {
      setError((err && err.message) || 'could not load your diagrams');
    }
    setCarregando(false);
  }, []);

  const carregarLineage = useCallback(async () => {
    setCarregando(true);
    try {
      const data = await opsApi.listPipelines();
      setLineageData(data);
      setError(null);
    } catch (err) {
      setError((err && err.message) || 'could not load lineage');
    }
    setCarregando(false);
  }, []);

  useEffect(() => {
    // Debounce da busca: cada tecla dispararia um GET numa API com teto de CPU.
    const t = setTimeout(() => carregar(busca), busca ? 250 : 0);
    return () => clearTimeout(t);
  }, [busca, carregar]);

  useEffect(() => {
    if (view === 'lineage') {
      let alive = true;
      carregarLineage().then(() => {
        if (alive) {
          const timer = setInterval(carregarLineage, 30000);
          return () => clearInterval(timer);
        }
      });
      return () => {
        alive = false;
      };
    }
  }, [view, carregarLineage]);

  async function remover(f) {
    if (!window.confirm('Move "' + f.name + '" to the trash?')) return;
    try {
      await api.deleteFlow(f.id, false);
      carregar(busca);
    } catch (err) {
      setError((err && err.message) || 'could not move it to the trash');
    }
  }

  async function renomear(f) {
    const name = window.prompt('Flow name', f.name);
    if (name === null || !name.trim()) return;
    try {
      await api.renameFlow(f.id, { name: name.trim() });
      carregar(busca);
    } catch (err) {
      setError((err && err.message) || 'could not rename it');
    }
  }

  const meus = items.filter((f) => f.is_owner);
  const comigo = items.filter((f) => !f.is_owner);

  return (
    <div className="fe-home">
      <header className="fe-home-head">
        <div className="fe-home-brand">
          <div className="fe-logo">◇</div>
          <div className="fe-title-block">
            <span className="fe-title">Flow Editor</span>
            <span className="fe-subtitle">CARTESIAN PLANE</span>
          </div>
        </div>
        <div className="fe-spacer" />
        <button className="fe-icon-toggle" title="Toggle light / dark" onClick={onToggleTheme}>
          {themeIcon}
        </button>
        <div className="fe-account-anchor" ref={contaRef}>
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
                  setTrocandoSenha(true);
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
                  setBusca('');
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
                        setCriandoPipeline(true);
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
            value={busca}
            placeholder="search by name or description…"
            onChange={(e) => setBusca(e.target.value)}
          />
        )}

        {error && <div className="fe-modal-error">{error}</div>}
        {aviso && <div className="fe-home-notice">{aviso}</div>}

        {view === 'diagrams' && (
          <>
            {carregando && <div className="fe-home-empty">loading…</div>}

            {!carregando && !items.length && (
              <div className="fe-home-empty">
                {busca
                  ? 'no diagram matches "' + busca + '"'
                  : 'Nothing here yet — create your first diagram.'}
              </div>
            )}

            {!carregando && !!meus.length && (
              <Secao titulo="Created by you" items={meus} onAbrir={goFlow} onRenomear={renomear} onRemover={remover} />
            )}
            {!carregando && !!comigo.length && (
              <Secao titulo="Shared with you" items={comigo} onAbrir={goFlow} />
            )}
          </>
        )}

        {view === 'lineage' && (
          <>
            {carregando && <div className="fe-home-empty">loading…</div>}

            {!carregando && !lineageData?.items.length && (
              <div className="fe-home-empty">No diagram has been promoted yet.</div>
            )}

            {!carregando && !!lineageData?.items.length && (
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

      {trocandoSenha && (
        <PasswordModal
          onCancel={() => setTrocandoSenha(false)}
          onSubmit={async (atual, nova) => {
            await api.changePassword(atual, nova);
            setTrocandoSenha(false);
            setAviso('Password changed. Every other session was signed out.');
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

      {criandoPipeline && (
        <NewPipelineModal
          onCancel={() => setCriandoPipeline(false)}
          onCreated={(slug) => {
            setCriandoPipeline(false);
            goPipeline(slug);
          }}
        />
      )}

      {deletingPipeline && (
        <div className="fe-modal-overlay" onClick={() => setDeletingPipeline(null)}>
          <div className="fe-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete "{deletingPipeline.name}"?</h2>
            <p>The diagram itself is kept. Only this monitoring setup is removed.</p>
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
                    carregarLineage();
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

function Secao({ titulo, items, onAbrir, onRenomear, onRemover }) {
  return (
    <section className="fe-home-section">
      <h2 className="fe-home-section-title">
        {titulo}
        <span className="fe-home-count">{items.length}</span>
      </h2>
      <div className="fe-home-grid">
        {items.map((f) => (
          <article key={f.id} className="fe-card">
            <button className="fe-card-main" onClick={() => onAbrir(f.slug || f.id)}>
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
                <span className="fe-card-when">{quando(f.updated_at)}</span>
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
            {(onRenomear || onRemover) && (
              <div className="fe-card-actions">
                {onRenomear && (
                  <button className="fe-mini-btn" title="Rename" onClick={() => onRenomear(f)}>
                    ✎
                  </button>
                )}
                {onRemover && (
                  <button
                    className="fe-mini-btn fe-mini-danger"
                    title="Move to the trash"
                    onClick={() => onRemover(f)}
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
