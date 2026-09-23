// One state, one badge. `skipped` is deliberately a pale green and not an
// amber: flock declining to stack a run, and the checksum guard deciding the
// mirror already agrees with its source, are both successes.
const LABEL = {
  ok: 'OK',
  skipped: 'skipped',
  late: 'late',
  broken: 'broken',
  no_data: 'no data',
  unbound: 'unbound'
};

export default function HealthBadge({ state, reason }) {
  const key = LABEL[state] ? state : 'no_data';
  return (
    <span className={'ops-badge ops-badge--' + key} title={reason || ''}>
      {LABEL[key]}
    </span>
  );
}
