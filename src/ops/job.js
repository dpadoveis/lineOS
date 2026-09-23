// Job-specific formatting and analysis functions.

export function scheduleText(schedule) {
  if (!schedule || schedule === '') return 'manual';
  if (schedule === 'Dataset') return 'triggered by a dataset';

  // Parse cron expressions: min hour day month dow
  const parts = schedule.split(/\s+/);
  if (parts.length !== 5) return schedule;

  const [min, hour, day, month, dow] = parts;

  // Check for specific patterns
  if (min.startsWith('*/') && hour === '*' && day === '*' && month === '*' && dow === '*') {
    const interval = parseInt(min.slice(2), 10);
    if (!Number.isNaN(interval)) return `every ${interval} minutes`;
  }

  if (hour === '*' && day === '*' && month === '*' && dow === '*') {
    const minute = parseInt(min, 10);
    if (!Number.isNaN(minute)) return `every hour at :${String(minute).padStart(2, '0')}`;
  }

  if (hour !== '*' && day === '*' && month === '*' && dow === '*') {
    const minute = parseInt(min, 10);
    const hourNum = parseInt(hour, 10);
    if (!Number.isNaN(minute) && !Number.isNaN(hourNum)) {
      return `every day at ${String(hourNum).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }

  if (hour !== '*' && day === '*' && month === '*' && dow !== '*') {
    const minute = parseInt(min, 10);
    const hourNum = parseInt(hour, 10);
    const dayNum = parseInt(dow, 10);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    if (!Number.isNaN(minute) && !Number.isNaN(hourNum) && dayNum >= 0 && dayNum <= 6) {
      return `every ${days[dayNum]} at ${String(hourNum).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }

  return schedule;
}

export function isUnusual(lastRun, medianMs) {
  if (!lastRun || medianMs === null || medianMs === undefined) return false;
  const duration = lastRun.duration_ms;
  if (duration === null || duration === undefined) return false;
  return duration > 2 * medianMs && duration - medianMs >= 60000;
}

export function durationBars(runs, width, height) {
  if (!runs || runs.length === 0) return [];

  // Sort by started_at to arrange oldest left
  const sorted = [...runs].sort((a, b) => {
    const aTime = a.started_at ? new Date(a.started_at).getTime() : 0;
    const bTime = b.started_at ? new Date(b.started_at).getTime() : 0;
    return aTime - bTime;
  });

  const maxDuration = Math.max(...sorted.map((r) => r.duration_ms || 0));
  if (maxDuration === 0) {
    // All runs have 0 or null duration; use a default height for visibility
    return sorted.map((r, i) => ({
      x: (i / sorted.length) * width,
      y: height - 4,
      w: width / sorted.length - 2,
      h: 4,
      outcome: r.outcome,
    }));
  }

  const barWidth = width / sorted.length;
  return sorted.map((r, i) => {
    const duration = r.duration_ms || 0;
    const barHeight = (duration / maxDuration) * height;
    return {
      x: i * barWidth + 1,
      y: height - barHeight,
      w: barWidth - 2,
      h: barHeight,
      outcome: r.outcome,
    };
  });
}
