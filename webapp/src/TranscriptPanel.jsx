import { useEffect, useMemo, useRef, useState } from 'react';
import { apiJson, AuthError } from './api.js';
import { fmtDuration } from './format.js';

// Splits a segment's text on the search term so matches can be marked without
// dangerouslySetInnerHTML.
function highlight(text, query) {
  if (!query) return text;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const out = [];
  let at = 0;
  for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, at)) {
    if (i > at) out.push(text.slice(at, i));
    out.push(<mark key={i}>{text.slice(i, i + needle.length)}</mark>);
    at = i + needle.length;
  }
  out.push(text.slice(at));
  return out;
}

export default function TranscriptPanel({ target, onClose, onSeek, playingTime, onUnauthorized }) {
  const [state, setState] = useState({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const listRef = useRef(null);

  const { device, file } = target;

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    setQuery('');
    apiJson(`/api/s3/transcript/${encodeURIComponent(device)}/${encodeURIComponent(file)}`)
      .then((doc) => { if (!cancelled) setState({ status: 'ready', doc }); })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof AuthError) return onUnauthorized();
        setState({ status: 'error', message: err.message });
      });
    return () => { cancelled = true; };
  }, [device, file, onUnauthorized]);

  // Esc closes, matching the confirm modal's behaviour.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const doc = state.status === 'ready' ? state.doc : null;
  // Stable identity, so the memos below don't recompute on every render.
  const segments = useMemo(() => doc?.segments || [], [doc]);

  const shown = useMemo(() => {
    if (!query.trim()) return segments;
    const needle = query.trim().toLowerCase();
    return segments.filter((s) => s.text.toLowerCase().includes(needle));
  }, [segments, query]);

  // Which segment the player is inside right now, so it can be marked and
  // scrolled to. -1 when this file isn't the one playing.
  const activeIndex = useMemo(() => {
    if (playingTime == null) return -1;
    return segments.findIndex((s) => playingTime >= s.start && playingTime < s.end);
  }, [segments, playingTime]);

  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-seg="${activeIndex}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIndex]);

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(doc.text || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — the text is still selectable */ }
  }

  return (
    <>
      <div className="panel-backdrop" onClick={onClose} />
      <aside className="transcript-panel" role="dialog" aria-label={`Transcript of ${file}`}>
        <div className="tp-head">
          <div className="tp-title">
            <b>Transcript</b>
            <span>{device} / {file}</span>
          </div>
          <button className="tp-close" onClick={onClose} title="Close" aria-label="Close">
            <ion-icon name="close-outline" />
          </button>
        </div>

        {state.status === 'loading' && <div className="tp-msg">Loading transcript…</div>}

        {state.status === 'error' && (
          <div className="tp-msg">
            <ion-icon name="alert-circle-outline" />
            {state.message === 'no transcript'
              ? 'No transcript for this recording yet.'
              : state.message}
          </div>
        )}

        {doc && (
          <>
            <div className="tp-tools">
              <input
                className="tp-search"
                type="search"
                placeholder="Search this transcript…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button className="ctl" onClick={copyAll} disabled={!doc.text}>
                <ion-icon name={copied ? 'checkmark-outline' : 'copy-outline'} />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            <div className="tp-meta">
              {segments.length} segment{segments.length === 1 ? '' : 's'}
              {query.trim() && ` · ${shown.length} matching`}
              {doc.model && ` · ${doc.model.replace(/^ggml-|\.bin$/g, '')}`}
            </div>

            <div className="tp-body" ref={listRef}>
              {!segments.length && (
                <div className="tp-msg">No speech detected in this recording.</div>
              )}
              {segments.length > 0 && !shown.length && (
                <div className="tp-msg">No matches for “{query.trim()}”.</div>
              )}
              {shown.map((s) => {
                const i = segments.indexOf(s);
                return (
                  <button
                    key={i}
                    data-seg={i}
                    className={'tp-seg' + (i === activeIndex ? ' active' : '')}
                    onClick={() => onSeek(device, file, s.start)}
                    title="Jump to this moment"
                  >
                    <span className="tp-time">{fmtDuration(s.start)}</span>
                    <span className="tp-text">{highlight(s.text, query.trim())}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
