import { useEffect } from 'react';
import { fmtSize } from './format.js';

// Device manager: what is connected, how much each device is storing, and a
// way to remove one entirely. Deletion is irreversible, so the caller supplies
// the shared confirm() dialog rather than this component rolling its own.
export default function SettingsModal({ devices, controlsById, liveById, onClose, onDeleteDevice, busyDevice }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busyDevice) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busyDevice]);

  return (
    <div className="modal-backdrop settings-backdrop" onClick={() => !busyDevice && onClose()}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h3>Devices</h3>
          <button className="tp-close" onClick={onClose} disabled={!!busyDevice} aria-label="Close">
            <ion-icon name="close-outline" />
          </button>
        </div>

        {!devices.length && <p className="settings-empty">No devices yet.</p>}

        <ul className="device-list">
          {devices.map((d) => {
            const ctl = controlsById[d.deviceId];
            const connected = !!(ctl && ctl.connected);
            const monitoring = connected && ctl.monitoring;
            const recording = !!liveById[d.deviceId];
            const bytes = d.files.reduce((n, f) => n + (f.size || 0), 0);
            const withText = d.files.filter((f) => f.hasTranscript).length;
            const busy = busyDevice === d.deviceId;

            return (
              <li key={d.deviceId}>
                <div className="dl-main">
                  <span className="dl-name">{d.deviceId}</span>
                  <span className={'ctl-state' + (monitoring ? ' on' : '')}>
                    <span className="dot" />
                    {!connected ? 'offline' : monitoring ? 'monitoring' : 'idle'}
                  </span>
                </div>
                <div className="dl-meta">
                  {d.files.length} recording{d.files.length === 1 ? '' : 's'}
                  {d.files.length > 0 && ` · ${fmtSize(bytes)} · ${withText} transcribed`}
                </div>
                <button
                  className="ctl stop dl-del"
                  disabled={busy || recording}
                  title={recording ? 'Stop monitoring before deleting this device' : 'Delete this device and all its recordings'}
                  onClick={() => onDeleteDevice(d.deviceId)}
                >
                  <ion-icon name="trash-outline" />
                  {busy ? 'Deleting…' : recording ? 'Recording' : 'Delete'}
                </button>
              </li>
            );
          })}
        </ul>

        <p className="settings-note">
          Deleting a device permanently removes its recordings and transcripts from S3.
          A device that is still connected will reappear here with no recordings.
        </p>
      </div>
    </div>
  );
}
