import './panel.css';

export default function JobTasks({ node, view, onSelect }) {
  const tasks = (node.attrs && node.attrs.tasks) || [];

  if (tasks.length === 0) {
    return <div className="ops-job-tasks-empty">No tasks.</div>;
  }

  // Build a map of externalId to uid for quick lookup
  const externalIdToUid = new Map();
  view.nodes.forEach((n) => {
    if (n.externalId) externalIdToUid.set(n.externalId, n.uid);
  });

  const renderIoList = (ioList) => {
    if (!ioList || ioList.length === 0) return null;
    return (
      <div className="ops-job-io-list">
        {ioList.map((io, i) => {
          const uid = externalIdToUid.get(io);
          const isLink = !!uid;
          return isLink ? (
            <button
              key={i}
              type="button"
              className="ops-job-io-link"
              onClick={() => onSelect(uid)}
            >
              {io}
            </button>
          ) : (
            <span key={i} className="ops-job-io-item">
              {io}
            </span>
          );
        })}
      </div>
    );
  };

  return (
    <div className="ops-job-tasks">
      <table className="ops-job-tasks-table">
        <thead>
          <tr>
            <th>task id</th>
            <th>operator</th>
            <th>reads</th>
            <th>writes</th>
            <th>downstream</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.task_id} className="ops-job-tasks-row">
              <td className="ops-job-tasks-cell ops-job-tasks-cell--id">{task.task_id}</td>
              <td className="ops-job-tasks-cell ops-job-tasks-cell--operator">{task.operator}</td>
              <td className="ops-job-tasks-cell ops-job-tasks-cell--io">{renderIoList(task.inlets)}</td>
              <td className="ops-job-tasks-cell ops-job-tasks-cell--io">{renderIoList(task.outlets)}</td>
              <td className="ops-job-tasks-cell ops-job-tasks-cell--downstream">
                {task.downstream && task.downstream.length > 0 ? task.downstream.join(', ') : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
