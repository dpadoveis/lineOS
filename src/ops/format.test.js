import { describe, expect, it } from 'vitest';
import { ageText, durationText, freshnessLine, rowsText, since } from './format.js';

const NOW = Date.parse('2026-09-22T12:00:00Z');

describe('ageText', () => {
  it('says never when nothing was collected, not 0 s', () => {
    expect(ageText(null)).toBe('never');
    expect(ageText(undefined)).toBe('never');
  });
  it('scales the unit', () => {
    expect(ageText(42)).toBe('42 s ago');
    expect(ageText(3 * 60)).toBe('3 min ago');
    expect(ageText(3 * 3600)).toBe('3 h ago');
    expect(ageText(3 * 86400)).toBe('3 d ago');
  });
});

describe('since / durationText / rowsText', () => {
  it('measures from the injected clock', () => {
    expect(since('2026-09-22T09:00:00Z', NOW)).toBe('3 h ago');
    expect(since('2026-09-22T09:00:00+00:00', NOW)).toBe('3 h ago');
    expect(since(null, NOW)).toBe(null);
  });
  it('formats durations and counts', () => {
    expect(durationText(42000)).toBe('42 s');
    expect(durationText(125000)).toBe('2 min 5 s');
    expect(durationText(null)).toBe(null);
    expect(rowsText(19456)).toBe('19,456 rows');
    expect(rowsText(null)).toBe(null);
  });
});

describe('freshnessLine', () => {
  it('uses the last run for jobs', () => {
    const n = { kind: 'dag', lastRun: { started_at: '2026-09-22T09:00:00Z', duration_ms: 42000 }, lastCheck: null };
    expect(freshnessLine(n, NOW)).toBe('last run 3 h ago · 42 s');
  });
  it('uses the last check for datasets', () => {
    const n = { kind: 'dataset', lastRun: null,
      lastCheck: { row_count: 19456, max_ts: '2026-09-22T11:10:00Z', checked_at: '2026-09-22T11:57:00Z' } };
    expect(freshnessLine(n, NOW)).toBe('19,456 rows · max 50 min ago');
  });
  it('is honest when there is nothing', () => {
    expect(freshnessLine({ kind: 'cron', lastRun: null, lastCheck: null }, NOW)).toBe('nothing collected yet');
    expect(freshnessLine({ kind: 'unbound', lastRun: null, lastCheck: null }, NOW)).toBe('not bound');
  });
});
