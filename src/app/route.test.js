import { describe, expect, it } from 'vitest';
import { parseHash, pipelineHash } from './route.js';

describe('pipeline routes', () => {
  it('parses a pipeline without a node', () => {
    expect(parseHash('#/pipelines/sample-lineage')).toEqual({ view: 'pipeline', slug: 'sample-lineage', uid: null });
  });
  it('parses the canonical lineage prefix like the old one', () => {
    expect(parseHash('#/lineage/sample-lineage')).toEqual({ view: 'pipeline', slug: 'sample-lineage', uid: null });
    expect(parseHash('#/lineage/mapa/node/u-1')).toEqual({ view: 'pipeline', slug: 'mapa', uid: 'u-1' });
  });
  it('parses a deep link to a node', () => {
    expect(parseHash('#/pipelines/mapa/node/u-1%2F2')).toEqual({ view: 'pipeline', slug: 'mapa', uid: 'u-1/2' });
  });
  it('builds the same hashes back', () => {
    expect(pipelineHash('mapa', null)).toBe('#/lineage/mapa');
    expect(pipelineHash('mapa', 'u-1/2')).toBe('#/lineage/mapa/node/u-1%2F2');
  });
  it('leaves the other routes alone', () => {
    expect(parseHash('#/lineage')).toEqual({ view: 'home', viewProp: 'lineage' });
    expect(parseHash('#/pipelines')).toEqual({ view: 'home', viewProp: 'lineage' });
    expect(parseHash('#/flow/x')).toEqual({ view: 'editor', flowRef: 'x' });
  });
  it('parses a lineage share link', () => {
    expect(parseHash('#/share/abc123/lineage/mapa')).toEqual({
      view: 'share',
      token: 'abc123',
      lineageSlug: 'mapa'
    });
  });
  it('parses a lineage share link with special characters', () => {
    expect(parseHash('#/share/abc%2B123/lineage/mapa%2Fops')).toEqual({
      view: 'share',
      token: 'abc+123',
      lineageSlug: 'mapa/ops'
    });
  });
  it('leaves plain share links unchanged', () => {
    expect(parseHash('#/share/abc123')).toEqual({ view: 'share', token: 'abc123' });
  });
});
