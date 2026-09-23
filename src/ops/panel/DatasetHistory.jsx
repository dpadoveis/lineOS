import { useEffect, useState } from 'react';
import { readHistory } from '../api.js';
import { seriesPath } from '../dataset.js';

const CHART_HEIGHT = 200;
const CHART_WIDTH = 600;
const PADDING = 40;

export default function DatasetHistory({ slug, objectId }) {
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setHistory(null);
    setError(null);
    readHistory(slug, objectId, 30)
      .then((r) => {
        if (alive) setHistory(r);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [slug, objectId]);

  if (error) {
    return <div className="ops-dataset-error">{error}</div>;
  }
  if (!history) {
    return <div className="ops-dataset-loading">loading history…</div>;
  }

  const points = history.points;
  if (!points || points.length === 0) {
    return <div className="ops-dataset-history-empty">No checks in the last 30 days.</div>;
  }

  // Filter points with valid row_count for the chart
  const validPoints = points.filter((p) => p.row_count !== null && p.row_count !== undefined);
  if (validPoints.length < 2) {
    return (
      <div className="ops-dataset-history-brief">
        {points.length} check{points.length !== 1 ? 's' : ''} recorded.
      </div>
    );
  }

  // Find min/max for scaling
  const rowCounts = validPoints.map((p) => p.row_count);
  const minCount = Math.min(...rowCounts);
  const maxCount = Math.max(...rowCounts);
  const range = maxCount - minCount || 1;

  // Generate grid lines for y-axis
  const yGridLines = [];
  const step = Math.ceil(maxCount / 5);
  for (let i = 0; i <= maxCount; i += step) {
    yGridLines.push(i);
  }

  // Generate x-axis labels (dates)
  const xLabels = [];
  if (points.length > 0) {
    xLabels.push(new Date(points[0].checked_at));
    if (points.length > 1) {
      xLabels.push(new Date(points[Math.floor(points.length / 2)].checked_at));
      xLabels.push(new Date(points[points.length - 1].checked_at));
    }
  }

  // Build the SVG
  const innerWidth = CHART_WIDTH - PADDING * 2;
  const innerHeight = CHART_HEIGHT - PADDING * 2;

  const timeMin = Math.min(...points.map((p) => new Date(p.checked_at).getTime()));
  const timeMax = Math.max(...points.map((p) => new Date(p.checked_at).getTime()));
  const timeRange = timeMax - timeMin || 1;

  // Calculate coordinates for each point
  const coords = points.map((p) => {
    const t = new Date(p.checked_at).getTime();
    const x = PADDING + ((t - timeMin) / timeRange) * innerWidth;
    let y = CHART_HEIGHT - PADDING;
    if (p.row_count !== null) {
      y = CHART_HEIGHT - PADDING - ((p.row_count - minCount) / range) * innerHeight;
    }
    return { ...p, x, y };
  });

  // Path for line series
  const pathData = seriesPath(points, innerWidth, innerHeight);
  const pathD = pathData ? `M ${PADDING} ${CHART_HEIGHT - PADDING - ((validPoints[0].row_count - minCount) / range) * innerHeight} ${pathData.substring(1)}` : '';

  // Format date for x-axis label
  const formatDate = (date) => {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  return (
    <div className="ops-dataset-history">
      <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} className="ops-dataset-history-chart">
        {/* Grid lines */}
        {yGridLines.map((val) => {
          const y = CHART_HEIGHT - PADDING - ((val - minCount) / range) * innerHeight;
          return (
            <g key={`grid-${val}`}>
              <line x1={PADDING} y1={y} x2={CHART_WIDTH - PADDING} y2={y} stroke="var(--line2)" strokeWidth="0.5" />
              <text
                x={PADDING - 8}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill="var(--txt2)"
              >
                {val.toLocaleString()}
              </text>
            </g>
          );
        })}

        {/* X-axis labels */}
        {xLabels.map((date, idx) => {
          const t = date.getTime();
          const x = PADDING + ((t - timeMin) / timeRange) * innerWidth;
          return (
            <text
              key={`x-label-${idx}`}
              x={x}
              y={CHART_HEIGHT - 8}
              textAnchor="middle"
              fontSize="10"
              fill="var(--txt2)"
            >
              {formatDate(date)}
            </text>
          );
        })}

        {/* Line series */}
        {pathD && <polyline d={pathD} stroke="#e8c26a" strokeWidth="1.5" fill="none" />}

        {/* Error dots */}
        {coords.map((p, idx) => {
          if (!p.ok) {
            return (
              <circle
                key={`error-${idx}`}
                cx={p.x}
                cy={p.y}
                r="3"
                fill="var(--danger)"
                title={p.error || 'check failed'}
              />
            );
          }
          return null;
        })}
      </svg>
    </div>
  );
}
