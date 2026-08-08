import { fmtDate, fmtDuration, fmtSize } from './format.js';

function selKey(device, file) {
  return device + ' ' + file;
}

function HeaderCell({ label, sortKey, sortState, setSort }) {
  return (
    <th className="sortable" onClick={() => setSort(sortKey)}>
      {label}
      {sortState.key === sortKey && (
        <ion-icon name={sortState.dir === 1 ? 'chevron-up-outline' : 'chevron-down-outline'} />
      )}
    </th>
  );
}

function sortFiles(files, sortState) {
  const { key, dir } = sortState;
  return [...files].sort((a, b) => {
    const va = a[key] == null ? -1 : a[key];
    const vb = b[key] == null ? -1 : b[key];
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return 0;
  });
}

export default function DeviceSection({
  dev, control, live, sortState, setSort, selected, toggleSelect, onPlay, onDelete, busyCmd,
  onCommand, onListenLive, isListeningLive,
}) {
  const connected = !!control;
  const monitoring = connected && control.monitoring;
  const files = sortFiles(dev.files, sortState);
  const canListenLive = live && live.codec === 'opus';

  const allKeys = dev.files.map((f) => selKey(dev.deviceId, f.name));
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  function toggleSelectAll(checked) {
    dev.files.forEach((f) => toggleSelect(dev.deviceId, f.name, checked));
  }

  function cmdButton(label, iconName, cls, action, enabled) {
    const busy = busyCmd === `${dev.deviceId}:${action}`;
    return (
      <button
        className={'ctl ' + cls}
        disabled={!enabled || busy}
        title={!connected ? 'App not connected' : undefined}
        onClick={() => onCommand(dev.deviceId, action)}
      >
        <ion-icon name={iconName} />{label}
      </button>
    );
  }

  return (
    <div className="device">
      <h2>
        {cmdButton('Start', 'play-outline', 'start', 'start', connected && !monitoring)}
        {cmdButton('Stop', 'stop-outline', 'stop', 'stop', monitoring)}
        {cmdButton('Restart', 'refresh-outline', '', 'restart', monitoring)}
        <button
          className={'ctl' + (isListeningLive ? ' start' : '')}
          disabled={!canListenLive}
          title={live && !canListenLive ? 'Live listen needs Opus (device is on the PCM16 fallback)' : undefined}
          onClick={() => onListenLive(dev.deviceId)}
        >
          <ion-icon name="radio-outline" />{isListeningLive ? 'Listening…' : 'Listen live'}
        </button>
        <span className="device-pill">
          {dev.deviceId}
          <span className={'ctl-state' + (monitoring ? ' on' : '')}>
            <span className="dot" />
            {!connected ? 'offline' : monitoring ? 'monitoring' : 'idle'}
          </span>
        </span>
      </h2>

      {!dev.files.length ? (
        <div className="empty" style={{ margin: '8px 0 0' }}>No recordings yet.</div>
      ) : (
        <table>
          <tbody>
            <tr className="head-row">
              <th className="check-col">
                <input
                  type="checkbox"
                  title="Select all"
                  checked={allSelected}
                  onChange={(e) => toggleSelectAll(e.target.checked)}
                />
              </th>
              <HeaderCell label="Recorded" sortKey="mtime" sortState={sortState} setSort={setSort} />
              <HeaderCell label="File" sortKey="name" sortState={sortState} setSort={setSort} />
              <HeaderCell label="Duration" sortKey="duration" sortState={sortState} setSort={setSort} />
              <HeaderCell label="Size" sortKey="size" sortState={sortState} setSort={setSort} />
              <th />
            </tr>
            {files.map((f) => (
              <tr key={f.name}>
                <td className="check-col">
                  <input
                    type="checkbox"
                    checked={selected.has(selKey(dev.deviceId, f.name))}
                    onChange={(e) => toggleSelect(dev.deviceId, f.name, e.target.checked)}
                  />
                </td>
                <td>{fmtDate(f.mtime)}</td>
                <td>{f.name}</td>
                <td>{fmtDuration(f.duration)}</td>
                <td>{fmtSize(f.size)}</td>
                <td className="actions">
                  <button className="play" title="Play" aria-label="Play" onClick={() => onPlay(dev.deviceId, f.name)}>
                    <ion-icon name="play" />
                  </button>
                  <a
                    className="dl"
                    href={f.downloadUrl}
                    download={f.name}
                    title="Download"
                    aria-label="Download"
                  >
                    <ion-icon name="download-outline" />
                  </a>
                  <button className="del" title="Delete" aria-label="Delete" onClick={() => onDelete(dev.deviceId, f.name)}>
                    <ion-icon name="trash-outline" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
