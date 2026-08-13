import { useState } from 'react';
import { fmtDate, fmtDuration, fmtSize } from './format.js';

const PAGE_SIZE = 20;

function selKey(device, file) {
  return device + ' ' + file;
}

// Buckets a timestamp into a friendly relative-date group, e.g. for the
// "Today / Yesterday / This Week / ... / March 2025" style headers.
function groupLabel(ts) {
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const now = new Date();
  const today = startOfDay(now);
  const day = startOfDay(new Date(ts));
  const diffDays = Math.round((today - day) / 86400000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return 'This Week';
  if (diffDays < 14) return 'Last Week';
  if (day.getFullYear() === today.getFullYear() && day.getMonth() === today.getMonth()) return 'This Month';
  if (day.getFullYear() === today.getFullYear()) return day.toLocaleDateString(undefined, { month: 'long' });
  return day.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
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
  onCommand, onListenLive, isListeningLive, onReconnect,
}) {
  const connected = !!(control && control.connected);
  const monitoring = connected && control.monitoring;
  const files = sortFiles(dev.files, sortState);
  const canListenLive = live && live.codec === 'opus';

  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(files.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageFiles = files.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);
  const grouped = sortState.key === 'mtime';

  function goToPage(next) {
    setPage(Math.max(0, Math.min(pageCount - 1, next)));
  }

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
        {!connected && (
          <button
            className="ctl"
            disabled={busyCmd === `${dev.deviceId}:reconnect`}
            title="Re-check the control channel for this device"
            onClick={() => onReconnect(dev.deviceId)}
          >
            <ion-icon name="sync-outline" />
            {busyCmd === `${dev.deviceId}:reconnect` ? 'Checking…' : 'Reconnect'}
          </button>
        )}
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
        <>
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
              {(() => {
                let lastGroup = null;
                return pageFiles.map((f) => {
                  const label = grouped ? groupLabel(f.mtime) : null;
                  const showGroup = grouped && label !== lastGroup;
                  lastGroup = label;
                  return (
                    <FileRow
                      key={f.name}
                      f={f}
                      dev={dev}
                      groupHeader={showGroup ? label : null}
                      selected={selected}
                      toggleSelect={toggleSelect}
                      onPlay={onPlay}
                      onDelete={onDelete}
                    />
                  );
                });
              })()}
            </tbody>
          </table>

          {pageCount > 1 && (
            <div className="pagination">
              <button className="ctl" disabled={clampedPage === 0} onClick={() => goToPage(clampedPage - 1)}>
                <ion-icon name="chevron-back-outline" />Prev
              </button>
              <span className="page-info">
                Page {clampedPage + 1} of {pageCount} · {files.length} recordings
              </span>
              <button className="ctl" disabled={clampedPage >= pageCount - 1} onClick={() => goToPage(clampedPage + 1)}>
                Next<ion-icon name="chevron-forward-outline" />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FileRow({ f, dev, groupHeader, selected, toggleSelect, onPlay, onDelete }) {
  return (
    <>
      {groupHeader && (
        <tr className="group-row">
          <td colSpan={6}>{groupHeader}</td>
        </tr>
      )}
      <tr>
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
    </>
  );
}
