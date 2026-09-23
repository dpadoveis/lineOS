import { describe, expect, it } from 'vitest';
import { MAX_TABS, initialPanel, panelReducer } from './panel.js';

const run = (actions, s = initialPanel()) => actions.reduce(panelReducer, s);

describe('panelReducer', () => {
  it('starts on the overview, with no tabs', () => {
    expect(initialPanel()).toEqual({ tabs: [], active: 'overview', layer: null, sort: { key: 'severity', dir: 'asc' },
      filters: { kinds: [], state: null, riskOnly: false, errorsOnly: false } });
  });
  it('a deep link starts with that node open and active', () => {
    expect(initialPanel('u1')).toMatchObject({ tabs: ['u1'], active: 'u1' });
  });
  it('opening a node adds a tab and activates it; opening it again only activates', () => {
    const s = run([{ type: 'open', uid: 'a' }, { type: 'open', uid: 'b' }, { type: 'open', uid: 'a' }]);
    expect(s.tabs).toEqual(['a', 'b']);
    expect(s.active).toBe('a');
  });
  it('closing the active tab activates its left neighbour, or the overview', () => {
    let s = run([{ type: 'open', uid: 'a' }, { type: 'open', uid: 'b' }, { type: 'close', uid: 'b' }]);
    expect(s).toMatchObject({ tabs: ['a'], active: 'a' });
    s = panelReducer(s, { type: 'close', uid: 'a' });
    expect(s).toMatchObject({ tabs: [], active: 'overview' });
  });
  it('closing an inactive tab keeps the active one', () => {
    const s = run([{ type: 'open', uid: 'a' }, { type: 'open', uid: 'b' }, { type: 'close', uid: 'a' }]);
    expect(s).toMatchObject({ tabs: ['b'], active: 'b' });
  });
  it('the overview cannot be closed', () => {
    const s = panelReducer(initialPanel(), { type: 'close', uid: 'overview' });
    expect(s.active).toBe('overview');
  });
  it('caps the tabs, closing the oldest inactive one', () => {
    const opens = Array.from({ length: MAX_TABS + 1 }, (_, i) => ({ type: 'open', uid: 'n' + i }));
    const s = run(opens);
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(s.tabs[0]).toBe('n1');
    expect(s.active).toBe('n' + MAX_TABS);
  });
  it('choosing a layer shows the overview filtered', () => {
    const s = run([{ type: 'open', uid: 'a' }, { type: 'layer', layer: 'silver' }]);
    expect(s).toMatchObject({ active: 'overview', layer: 'silver', tabs: ['a'] });
  });
  it('sorting the same key twice flips the direction; a new key starts ascending', () => {
    let s = run([{ type: 'sort', key: 'name' }]);
    expect(s.sort).toEqual({ key: 'name', dir: 'asc' });
    s = panelReducer(s, { type: 'sort', key: 'name' });
    expect(s.sort).toEqual({ key: 'name', dir: 'desc' });
    s = panelReducer(s, { type: 'sort', key: 'rows' });
    expect(s.sort).toEqual({ key: 'rows', dir: 'asc' });
  });
  it('activating an unknown tab falls back to the overview', () => {
    expect(panelReducer(initialPanel(), { type: 'activate', id: 'ghost' }).active).toBe('overview');
  });

  it('kind chips toggle, and any filter shows the overview', () => {
    let s = run([{ type: 'open', uid: 'a' }, { type: 'kind', kind: 'dag' }, { type: 'kind', kind: 'cron' }]);
    expect(s.filters.kinds).toEqual(['dag', 'cron']);
    expect(s.active).toBe('overview');
    s = panelReducer(s, { type: 'kind', kind: 'dag' });
    expect(s.filters.kinds).toEqual(['cron']);
  });
  it('state, at-risk and errors filters set and toggle; clear resets them and the layer', () => {
    let s = run([{ type: 'state', state: 'broken' }, { type: 'risk' }, { type: 'errors' }, { type: 'layer', layer: 'gold' }]);
    expect(s.filters).toEqual({ kinds: [], state: 'broken', riskOnly: true, errorsOnly: true });
    s = panelReducer(s, { type: 'risk' });
    expect(s.filters.riskOnly).toBe(false);
    s = panelReducer(s, { type: 'clear' });
    expect(s.filters).toEqual({ kinds: [], state: null, riskOnly: false, errorsOnly: false });
    expect(s.layer).toBe(null);
  });
});
