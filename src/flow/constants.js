export const NODE_WIDTH = 232;
// Limits for resizing a node by hand (dragging the handle in the bottom-right
// corner). The default width is NODE_WIDTH; the default height is the
// content's, and only becomes explicit once the user drags. The minimum height
// is the header (52) plus the footer (37) plus a strip of body: below that the
// footer would escape the card's edge.
export const NODE_MIN_WIDTH = 168;
export const NODE_MAX_WIDTH = 720;
export const NODE_MIN_HEIGHT = 120;
export const NODE_MAX_HEIGHT = 900;
export const ACCENT = '#e8c26a';
export const EDGE_STYLE = 'curve'; // 'curve' | 'straight'
export const SNAP_TO_GRID = true;

// Metadata panel: it hangs BELOW the node card as a dropdown, so it is not part
// of the node height (which drives edge clipping and the automatic layout).
// These numbers mirror .fe-meta-drop in FlowEditor.css and are what the PNG
// export uses to draw the same panel on the canvas.
export const META_GAP = 6;
export const META_HEAD_HEIGHT = 22;
export const META_ROW_HEIGHT = 26;

// ── Groups ───────────────────────────────────────────────────────────
// A group is a box drawn BEHIND the nodes, and it owns no list of members:
// whichever nodes rest inside its rectangle belong to it (reconcileGroups() in
// geometry.js decides). That is what makes dragging a node out of the box
// leave the group without anything to update by hand.
export const GROUP_MIN_WIDTH = 160;
export const GROUP_MIN_HEIGHT = 120;
export const GROUP_MAX_WIDTH = 6000;
export const GROUP_MAX_HEIGHT = 6000;
// A brand new (empty) box, from the plane's context menu.
export const GROUP_NEW_WIDTH = 384;
export const GROUP_NEW_HEIGHT = 264;
// Space left around the nodes when the box is drawn around a selection, plus
// the strip at the top that the title bar occupies.
export const GROUP_PAD = 32;
export const GROUP_HEAD = 34;
export const GROUP_COLOR = '#6fb8d3';
// The palette offered in the group's header. The same hues as the tool
// catalog, so a plane full of boxes still reads as one drawing.
export const GROUP_COLORS = [
  '#6fb8d3', '#7dd3a0', '#6fd3c7', '#e8c26a',
  '#e8956a', '#e0708a', '#a78bd8', '#9aa4b0'
];

// How many undo steps are kept. Each step is a shallow snapshot of nodes/edges
// (the arrays are frozen by copy-on-write in the reducer), so the cost is one
// pair of array references per step.
export const HISTORY_LIMIT = 100;

export const TOOLS = [
  { n: 'Airflow', c: 'ORCHESTRATION', k: 'AF', col: '#7dd3a0', tags: 'dag scheduler apache orchestration' },
  { n: 'Dagster', c: 'ORCHESTRATION', k: 'DG', col: '#7dd3a0', tags: 'asset pipeline orchestration' },
  { n: 'Prefect', c: 'ORCHESTRATION', k: 'PF', col: '#7dd3a0', tags: 'flow orchestration' },
  { n: 'dbt', c: 'TRANSFORMATION', k: 'DBT', col: '#e8956a', tags: 'sql model transformation' },
  { n: 'Spark', c: 'PROCESSING', k: 'SP', col: '#e8956a', tags: 'batch cluster processing' },
  { n: 'Kafka', c: 'STREAM', k: 'KF', col: '#a78bd8', tags: 'stream topic event queue' },
  { n: 'Flink', c: 'STREAM', k: 'FL', col: '#a78bd8', tags: 'stream real time' },
  { n: 'Fivetran', c: 'INGESTION', k: 'FT', col: '#6fb8d3', tags: 'elt connector ingestion' },
  { n: 'Webhook', c: 'INGESTION', k: 'WH', col: '#6fb8d3', tags: 'http trigger ingestion api' },
  { n: 'Snowflake', c: 'STORAGE', k: 'SN', col: '#6fd3c7', tags: 'warehouse sql storage' },
  { n: 'BigQuery', c: 'STORAGE', k: 'BQ', col: '#6fd3c7', tags: 'warehouse sql storage' },
  { n: 'PostgreSQL', c: 'DATABASE', k: 'PG', col: '#6fd3c7', tags: 'sql relational database' },
  { n: 'S3', c: 'STORAGE', k: 'S3', col: '#6fd3c7', tags: 'object lake storage' },
  { n: 'Redis', c: 'CACHE', k: 'RD', col: '#e0708a', tags: 'cache memory key' },
  { n: 'Great Expectations', c: 'QUALITY', k: 'GE', col: '#e8c26a', tags: 'test validation quality' },
  { n: 'Looker', c: 'VISUALIZATION', k: 'LK', col: '#c9a0dc', tags: 'bi dashboard visualization' },
  { n: 'Metabase', c: 'VISUALIZATION', k: 'MB', col: '#c9a0dc', tags: 'bi dashboard visualization' },
  { n: 'Script Python', c: 'CUSTOM', k: 'PY', col: '#9aa4b0', tags: 'code custom script' }
];
