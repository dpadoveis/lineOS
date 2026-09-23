// Ages, durations and counts as the ops screen prints them. `now` is injected
// so the tests do not depend on the clock.

export function ageText(seconds) {
  if (seconds === null || seconds === undefined) return 'never';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function since(iso, now = Date.now()) {
  if (!iso) return null;
  return ageText(Math.max(0, Math.round((now - Date.parse(iso)) / 1000)));
}

export function durationText(ms) {
  if (ms === null || ms === undefined) return null;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function rowsText(n) {
  return n === null || n === undefined ? null : `${n.toLocaleString('en-US')} rows`;
}

// The one line of freshness under a card: the last check for a table, the last
// run for a job.
export function freshnessLine(node, now = Date.now()) {
  if (node.kind === 'dataset' && node.lastCheck) {
    const c = node.lastCheck;
    return [rowsText(c.row_count), c.max_ts ? 'max ' + since(c.max_ts, now) : null]
      .filter(Boolean)
      .join(' · ');
  }
  if (node.lastRun) {
    return ['last run ' + since(node.lastRun.started_at, now), durationText(node.lastRun.duration_ms)]
      .filter(Boolean)
      .join(' · ');
  }
  return node.kind === 'unbound' ? 'not bound' : 'nothing collected yet';
}
