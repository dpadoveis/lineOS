// The bottom panel's state: which node tabs are open, which tab is active,
// the Overview's layer filter and its table sort. Pure, so it is tested
// without a DOM (spec §2).
export const MAX_TABS = 8;
export const NO_FILTERS = { kinds: [], state: null, riskOnly: false, errorsOnly: false };

export function initialPanel(uid = null) {
  return {
    tabs: uid ? [uid] : [],
    active: uid || 'overview',
    layer: null,
    sort: { key: 'severity', dir: 'asc' },
    filters: { ...NO_FILTERS }
  };
}

export function panelReducer(state, action) {
  switch (action.type) {
    case 'open': {
      if (state.tabs.includes(action.uid)) return { ...state, active: action.uid };
      let tabs = [...state.tabs, action.uid];
      while (tabs.length > MAX_TABS) {
        const oldest = tabs.find((t) => t !== action.uid && t !== state.active) || tabs[0];
        tabs = tabs.filter((t) => t !== oldest);
      }
      return { ...state, tabs, active: action.uid };
    }
    case 'activate': {
      const ok = action.id === 'overview' || state.tabs.includes(action.id);
      return { ...state, active: ok ? action.id : 'overview' };
    }
    case 'close': {
      const i = state.tabs.indexOf(action.uid);
      if (i < 0) return state;
      const tabs = state.tabs.filter((t) => t !== action.uid);
      const active = state.active !== action.uid ? state.active : tabs[i - 1] || tabs[i] || 'overview';
      return { ...state, tabs, active };
    }
    case 'layer':
      return { ...state, layer: action.layer, active: 'overview' };
    case 'sort': {
      const same = state.sort.key === action.key;
      return { ...state, sort: { key: action.key, dir: same && state.sort.dir === 'asc' ? 'desc' : 'asc' } };
    }
    case 'kind': {
      const kinds = state.filters.kinds.includes(action.kind)
        ? state.filters.kinds.filter((k) => k !== action.kind)
        : [...state.filters.kinds, action.kind];
      return { ...state, active: 'overview', filters: { ...state.filters, kinds } };
    }
    case 'state':
      return { ...state, active: 'overview', filters: { ...state.filters, state: action.state || null } };
    case 'risk':
      return { ...state, active: 'overview', filters: { ...state.filters, riskOnly: !state.filters.riskOnly } };
    case 'errors':
      return { ...state, active: 'overview', filters: { ...state.filters, errorsOnly: !state.filters.errorsOnly } };
    case 'clear':
      return { ...state, layer: null, filters: { ...NO_FILTERS } };
    default:
      return state;
  }
}
