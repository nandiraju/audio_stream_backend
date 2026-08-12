import { useCallback, useEffect, useMemo, useState } from 'react';
import DeviceSection from './DeviceSection.jsx';
import { useConfirm } from './ConfirmModal.jsx';
import { apiJson, authedUrl, AuthError, logout } from './api.js';

function selKey(device, file) {
  return device + ' ' + file;
}

export default function Recordings({ onUnauthorized }) {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');
  const [data, setData] = useState({ devices: [], controls: [], live: [] });
  const [selected, setSelected] = useState(() => new Set());
  const [sortState, setSortState] = useState({ key: 'mtime', dir: -1 });
  const [nowPlaying, setNowPlaying] = useState(null);
  const [busyCmd, setBusyCmd] = useState(null);
  const [modal, confirm] = useConfirm();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

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
        <span className="sub">recordings in S3 — list refreshes automatically</span>
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
        <button className="ctl" onClick={handleLogout} title="Log out">Log out</button>
        <button id="theme-toggle" title="Switch between light and dark theme"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>
          <ion-icon name={theme === 'dark' ? 'sunny-outline' : 'moon-outline'} />
        </button>
      </header>

      <div id="list">
        {allDevices.length === 0 ? (
          <div className="empty">No recordings yet. Start monitoring on the iPad and files will appear here.</div>
        ) : (
          allDevices.map((dev) => (
            <DeviceSection
              key={dev.deviceId}
              dev={dev}
              control={controlsById[dev.deviceId]}
              live={liveById[dev.deviceId]}
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
              isListeningLive={!!(nowPlaying && nowPlaying.live && nowPlaying.device === dev.deviceId)}
            />
          ))
        )}
      </div>

      {nowPlaying && (
        <div className="player-bar visible">
          <div className="now-playing">
            <b>{nowPlaying.live ? 'Live audio' : nowPlaying.file}</b>
            <span>{nowPlaying.device}{nowPlaying.live && <span className="live"> ● LIVE</span>}</span>
          </div>
          <audio
            key={nowPlaying.live ? `live:${nowPlaying.device}` : `${nowPlaying.device}/${nowPlaying.file}`}
            controls
            autoPlay
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
