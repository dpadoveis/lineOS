import { useEffect, useState } from 'react';
import { readStats } from '../api.js';
import { since } from '../format.js';
import { distinctText, pct } from '../dataset.js';

export default function DatasetStats({ slug, objectId }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setStats(null);
    setError(null);
    readStats(slug, objectId)
      .then((r) => {
        if (alive) setStats(r);
      })
      .catch((e) => {
        if (alive) {
          if (e.status === 403) {
            setError('Stats require edit on the diagram.');
          } else {
            setError(e.message);
          }
        }
      });
    return () => {
      alive = false;
    };
  }, [slug, objectId]);

  if (error) {
    return <div className="ops-dataset-error">{error}</div>;
  }
  if (!stats) {
    return <div className="ops-dataset-loading">loading stats…</div>;
  }

  const rowCountText = stats.row_count !== null ? stats.row_count.toLocaleString() : '—';
  const analyzedText = stats.analyzed_at ? `analysed ${since(stats.analyzed_at)}` : 'no statistics yet — the table was never analysed';

  return (
    <div className="ops-dataset-stats">
      <div className="ops-dataset-stats-header">
        {rowCountText} rows · {analyzedText}
      </div>
      <table className="ops-table">
        <thead>
          <tr>
            <th>column</th>
            <th>nulls</th>
            <th>distinct</th>
            <th>most common</th>
            <th>min</th>
            <th>max</th>
          </tr>
        </thead>
        <tbody>
          {stats.columns.map((col) => (
            <tr key={col.name}>
              <td>{col.name}</td>
              <td>{col.null_frac !== null ? pct(col.null_frac) : '—'}</td>
              <td>{distinctText(col.n_distinct, stats.row_count)}</td>
              <td>
                {col.most_common && col.most_common.length > 0 ? (
                  <div className="ops-dataset-most-common">
                    {col.most_common.map((item, idx) => (
                      <span key={idx} className="ops-dataset-chip">
                        {item.value || 'null'} · {pct(item.freq)}
                      </span>
                    ))}
                  </div>
                ) : (
                  '—'
                )}
              </td>
              <td>{col.min || '—'}</td>
              <td>{col.max || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
