// Smoke renders of the lineage screen's parts, against the synthetic sample
// payload (e2e/fixtures/sample-lineage.json). The unit tests cover the logic;
// these catch what only rendering does -- a variable read before its declaration blanked the whole screen once
// (a ReferenceError at render) with every other test green.
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import fixture from '../../e2e/fixtures/sample-lineage.json';
import { toPipelineView, layersOf } from './view.js';
import { atRisk } from './lineage.js';
import { initialPanel } from './panel.js';
import PipelineHeader from './PipelineHeader.jsx';
import BottomPanel from './panel/BottomPanel.jsx';

const noop = () => {};
const view = toPipelineView({ ...fixture, pending_edges: 15 });
const layers = layersOf(view);
const risk = atRisk(view);
const first = (kind) => view.nodes.find((n) => n.kind === kind);

const panelFor = (uid) => (uid ? initialPanel(uid) : initialPanel());
const bottom = (uid) =>
  renderToString(h(BottomPanel, { view, layers, risk, query: '', onQuery: noop, onSubmitQuery: noop,
    panel: panelFor(uid), dispatch: noop, slug: fixture.slug, onSelect: noop }));

describe('lineage screen renders', () => {
  it('the bar, with the sync button when edges are pending', () => {
    const html = renderToString(h(PipelineHeader, { view, filter: null, onFilter: noop, refreshError: null,
      riskCount: risk.size, smtpReady: false, slug: fixture.slug, onReload: noop }));
    expect(html).toContain('DATA LINEAGE');
    expect(html).toContain('Sync edges (15)');
  });
  it('the bar, with a refresh error', () => {
    const html = renderToString(h(PipelineHeader, { view, filter: 'ok', onFilter: noop, refreshError: 'boom',
      riskCount: 0, smtpReady: false, slug: fixture.slug, onReload: noop }));
    expect(html).toContain('ops-bar');
  });
  it('the overview tab', () => {
    expect(bottom(null)).toContain('ops-panel');
  });
  it('a dataset tab', () => {
    const n = first('dataset');
    expect(n).toBeTruthy();
    expect(bottom(n.uid)).toContain(n.label);
  });
  it('a DAG tab and a cron tab', () => {
    for (const kind of ['dag', 'cron']) {
      const n = first(kind);
      if (n) expect(bottom(n.uid)).toContain(n.label);
    }
  });
});
