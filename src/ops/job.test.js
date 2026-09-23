import { describe, expect, it } from 'vitest';
import { scheduleText, isUnusual, durationBars } from './job.js';

describe('scheduleText', () => {
  it('converts cron patterns to human-readable text', () => {
    expect(scheduleText('*/5 * * * *')).toBe('every 5 minutes');
    expect(scheduleText('0 * * * *')).toBe('every hour at :00');
    expect(scheduleText('15 * * * *')).toBe('every hour at :15');
    expect(scheduleText('0 1 * * *')).toBe('every day at 01:00');
    expect(scheduleText('30 2 * * 1')).toBe('every Monday at 02:30');
  });

  it('handles Dataset trigger', () => {
    expect(scheduleText('Dataset')).toBe('triggered by a dataset');
  });

  it('handles null, empty string, and manual schedules', () => {
    expect(scheduleText(null)).toBe('manual');
    expect(scheduleText('')).toBe('manual');
  });

  it('returns raw expression for unrecognized patterns', () => {
    expect(scheduleText('0 0 1 * *')).toBe('0 0 1 * *');
    expect(scheduleText('something')).toBe('something');
  });
});

describe('isUnusual', () => {
  it('returns false when lastRun is null', () => {
    expect(isUnusual(null, 5000)).toBe(false);
  });

  it('returns false when medianMs is null', () => {
    expect(isUnusual({ duration_ms: 10000 }, null)).toBe(false);
  });

  it('returns false when both known but duration not 2x median and difference < 60s', () => {
    expect(isUnusual({ duration_ms: 10000 }, 6000)).toBe(false);
    expect(isUnusual({ duration_ms: 12000 }, 10000)).toBe(false);
  });

  it('returns false when 2x median but difference < 60s', () => {
    expect(isUnusual({ duration_ms: 100000 }, 55000)).toBe(false);
  });

  it('returns true when both 2x median and difference >= 60s', () => {
    expect(isUnusual({ duration_ms: 130000 }, 50000)).toBe(true);
  });

  it('returns true for very large differences', () => {
    expect(isUnusual({ duration_ms: 300000 }, 10000)).toBe(true);
  });
});

describe('durationBars', () => {
  it('returns empty array for no runs', () => {
    expect(durationBars([], 300, 40)).toEqual([]);
    expect(durationBars(null, 300, 40)).toEqual([]);
  });

  it('returns bar chart data with single run', () => {
    const runs = [{ duration_ms: 5000, outcome: 'success' }];
    const bars = durationBars(runs, 300, 40);
    expect(bars).toHaveLength(1);
    expect(bars[0]).toHaveProperty('x');
    expect(bars[0]).toHaveProperty('y');
    expect(bars[0]).toHaveProperty('w');
    expect(bars[0]).toHaveProperty('h');
    expect(bars[0]).toHaveProperty('outcome', 'success');
  });

  it('scales bars proportionally to max duration', () => {
    const runs = [
      { duration_ms: 1000, outcome: 'success' },
      { duration_ms: 5000, outcome: 'failed' },
    ];
    const bars = durationBars(runs, 300, 40);
    expect(bars).toHaveLength(2);
    expect(bars[0].h).toBeLessThan(bars[1].h);
  });

  it('arranges bars oldest left', () => {
    const runs = [
      { duration_ms: 1000, outcome: 'success', started_at: '2026-09-20T00:00:00Z' },
      { duration_ms: 2000, outcome: 'running', started_at: '2026-09-21T00:00:00Z' },
      { duration_ms: 3000, outcome: 'skipped', started_at: '2026-09-22T00:00:00Z' },
    ];
    const bars = durationBars(runs, 300, 40);
    expect(bars).toHaveLength(3);
    expect(bars[0].x).toBeLessThan(bars[1].x);
    expect(bars[1].x).toBeLessThan(bars[2].x);
  });

  it('preserves outcome for each bar', () => {
    const runs = [
      { duration_ms: 1000, outcome: 'success' },
      { duration_ms: 2000, outcome: 'failed' },
      { duration_ms: 1500, outcome: 'running' },
      { duration_ms: 1200, outcome: 'skipped' },
    ];
    const bars = durationBars(runs, 300, 40);
    expect(bars.map((b) => b.outcome)).toEqual(['success', 'failed', 'running', 'skipped']);
  });
});
