import { useEffect, useState } from 'react';
import { readPreview, readSchema } from '../api.js';
import { filterParams } from '../dataset.js';

export default function DatasetPreview({ slug, objectId }) {
  const [schema, setSchema] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(50);
  const [orderBy, setOrderBy] = useState(null);
  const [dir, setDir] = useState('desc');
  const [filters, setFilters] = useState([]);

  // Load schema once
  useEffect(() => {
    let alive = true;
    readSchema(slug, objectId)
      .then((r) => {
        if (alive) setSchema(r);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [slug, objectId]);

  // Load preview when parameters change
  const handleApply = () => {
    let alive = true;
    setLoading(true);
    setError(null);
    const filterStrings = filterParams(filters);
    readPreview(slug, objectId, { limit, orderBy, dir, filters: filterStrings })
      .then((r) => {
        if (alive) setPreview(r);
      })
      .catch((e) => {
        if (alive) {
          if (e.status === 403) {
            setError('Preview requires edit on the diagram.');
          } else if (e.status === 503) {
            setError('The dataset source is not reachable.');
          } else if (e.status === 504) {
            setError('The query took longer than 15 s — add a filter.');
          } else {
            setError(e.message);
          }
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  };

  const handleHeaderClick = (columnName) => {
    if (orderBy === columnName) {
      setDir(dir === 'asc' ? 'desc' : 'asc');
    } else {
      setOrderBy(columnName);
      setDir('desc');
    }
  };

  const handleFilterChange = (idx, field, value) => {
    const newFilters = [...filters];
    newFilters[idx] = { ...newFilters[idx], [field]: value };
    setFilters(newFilters);
  };

  const handleRemoveFilter = (idx) => {
    setFilters(filters.filter((_, i) => i !== idx));
  };

  const handleAddFilter = () => {
    if (filters.length < 5) {
      setFilters([...filters, { column: '', op: 'eq', value: '' }]);
    }
  };

  const columns = schema?.columns || [];
  const columnNames = columns.map((c) => c.name);
  const ops = ['=', '≠', '>', '≥', '<', '≤', 'contains', 'is null', 'not null'];
  const opsMap = {
    '=': 'eq',
    '≠': 'ne',
    '>': 'gt',
    '≥': 'gte',
    '<': 'lt',
    '≤': 'lte',
    'contains': 'contains',
    'is null': 'null',
    'not null': 'notnull',
  };
  const opsByOp = {
    eq: '=',
    ne: '≠',
    gt: '>',
    gte: '≥',
    lt: '<',
    lte: '≤',
    contains: 'contains',
    null: 'is null',
    notnull: 'not null',
  };

  if (error && !preview) {
    return <div className="ops-dataset-error">{error}</div>;
  }

  return (
    <div className="ops-dataset-preview">
      <div className="ops-dataset-controls">
        <div className="ops-dataset-filters">
          {filters.map((f, idx) => (
            <div key={idx} className="ops-dataset-filter-row">
              <select
                value={f.column || ''}
                onChange={(e) => handleFilterChange(idx, 'column', e.target.value)}
                className="ops-select ops-dataset-filter-col"
              >
                <option value="">column</option>
                {columnNames.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select
                value={opsByOp[f.op] || '='}
                onChange={(e) => handleFilterChange(idx, 'op', opsMap[e.target.value])}
                className="ops-select ops-dataset-filter-op"
              >
                {ops.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
              {f.op !== 'null' && f.op !== 'notnull' && (
                <input
                  type="text"
                  value={f.value || ''}
                  onChange={(e) => handleFilterChange(idx, 'value', e.target.value)}
                  placeholder="value"
                  className="ops-dataset-filter-value"
                />
              )}
              <button
                type="button"
                onClick={() => handleRemoveFilter(idx)}
                className="ops-dataset-filter-remove"
              >
                ×
              </button>
            </div>
          ))}
          {filters.length < 5 && (
            <button type="button" onClick={handleAddFilter} className="ops-dataset-add-filter">
              + Filter
            </button>
          )}
        </div>

        <div className="ops-dataset-apply-row">
          <select
            value={limit}
            onChange={(e) => setLimit(parseInt(e.target.value))}
            className="ops-select ops-dataset-limit"
          >
            <option value={20}>20 rows</option>
            <option value={50}>50 rows</option>
            <option value={100}>100 rows</option>
          </select>
          <button type="button" onClick={handleApply} className="ops-dataset-apply">
            Apply
          </button>
          {loading && <span className="ops-dataset-status">loading…</span>}
          {error && <span className="ops-dataset-status ops-dataset-status--error">{error}</span>}
        </div>
      </div>

      {preview && (
        <div className="ops-dataset-table-wrap">
          <div className="ops-dataset-info">
            {preview.latest
              ? `latest by ${preview.ordered_by}`
              : preview.ordered_by
                ? `sorted by ${preview.ordered_by} ${preview.direction}`
                : 'sample, not the latest'}
          </div>
          <table className="ops-table ops-dataset-table">
            <thead>
              <tr>
                {preview.columns.map((col) => (
                  <th key={col}>
                    <button
                      type="button"
                      className="ops-table-header-btn"
                      onClick={() => handleHeaderClick(col)}
                    >
                      {col}
                      {orderBy === col && <span className="ops-dataset-sort-indicator">{dir === 'asc' ? '↑' : '↓'}</span>}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, idx) => (
                <tr key={idx}>
                  {row.map((cell, cidx) => (
                    <td key={cidx} className={cell === null ? 'ops-dataset-null' : ''} title={cell || ''}>
                      {cell === null ? 'null' : cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
