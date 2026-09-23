import { useEffect, useState } from 'react';
import { readSchema } from '../api.js';

export default function DatasetSchema({ slug, objectId }) {
  const [schema, setSchema] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setSchema(null);
    setError(null);
    readSchema(slug, objectId)
      .then((r) => {
        if (alive) setSchema(r);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [slug, objectId]);

  if (error) {
    return <div className="ops-dataset-error">{error}</div>;
  }
  if (!schema) {
    return <div className="ops-dataset-loading">loading schema…</div>;
  }

  return (
    <div className="ops-dataset-schema">
      <table className="ops-table">
        <thead>
          <tr>
            <th>column</th>
            <th>type</th>
            <th>nullable</th>
          </tr>
        </thead>
        <tbody>
          {schema.columns.map((col) => (
            <tr key={col.name}>
              <td>{col.name}</td>
              <td>{col.type}</td>
              <td>{col.nullable ? 'yes' : 'no'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
