import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DeviceSection from './DeviceSection.jsx';
import TranscriptPanel from './TranscriptPanel.jsx';
import SettingsModal from './SettingsModal.jsx';
import { useConfirm } from './ConfirmModal.jsx';
import { apiJson, authedUrl, AuthError, logout } from './api.js';

function selKey(device, file) {
  return device + ' ' + file;
}

export default function Recordings({ onUnauthorized }) {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');
  const [data, setData] = useState({ devices: [], controls: [], live: [] });
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [sortState, setSortState] = useState({ key: 'mtime', dir: -1 });
  const [nowPlaying, setNowPlaying] = useState(null);
  const [busyCmd, setBusyCmd] = useState(null);
  const [transcript, setTranscript] = useState(null); // { device, file }
  const [playhead, setPlayhead] = useState(null);
  const [modal, confirm] = useConfirm();

  const audioRef = useRef(null);
  // Seeking a file that isn't loaded yet has to wait for its metadata, so the
  // target time is parked here until the <audio> remounts and reports duration.
  const pendingSeekRef = useRef(null);

  const [version, setVersion] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busyDevice, setBusyDevice] = useState(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Unauthenticated endpoint — hover the badge for the build SHA.
  useEffect(() => {
    fetch('/api/version')
      .then((r) => r.json())
      .then((d) => { if (d && d.version) setVersion(d); })
      .catch(() => { /* older server without /api/version */ });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [rec, ctl] = await Promise.all([
        apiJson('/api/s3/recordings'),
        apiJson('/api/controls'),
      ]);
      setData({ devices: rec.devices || [], controls: ctl.controls || [], live: ctl.live || [] });
    } catch (err) {
      if (err instanceof AuthError) onUnauthorized();
      else console.error(err);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [refresh]);

  // Drop selections for files that no longer exist after a refresh.
  useEffect(() => {
    setSelected((prev) => {
      const valid = new Set();
      data.devices.forEach((d) => d.files.forEach((f) => valid.add(selKey(d.deviceId, f.name))));
      const next = new Set([...prev].filter((k) => valid.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [data]);

  // Close the slide-over if its recording was deleted, here or elsewhere.
  useEffect(() => {
    setTranscript((prev) => {
      if (!prev) return prev;
      const dev = data.devices.find((d) => d.deviceId === prev.device);
      return dev && dev.files.some((f) => f.name === prev.file) ? prev : null;
    });
  }, [data]);

  const controlsById = useMemo(() => {
    const m = {};
    data.controls.forEach((c) => { m[c.deviceId] = c; });
    return m;
  }, [data.controls]);

  const liveById = useMemo(() => {
    const m = {};
    data.live.forEach((l) => { m[l.deviceId] = l; });
    return m;
  }, [data.live]);

  // If the device we're listening to stops streaming, drop the dead player.
  useEffect(() => {
    setNowPlaying((prev) => (prev && prev.live && !liveById[prev.device] ? null : prev));
  }, [liveById]);

  const allDevices = useMemo(() => {
    const byId = {};
    data.devices.forEach((d) => { byId[d.deviceId] = d; });
    Object.keys(controlsById).forEach((id) => {
      if (!byId[id]) byId[id] = { deviceId: id, files: [] };
    });
    return Object.keys(byId).sort().map((id) => ({
      ...byId[id],
      files: byId[id].files.map((f) => ({
        ...f,
        downloadUrl: authedUrl(`/api/s3/rec/${encodeURIComponent(id)}/${encodeURIComponent(f.name)}`),
      })),
    }));
  }, [data.devices, controlsById]);

  // Default to the first device, and fall back if the selected one disappears.
  useEffect(() => {
    if (!allDevices.length) {
      if (selectedDeviceId) setSelectedDeviceId('');
      return;
    }
    if (!allDevices.some((d) => d.deviceId === selectedDeviceId)) {
      setSelectedDeviceId(allDevices[0].deviceId);
    }
  }, [allDevices, selectedDeviceId]);

  const selectedDevice = allDevices.find((d) => d.deviceId === selectedDeviceId) || null;

  function toggleSelect(device, file, checked) {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = selKey(device, file);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function setSort(key) {
    setSortState((prev) => (
      prev.key === key ? { key, dir: -prev.dir } : { key, dir: key === 'name' ? 1 : -1 }
    ));
  }

  function play(device, file) {
    setNowPlaying({ device, file });
  }

  function showTranscript(device, file) {
    setTranscript((prev) => (prev && prev.device === device && prev.file === file
      ? null            // clicking the open row's icon again closes the panel
      : { device, file }));
  }

  // Jump the player to a transcript segment. If that file isn't loaded, swap it
  // in first and let onLoadedMetadata apply the seek.
  function seekTo(device, file, seconds) {
    const el = audioRef.current;
    const isCurrent = nowPlaying && !nowPlaying.live
      && nowPlaying.device === device && nowPlaying.file === file;
    if (isCurrent && el) {
      el.currentTime = seconds;
      el.play().catch(() => { /* autoplay policy — controls are right there */ });
      return;
    }
    pendingSeekRef.current = seconds;
    setNowPlaying({ device, file });
  }

  function applyPendingSeek() {
    const el = audioRef.current;
    if (!el || pendingSeekRef.current == null) return;
    el.currentTime = pendingSeekRef.current;
    pendingSeekRef.current = null;
    el.play().catch(() => {});
  }

  function listenLive(device) {
    setNowPlaying({ device, live: true });
  }

  async function removeRecording(device, file) {
    const ok = await confirm({
      title: 'Delete this recording?',
      message: `${device} / ${file}\n\nThis cannot be undone.`,
      okLabel: 'Delete',
      showCancel: true,
      danger: true,
    });
    if (!ok) return;
    try {
      await apiJson(`/api/s3/rec/${encodeURIComponent(device)}/${encodeURIComponent(file)}`, { method: 'DELETE' });
      refresh();
    } catch (err) {
      if (err instanceof AuthError) return onUnauthorized();
      await confirm({ title: 'Could not delete', message: err.message, okLabel: 'OK' });
    }
  }

  function selectedEntries() {
    return [...selected].map((k) => {
      const [device, file] = k.split(' ');
      return { device, file };
    });
  }

  function downloadSelected() {
    selectedEntries().forEach((e, i) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = authedUrl(`/api/s3/rec/${encodeURIComponent(e.device)}/${encodeURIComponent(e.file)}`);
        a.download = e.file;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 400);
    });
  }

  async function deleteSelected() {
    const entries = selectedEntries();
    if (!entries.length) return;
    const noun = 'recording' + (entries.length > 1 ? 's' : '');
    const ok = await confirm({
      title: `Delete ${entries.length} ${noun}?`,
      message: 'This cannot be undone.',
      okLabel: 'Delete',
      showCancel: true,
      danger: true,
    });
    if (!ok) return;
    const results = await Promise.all(entries.map((e) =>
      apiJson(`/api/s3/rec/${encodeURIComponent(e.device)}/${encodeURIComponent(e.file)}`, { method: 'DELETE' })
        .then(() => ({ ok: true }))
        .catch((err) => ({ ok: false, authError: err instanceof AuthError }))
    ));
    if (results.some((r) => r.authError)) return onUnauthorized();
    const failed = results.filter((r) => !r.ok).length;
    if (failed) await confirm({ title: 'Some deletions failed', message: `${failed} file(s) could not be deleted.`, okLabel: 'OK' });
    setSelected(new Set());
    refresh();
  }

  async function removeDevice(deviceId) {
    const dev = allDevices.find((d) => d.deviceId === deviceId);
    const count = dev ? dev.files.length : 0;
    const ok = await confirm({
      title: `Delete "${deviceId}"?`,
      message: count
        ? `This permanently deletes ${count} recording${count === 1 ? '' : 's'} and any transcripts for ${deviceId} from S3.\n\nThis cannot be undone.`
        : `${deviceId} has no recordings. Remove it from the list?\n\nIt will reappear if the device connects again.`,
      okLabel: 'Delete device',
      showCancel: true,
      danger: true,
    });
    if (!ok) return;
    setBusyDevice(deviceId);
    try {
      const result = await apiJson(`/api/s3/device/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
      if (selectedDeviceId === deviceId) setSelectedDeviceId('');
      setTranscript((prev) => (prev && prev.device === deviceId ? null : prev));
      setNowPlaying((prev) => (prev && prev.device === deviceId ? null : prev));
      await refresh();
      await confirm({
        title: 'Device deleted',
        message: `Removed ${result.deleted} object${result.deleted === 1 ? '' : 's'} for ${deviceId}.`,
        okLabel: 'OK',
      });
    } catch (err) {
      if (err instanceof AuthError) return onUnauthorized();
      await confirm({ title: 'Could not delete device', message: err.message, okLabel: 'OK' });
    } finally {
      setBusyDevice(null);
    }
  }

  async function sendCommand(deviceId, action) {
    setBusyCmd(`${deviceId}:${action}`);
    try {
      const result = await apiJson('/api/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId, action }),
      });
      if (!result.delivered) {
        await confirm({ title: 'Device unreachable', message: 'The device is not connected right now. Make sure the app is open on the iPad.', okLabel: 'OK' });
      }
      setTimeout(refresh, 1200);
    } catch (err) {
      if (err instanceof AuthError) return onUnauthorized();
      await confirm({ title: 'Command failed', message: err.message, okLabel: 'OK' });
    } finally {
      setBusyCmd(null);
    }
  }

  async function reconnectDevice(deviceId) {
    setBusyCmd(`${deviceId}:reconnect`);
    try {
      const ctl = await apiJson('/api/controls');
      const online = (ctl.controls || []).some((c) => c.deviceId === deviceId && c.connected);
      await refresh();
      if (!online) {
        await confirm({
          title: 'Still offline',
          message: `${deviceId} has not reconnected. Make sure the app is open and monitoring on the iPad.`,
          okLabel: 'OK',
        });
      }
    } catch (err) {
      if (err instanceof AuthError) return onUnauthorized();
      await confirm({ title: 'Check failed', message: err.message, okLabel: 'OK' });
    } finally {
      setBusyCmd(null);
    }
  }

  async function handleLogout() {
    await logout();
    onUnauthorized();
  }

  return (
    <>
      <header>
        <h1><ion-icon name="mic-outline" />Aṇrak</h1>
        {allDevices.length > 0 && (
          <select
            className="device-select"
            value={selectedDeviceId}
            onChange={(e) => setSelectedDeviceId(e.target.value)}
            aria-label="Select device"
          >
            {allDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {(controlsById[d.deviceId] && controlsById[d.deviceId].connected) ? '● ' : '○ '}
                {d.deviceId}
              </option>
            ))}
          </select>
        )}
        <span className="sub">recordings in S3 — list refreshes automatically</span>
        {version && (
          <span className="app-version" title={`build ${version.build}`}>
            v{version.version}
          </span>
        )}
        <div className="sel-bar">
          <button className="ctl start" disabled={!selected.size} onClick={downloadSelected}>
            <ion-icon name="download-outline" />Download selected
          </button>
          <button className="ctl stop" disabled={!selected.size} onClick={deleteSelected}>
            <ion-icon name="trash-outline" />Delete selected
          </button>
          <button className="ctl" disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear</button>
          <span className="sel-count">{selected.size} selected</span>
        </div>
        <button className="ctl" onClick={() => setSettingsOpen(true)} title="Manage devices">
          <ion-icon name="settings-outline" />Settings
        </button>
        <button className="ctl" onClick={handleLogout} title="Log out">Log out</button>
        <button id="theme-toggle" title="Switch between light and dark theme"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>
          <ion-icon name={theme === 'dark' ? 'sunny-outline' : 'moon-outline'} />
        </button>
      </header>

      <div id="list">
        {allDevices.length === 0 ? (
          <div className="empty">No recordings yet. Start monitoring on the iPad and files will appear here.</div>
        ) : selectedDevice ? (
          <DeviceSection
            key={selectedDevice.deviceId}
            dev={selectedDevice}
            control={controlsById[selectedDevice.deviceId]}
            live={liveById[selectedDevice.deviceId]}
            sortState={sortState}
            setSort={setSort}
            selected={selected}
            toggleSelect={toggleSelect}
            onPlay={play}
            onDelete={removeRecording}
            busyCmd={busyCmd}
            onCommand={sendCommand}
            onReconnect={reconnectDevice}
            onListenLive={listenLive}
            isListeningLive={!!(nowPlaying && nowPlaying.live && nowPlaying.device === selectedDevice.deviceId)}
            onTranscript={showTranscript}
            openTranscript={transcript && transcript.device === selectedDevice.deviceId ? transcript.file : null}
          />
        ) : null}
      </div>

      {settingsOpen && (
        <SettingsModal
          devices={allDevices}
          controlsById={controlsById}
          liveById={liveById}
          busyDevice={busyDevice}
          onDeleteDevice={removeDevice}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {transcript && (
        <TranscriptPanel
          target={transcript}
          onClose={() => setTranscript(null)}
          onSeek={seekTo}
          // Only drive the follow-along highlight when the open transcript is
          // the file actually playing.
          playingTime={nowPlaying && !nowPlaying.live
            && nowPlaying.device === transcript.device
            && nowPlaying.file === transcript.file ? playhead : null}
          onUnauthorized={onUnauthorized}
        />
      )}

      {nowPlaying && (
        <div className={'player-bar visible' + (transcript ? ' inset' : '')}>
          <div className="now-playing">
            <b>{nowPlaying.live ? 'Live audio' : nowPlaying.file}</b>
            <span>{nowPlaying.device}{nowPlaying.live && <span className="live"> ● LIVE</span>}</span>
          </div>
          <audio
            key={nowPlaying.live ? `live:${nowPlaying.device}` : `${nowPlaying.device}/${nowPlaying.file}`}
            ref={audioRef}
            controls
            autoPlay
            onLoadedMetadata={applyPendingSeek}
            onTimeUpdate={(e) => setPlayhead(e.target.currentTime)}
          >
            <source
              src={nowPlaying.live
                ? authedUrl(`/api/live/${encodeURIComponent(nowPlaying.device)}`)
                : authedUrl(`/api/s3/rec/${encodeURIComponent(nowPlaying.device)}/${encodeURIComponent(nowPlaying.file)}`)}
              type={!nowPlaying.live && nowPlaying.file.endsWith('.wav') ? 'audio/wav' : 'audio/ogg; codecs=opus'}
            />
          </audio>
          <button className="ctl" onClick={() => setNowPlaying(null)}>Close</button>
        </div>
      )}

      {modal}
    </>
  );
}
