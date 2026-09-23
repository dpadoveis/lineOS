import { describe, it, expect } from 'vitest';
import { filterParams, distinctText, pct, seriesPath } from './dataset.js';

describe('dataset.js', () => {
  describe('filterParams', () => {
    it('converts complete filters to string array', () => {
      const filters = [
        { column: 'name', op: 'contains', value: 'foo' },
        { column: 'age', op: 'gt', value: '25' },
      ];
      const result = filterParams(filters);
      expect(result).toEqual(['name:contains:foo', 'age:gt:25']);
    });

    it('handles null and notnull without values', () => {
      const filters = [
        { column: 'name', op: 'null', value: null },
        { column: 'id', op: 'notnull', value: undefined },
      ];
      const result = filterParams(filters);
      expect(result).toEqual(['name:null', 'id:notnull']);
    });

    it('drops incomplete filters (missing column, op, or value when needed)', () => {
      const filters = [
        { column: 'name', op: 'eq', value: 'foo' },
        { column: '', op: 'eq', value: 'bar' },
        { column: 'age', op: '', value: '25' },
        { column: 'city', op: 'contains', value: null },
        { column: 'status', op: 'null', value: null },
      ];
      const result = filterParams(filters);
      expect(result).toEqual(['name:eq:foo', 'status:null']);
    });

    it('leaves values raw: URLSearchParams in api.js encodes them once', () => {
      const filters = [
        { column: 'name', op: 'contains', value: 'hello world' },
        { column: 'tag', op: 'eq', value: '50%_off' },
      ];
      const result = filterParams(filters);
      expect(result).toEqual(['name:contains:hello world', 'tag:eq:50%_off']);
      // Encoded exactly once on the wire, so the server decodes back to 50%_off.
      const q = new URLSearchParams();
      result.forEach((f) => q.append('f', f));
      expect(new URLSearchParams(q.toString()).getAll('f')).toEqual(result);
    });

    it('drops a row whose value is still empty', () => {
      expect(filterParams([{ column: 'name', op: 'eq', value: '' }])).toEqual([]);
    });
  });

  describe('pct', () => {
    it('converts fraction to percentage string', () => {
      expect(pct(0.5)).toBe('50.0%');
      expect(pct(0.125)).toBe('12.5%');
      expect(pct(1)).toBe('100.0%');
      expect(pct(0)).toBe('0.0%');
    });

    it('handles very small fractions', () => {
      expect(pct(0.001)).toBe('0.1%');
    });
  });

  describe('distinctText', () => {
    it('formats non-negative n_distinct with ~ prefix', () => {
      expect(distinctText(10, 100)).toBe('~10');
      expect(distinctText(0, 100)).toBe('~0');
      expect(distinctText(42, 100)).toBe('~42');
    });

    it('formats negative n_distinct as fraction of rows', () => {
      expect(distinctText(-0.5, 100)).toBe('~50.0% of rows');
      expect(distinctText(-1, 100)).toBe('~100.0% of rows');
      expect(distinctText(-0.25, 100)).toBe('~25.0% of rows');
    });

    it('formats negative n_distinct without rowCount', () => {
      expect(distinctText(-0.5, null)).toBe('~50.0% of rows');
      expect(distinctText(-0.5, undefined)).toBe('~50.0% of rows');
    });

    it('appends ~count when rowCount is known', () => {
      expect(distinctText(10, 100)).toBe('~10');
      expect(distinctText(0.5, 100)).toBe('~0.5');
    });

    it('returns em-dash for null n_distinct', () => {
      expect(distinctText(null, 100)).toBe('—');
      expect(distinctText(undefined, 100)).toBe('—');
    });
  });

  describe('seriesPath', () => {
    it('returns empty string for fewer than 2 points', () => {
      expect(seriesPath([], 100, 100)).toBe('');
      expect(seriesPath([{ checked_at: '2024-01-01T00:00:00Z', row_count: 100, ok: true }], 100, 100)).toBe('');
    });

    it('generates SVG path for two or more points', () => {
      const points = [
        { checked_at: '2024-01-01T00:00:00Z', row_count: 100, ok: true },
        { checked_at: '2024-01-02T00:00:00Z', row_count: 120, ok: true },
      ];
      const path = seriesPath(points, 100, 100);
      expect(path).toBeTruthy();
      expect(path).toMatch(/^M\s+[\d.]+\s+[\d.]+/);
    });

    it('skips points with null row_count', () => {
      const points = [
        { checked_at: '2024-01-01T00:00:00Z', row_count: 100, ok: true },
        { checked_at: '2024-01-02T00:00:00Z', row_count: null, ok: false },
        { checked_at: '2024-01-03T00:00:00Z', row_count: 120, ok: true },
      ];
      const path = seriesPath(points, 100, 100);
      expect(path).toBeTruthy();
      // Should have moved from point 1 directly to point 3
      expect(path).toContain('M');
    });

    it('handles flat series (all same row_count)', () => {
      const points = [
        { checked_at: '2024-01-01T00:00:00Z', row_count: 100, ok: true },
        { checked_at: '2024-01-02T00:00:00Z', row_count: 100, ok: true },
        { checked_at: '2024-01-03T00:00:00Z', row_count: 100, ok: true },
      ];
      const path = seriesPath(points, 100, 100);
      expect(path).toBeTruthy();
      // Should still produce a valid path
      expect(path).toMatch(/^M/);
    });

    it('scales correctly within bounds', () => {
      const points = [
        { checked_at: '2024-01-01T00:00:00Z', row_count: 0, ok: true },
        { checked_at: '2024-01-02T00:00:00Z', row_count: 100, ok: true },
      ];
      const path = seriesPath(points, 200, 100);
      expect(path).toBeTruthy();
      // Path should use coordinates within the bounds
      expect(path).toMatch(/M\s+[\d.]+\s+[\d.]+.*L\s+[\d.]+\s+[\d.]+/);
    });
  });
});
