import { useEffect, useRef, useState } from 'react';
import KindIcon from '../canvas/KindIcon.jsx';
import OverviewTab from './OverviewTab.jsx';
import NodeTab from './NodeTab.jsx';
import './panel.css';

export default function BottomPanel({ view, layers, risk, query, onQuery, onSubmitQuery, panel, dispatch, slug, onSelect }) {
  const [state, setState] = useState(() => {
    try {
      const stored = localStorage.getItem('ops-panel.v2');
      return stored ? JSON.parse(stored) : { h: 0.5, collapsed: false };
    } catch {
      return { h: 0.5, collapsed: false };
    }
  });

  const containerRef = useRef(null);
  const startRef = useRef(null);

  const saveState = (newState) => {
    setState(newState);
    try {
      localStorage.setItem('ops-panel.v2', JSON.stringify(newState));
    } catch {
      // Ignore storage errors
    }
  };

  const handleMouseDown = (e) => {
    startRef.current = { y: e.clientY, h: state.h };
    const handleMouseMove = (e) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.parentElement.getBoundingClientRect();
      const pageHeight = rect.height;
      const dragDelta = e.clientY - startRef.current.y;
      const minH = 160 / pageHeight;
      const maxH = 0.7;
      const newH = Math.max(minH, Math.min(maxH, startRef.current.h - dragDelta / pageHeight));
      setState((s) => ({ ...s, h: newH }));
    };
    const handleMouseUp = () => {
      saveState(state);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const toggleCollapse = () => {
    saveState({ ...state, collapsed: !state.collapsed });
  };

  const activeNode = panel.active === 'overview' ? null : view.nodes.find((n) => n.uid === panel.active);
  const height = state.collapsed ? 36 : `${Math.round(state.h * 100)}%`;

  return (
    <div className="ops-panel" ref={containerRef} style={{ height }} data-testid="ops-panel">
      <div className="ops-panel-handle" onMouseDown={handleMouseDown} />
      <div className="ops-tab-strip" role="tablist">
        <button
          role="tab"
          aria-selected={panel.active === 'overview'}
          onClick={() => dispatch({ type: 'activate', id: 'overview' })}
          className={`ops-tab ${panel.active === 'overview' ? 'ops-tab--active' : ''}`}
          data-testid="ops-tab"
          data-id="overview"
        >
          Overview
        </button>
        {panel.tabs.map((uid) => {
          const node = view.nodes.find((n) => n.uid === uid);
          return (
            <button
              key={uid}
              role="tab"
              aria-selected={panel.active === uid}
              onClick={() => dispatch({ type: 'activate', id: uid })}
              className={`ops-tab ${panel.active === uid ? 'ops-tab--active' : ''}`}
              data-testid="ops-tab"
              data-id={uid}
            >
              {node ? (
                <>
                  <KindIcon kind={node.kind} size={16} />
                  <span className="ops-tab-label">{node.label}</span>
                  <span className={`ops-dot ops-dot--${node.state}`} />
                  <button
                    type="button"
                    className="ops-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch({ type: 'close', uid });
                    }}
                    aria-label={`Close ${node.label}`}
                  >
                    ×
                  </button>
                </>
              ) : (
                <>
                  <span className="ops-tab-label">{uid}</span>
                  <button
                    type="button"
                    className="ops-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch({ type: 'close', uid });
                    }}
                    aria-label={`Close ${uid}`}
                  >
                    ×
                  </button>
                </>
              )}
            </button>
          );
        })}
        <div className="ops-tab-spacer" />
        <button
          type="button"
          className="ops-collapse-btn"
          onClick={toggleCollapse}
          aria-label={state.collapsed ? 'Expand' : 'Collapse'}
        >
          {state.collapsed ? '▴' : '▾'}
        </button>
      </div>
      {!state.collapsed && (
        <div className="ops-panel-body">
          {panel.active === 'overview' ? (
            <OverviewTab view={view} layers={layers} risk={risk} query={query} onQuery={onQuery} onSubmitQuery={onSubmitQuery} panel={panel} dispatch={dispatch} onSelect={onSelect} />
          ) : activeNode ? (
            <NodeTab node={activeNode} view={view} layers={layers} risk={risk} panel={panel} dispatch={dispatch} slug={slug} onSelect={onSelect} />
          ) : (
            <div className="ops-panel-empty">This node is no longer in the pipeline.</div>
          )}
        </div>
      )}
    </div>
  );
}
