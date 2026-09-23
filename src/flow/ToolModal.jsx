import { useEffect, useRef, useState } from 'react';
import { TOOLS } from './constants.js';
import { readToolIcon } from './toolIcon.js';

// Centered modal for registering a tool the built-in catalog does not have,
// and for editing one already registered. Everything but the name is optional;
// the icon image is optional too, and a tool without one falls back to its
// initials, like the built-in entries.
//
// Editing reuses this form instead of a second one: the fields are the same,
// and what the edit mode adds is the dropdown saying WHICH tool is on the
// table, plus the danger zone at the bottom.
//
// Built-in tools are in that dropdown too. They live in the source, not on the
// server, so editing one materialises a row that stands for it (the hook sends
// `builtin`), and from then on the sidebar serves the row.

// Category is a dropdown, not free text: the same layer typed three different
// ways ("STREAM", "Streaming", "stream") would split the catalog for no reason.
// The list is the one the built-in catalog already uses, plus the categories
// the user's own tools introduced, and "Other…" keeps the door open for a name
// nobody thought of.
const OTHER = '__other__';

function categoryList(customTools) {
  const seen = [];
  TOOLS.forEach((t) => {
    if (seen.indexOf(t.c) === -1) seen.push(t.c);
  });
  (customTools || []).forEach((t) => {
    const c = (t.c || '').toUpperCase();
    if (c && seen.indexOf(c) === -1) seen.push(c);
  });
  return seen.sort();
}

const COLORS = [
  '#7dd3a0',
  '#e8956a',
  '#a78bd8',
  '#6fb8d3',
  '#6fd3c7',
  '#e0708a',
  '#e8c26a',
  '#c9a0dc',
  '#9aa4b0'
];

function initialsFrom(name) {
  const words = String(name || '')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// A built-in has no id, so the dropdown is keyed by name for those.
const keyOf = (t) => (t.custom ? 'c' + t.id : 'b' + t.n);

export default function ToolModal({
  mode,
  saving,
  error,
  usage,
  onCancel,
  onCreate,
  onUpdate,
  onUsage,
  onDelete,
  catalog
}) {
  const editing = mode === 'edit';
  const categories = categoryList(catalog);
  // Every tool is editable, registered or built-in.
  const editable = catalog || [];
  const [sel, setSel] = useState(editable.length ? keyOf(editable[0]) : null);
  const selected = editable.find((t) => keyOf(t) === sel) || null;
  const [name, setName] = useState('');
  const [category, setCategory] = useState('CUSTOM');
  // Only shows when the chosen category is "Other…".
  const [customCategory, setCustomCategory] = useState('');
  const [initials, setInitials] = useState('');
  const [initialsTouched, setInitialsTouched] = useState(false);
  const [color, setColor] = useState(COLORS[0]);
  const [tags, setTags] = useState('');
  const [icon, setIcon] = useState(null);
  const [iconError, setIconError] = useState(null);
  const fileRef = useRef(null);
  const nameRef = useRef(null);

  // Choosing a tool (and opening the modal on one) fills the form with what
  // the catalog holds today, so the form always shows the tool being changed,
  // and asks the server where that tool is used -- the danger zone needs the
  // answer before it can offer anything.
  useEffect(() => {
    if (!editing || !selected) return;
    setName(selected.n);
    setCategory(selected.c);
    setCustomCategory('');
    setInitials(selected.k || '');
    setInitialsTouched(true);
    setColor(selected.col);
    setTags(selected.tags || '');
    setIcon(selected.icon || null);
    setIconError(null);
    onUsage(selected);
    // Only the identity of the chosen tool matters here: re-running this on
    // every render would fight the user's typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, sel]);

  useEffect(() => {
    if (nameRef.current) nameRef.current.focus();
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const shownInitials = initialsTouched ? initials : initialsFrom(name);
  const otherCategory = category === OTHER;
  const finalCategory = (otherCategory ? customCategory : category).trim().toUpperCase() || 'CUSTOM';
  const canSubmit =
    !!name.trim() && !saving && (!otherCategory || !!customCategory.trim()) && (!editing || !!selected);

  // The delete rule, in one place: a tool leaves the catalog only when no
  // diagram holds a node made from it. The answer has to be IN, and about THIS
  // tool -- a pending or failed check keeps the button locked.
  const usageFor = usage && selected && usage.key === keyOf(selected) ? usage : null;
  const canDelete = !!usageFor && !usageFor.loading && !usageFor.error && usageFor.count === 0 && !saving;
  let usageLine = 'checking where this tool is used…';
  if (usageFor && usageFor.error) usageLine = 'could not ask the server where this tool is used.';
  else if (usageFor && !usageFor.loading) {
    usageLine = usageFor.count
      ? 'In use in ' +
        usageFor.count +
        (usageFor.count === 1 ? ' diagram' : ' diagrams') +
        '. A tool is only deleted when no diagram holds a node made from it.'
      : selected && selected.custom
        ? 'Not used in any diagram. Deleting removes it from the catalog; stored diagrams are never rewritten.'
        : 'Not used in any diagram. This is a built-in tool: deleting it takes it out of the sidebar for everyone on this server.';
  }

  async function pickIcon(file) {
    setIconError(null);
    if (!file) return;
    try {
      setIcon(await readToolIcon(file));
    } catch (err) {
      setIconError((err && err.message) || 'could not read that image');
    }
  }

  function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    const draft = {
      name: name.trim(),
      category: finalCategory,
      initials: (shownInitials || '').slice(0, 8).toUpperCase() || null,
      color,
      tags: tags.trim(),
      icon
    };
    // An edit sends `icon` too: null is how the server is told to clear it.
    if (editing) onUpdate(selected, draft);
    else onCreate(draft);
  }

  return (
    <div className="fe-modal-backdrop" onMouseDown={onCancel}>
      <form
        className="fe-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="fe-modal-head">
          <div className="fe-modal-titles">
            <span className="fe-modal-title">{editing ? 'Edit tool' : 'New tool'}</span>
            <span className="fe-modal-sub">
              {editing
                ? 'Changes the sidebar catalog. Nodes already on a plane keep the look they were created with.'
                : 'Added to the sidebar catalog and shared with everyone using this server.'}
            </span>
          </div>
          <button type="button" className="fe-panel-close" onClick={onCancel} title="Close">
            ✕
          </button>
        </div>

        <div className="fe-modal-body">
          {editing && (
            <label className="fe-field">
              <span className="fe-field-label">Tool</span>
              <select
                className="fe-field-input fe-select"
                value={sel || ''}
                disabled={!editable.length}
                onChange={(e) => setSel(e.target.value)}
              >
                {editable.length ? (
                  editable.map((t) => (
                    <option key={keyOf(t)} value={keyOf(t)}>
                      {t.n} · {t.c}
                    </option>
                  ))
                ) : (
                  <option value="">no tool in the catalog</option>
                )}
              </select>
            </label>
          )}

          <div className="fe-modal-preview">
            <div
              className="fe-modal-icon"
              style={{ background: icon ? 'transparent' : color + '1f', color }}
            >
              {icon ? <img src={icon} alt="" /> : shownInitials || '??'}
            </div>
            <div className="fe-modal-preview-info">
              <span className="fe-modal-preview-name">{name.trim() || 'Tool name'}</span>
              <span className="fe-modal-preview-cat">{finalCategory}</span>
            </div>
          </div>

          <label className="fe-field">
            <span className="fe-field-label">Name</span>
            <input
              ref={nameRef}
              className="fe-field-input"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              placeholder="Trino, Databricks, internal service…"
            />
          </label>

          <div className="fe-field-row">
            <label className="fe-field">
              <span className="fe-field-label">Category</span>
              <select
                className="fe-field-input fe-select"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="CUSTOM">CUSTOM</option>
                {categories
                  .filter((c) => c !== 'CUSTOM')
                  .map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                <option value={OTHER}>Other…</option>
              </select>
            </label>
            <label className="fe-field fe-field-narrow">
              <span className="fe-field-label">Initials</span>
              <input
                className="fe-field-input"
                value={shownInitials}
                maxLength={8}
                onChange={(e) => {
                  setInitialsTouched(true);
                  setInitials(e.target.value.toUpperCase());
                }}
                placeholder="TR"
              />
            </label>
          </div>

          {otherCategory && (
            <label className="fe-field">
              <span className="fe-field-label">
                New category <span className="fe-field-hint">joins the list</span>
              </span>
              <input
                className="fe-field-input"
                value={customCategory}
                maxLength={40}
                autoFocus
                onChange={(e) => setCustomCategory(e.target.value.toUpperCase())}
                placeholder="LAKEHOUSE"
              />
            </label>
          )}

          <div className="fe-field">
            <span className="fe-field-label">Color</span>
            <div className="fe-swatches">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={'fe-swatch' + (c === color ? ' fe-swatch-on' : '')}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  title={c}
                />
              ))}
              <input
                type="color"
                className="fe-swatch-custom"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                title="Custom color"
              />
            </div>
          </div>

          <label className="fe-field">
            <span className="fe-field-label">
              Search terms <span className="fe-field-hint">optional</span>
            </span>
            <input
              className="fe-field-input"
              value={tags}
              maxLength={300}
              onChange={(e) => setTags(e.target.value)}
              placeholder="sql query engine lakehouse"
            />
          </label>

          <div className="fe-field">
            <span className="fe-field-label">
              Icon image <span className="fe-field-hint">optional</span>
            </span>
            <div className="fe-icon-picker">
              <button
                type="button"
                className="fe-ghost-btn"
                onClick={() => fileRef.current && fileRef.current.click()}
              >
                {icon ? 'Replace image…' : 'Choose image…'}
              </button>
              {icon && (
                <button type="button" className="fe-ghost-btn" onClick={() => setIcon(null)}>
                  Remove image
                </button>
              )}
              <span className="fe-field-hint">
                {icon ? 'resized to 64×64 PNG' : 'falls back to the initials'}
              </span>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  pickIcon(e.target.files && e.target.files[0]);
                  e.target.value = '';
                }}
              />
            </div>
          </div>

          {(iconError || error) && <div className="fe-modal-error">{iconError || error}</div>}

          {editing && selected && (
            <div className="fe-danger">
              <span className="fe-danger-title">Danger zone</span>
              <span className="fe-danger-sub">{usageLine}</span>
              {!!(usage && usage.flows && usage.flows.length) && (
                <ul className="fe-danger-list">
                  {usage.flows.map((f) => (
                    <li key={f.id}>
                      {f.name}
                      {f.deleted ? ' (in the trash)' : ''}
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                className="fe-danger-btn"
                disabled={!canDelete}
                onClick={() => onDelete(selected)}
              >
                Delete tool
              </button>
            </div>
          )}
        </div>

        <div className="fe-modal-foot">
          <button type="button" className="fe-ghost-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="fe-btn" disabled={!canSubmit}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create tool'}
          </button>
        </div>
      </form>
    </div>
  );
}
