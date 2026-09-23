import { useEffect, useRef, useState } from 'react';
import * as opsApi from '../ops/api.js';

export default function NewPipelineModal({ onCancel, onCreated }) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  useEffect(() => {
    const aoTeclar = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [onCancel]);

  async function create() {
    if (!name.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await opsApi.createPipeline(name.trim());
      setLoading(false);
      onCreated(result.slug);
    } catch (err) {
      setError((err && err.message) || 'could not create the pipeline');
      setLoading(false);
    }
  }

  return (
    <div className="fe-modal-backdrop" onMouseDown={onCancel}>
      <form
        className="fe-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <div className="fe-modal-head">
          <div className="fe-modal-titles">
            <span className="fe-modal-title">New lineage</span>
            <span className="fe-modal-sub">
              Create a lineage to monitor objects from your inventory.
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
            ref={inputRef}
            className="fe-field-input"
            type="text"
            placeholder="Lineage name…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ marginBottom: '1rem', width: '100%' }}
          />
          {error && <div className="fe-modal-error">{error}</div>}
        </div>

        <div className="fe-modal-foot">
          <button type="button" className="fe-ghost-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="fe-btn"
            disabled={!name.trim() || loading}
          >
            {loading ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
