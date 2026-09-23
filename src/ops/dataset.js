// Pure functions for dataset preview, schema, stats and history.
// No dependencies on React or the app state.

export function filterParams(filters) {
  return filters
    .filter((f) => f.column && f.op && (f.op === 'null' || f.op === 'notnull' || (f.value != null && f.value !== '')))
    // Raw values: readPreview puts these through URLSearchParams, which encodes
    // them once. Encoding here too sent "50%25_off" to the server.
    .map((f) => (f.op === 'null' || f.op === 'notnull' ? `${f.column}:${f.op}` : `${f.column}:${f.op}:${f.value}`));
}

export function pct(frac) {
  return `${(frac * 100).toFixed(1)}%`;
}

export function distinctText(n_distinct, rowCount) {
  if (n_distinct === null || n_distinct === undefined) return '—';
  if (n_distinct >= 0) {
    return `~${n_distinct}`;
  }
  // n_distinct < 0 means it's a fraction
  return `~${pct(Math.abs(n_distinct))} of rows`;
}

export function seriesPath(points, width, height) {
  // Filter points with non-null row_count
  const validPoints = points.filter((p) => p.row_count !== null && p.row_count !== undefined);
  if (validPoints.length < 2) return '';

  // Find min and max row_count for scaling
  const rowCounts = validPoints.map((p) => p.row_count);
  const minCount = Math.min(...rowCounts);
  const maxCount = Math.max(...rowCounts);
  const range = maxCount - minCount || 1; // Avoid division by zero

  // Parse dates and sort (should already be sorted, but ensure it)
  const sortedPoints = validPoints
    .map((p, i) => ({
      ...p,
      date: new Date(p.checked_at).getTime(),
      index: i,
    }))
    .sort((a, b) => a.date - b.date);

  const timeMin = sortedPoints[0].date;
  const timeMax = sortedPoints[sortedPoints.length - 1].date;
  const timeRange = timeMax - timeMin || 1;

  // Build SVG path
  const coords = sortedPoints.map((p) => {
    const x = ((p.date - timeMin) / timeRange) * width;
    const y = height - ((p.row_count - minCount) / range) * height;
    return { x, y };
  });

  // Create path using M (move) and L (line) commands
  let path = `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`;
  for (let i = 1; i < coords.length; i++) {
    path += ` L ${coords[i].x.toFixed(1)} ${coords[i].y.toFixed(1)}`;
  }

  return path;
}
