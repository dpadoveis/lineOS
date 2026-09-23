import { useEffect, useRef, useState } from 'react';
import * as opsApi from '../ops/api.js';
import { goNew } from './route.js';

// Monitor a diagram: list the account's diagrams with a search box, then
// promote a selected one to a pipeline. Handle two common cases:
// - no diagrams yet: suggest creating one
// - already monitored: go to its panel instead of creating a second pipeline
export default function PromoteDiagramModal({ diagrams, onCancel, onPromoted }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [monitored, setMonitored] = useState(new Set());
  const firstField = useRef(null);

  useEffect(() => {
    if (firstField.current) firstField.current.focus();
  }, []);

  useEffect(() => {
    const aoTeclar = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [onCancel]);

  // Load the list of pipelines to check which diagrams are already monitored
  useEffect(() => {
    opsApi
      .listPipelines()
      .then((data) => {
        const slugs = new Set(data.items.map((p) => p.flow_slug));
        setMonitored(slugs);
      })
      .catch(() => {
        // Fail gracefully
      });
  }, []);

  const filtered = diagrams.filter(
    (d) => d.name.toLowerCase().includes(search.toLowerCase())
  );

  async function promote() {
    if (!selected) return;
    const diagram = diagrams.find((d) => d.id === selected);
    if (!diagram) return;

    // Check if already monitored
    if (monitored.has(diagram.slug)) {
      // Route to the existing pipeline instead of creating a duplicate
      const pipelines = await opsApi.listPipelines();
      const existing = pipelines.items.find((p) => p.flow_slug === diagram.slug);
      if (existing) {
        onPromoted(existing.slug);
      }
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const pipeline = await opsApi.promoteDiagram(diagram.slug, diagram.name + ' ops');
      setLoading(false);
      onPromoted(pipeline.slug);
    } catch (err) {
      setError((err && err.message) || 'could not promote the diagram');
      setLoading(false);
    }
  }

  if (!diagrams.length) {
    return (
      <div className="fe-modal-backdrop" onMouseDown={onCancel}>
        <div
          className="fe-modal"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="fe-modal-head">
            <div className="fe-modal-titles">
              <span className="fe-modal-title">Monitor a diagram</span>
              <span className="fe-modal-sub">
                You have no diagrams yet. Create one first.
              </span>
            </div>
            <button
              type="button"
              className="fe-panel-close"
              onClick={onCancel}
              title="Close"
            >
              ✕
            </button>
          </div>

          <div className="fe-modal-body"></div>

          <div className="fe-modal-foot">
            <button type="button" className="fe-ghost-btn" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="fe-btn" onClick={() => {
              onCancel();
              goNew();
            }}>
              Create a diagram
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fe-modal-backdrop" onMouseDown={onCancel}>
      <form
        className="fe-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          promote();
        }}
      >
        <div className="fe-modal-head">
          <div className="fe-modal-titles">
            <span className="fe-modal-title">Monitor a diagram</span>
            <span className="fe-modal-sub">
              Choose a diagram to watch its nodes' status.
            </span>
          </div>
          <button
            type="button"
            className="fe-panel-close"
            onClick={onCancel}
            title="Close"
          >
            ✕
          </button>
        </div>

        <div className="fe-modal-body">
          <input
            ref={firstField}
            className="fe-field-input"
            type="text"
            placeholder="Search diagrams…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelected(null);
            }}
            style={{ marginBottom: '1rem', width: '100%' }}
          />

          <select
            className="fe-field-input"
            value={selected || ''}
            onChange={(e) => setSelected(e.target.value ? Number(e.target.value) : null)}
            size={Math.min(filtered.length, 5)}
            style={{ width: '100%' }}
          >
            <option value="">Choose a diagram…</option>
            {filtered.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {monitored.has(d.slug) ? ' (already monitored)' : ''}
              </option>
            ))}
          </select>

          {error && <div className="fe-modal-error">{error}</div>}
        </div>

        <div className="fe-modal-foot">
          <button type="button" className="fe-ghost-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="fe-btn"
            disabled={!selected || loading}
          >
            {loading ? 'Promoting…' : 'Monitor'}
          </button>
        </div>
      </form>
    </div>
  );
}
