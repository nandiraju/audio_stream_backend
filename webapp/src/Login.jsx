import { useState } from 'react';
import { login } from './api.js';

export default function Login({ onSuccess }) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!passphrase || busy) return;
    setBusy(true);
    setError('');
    try {
      await login(passphrase);
      onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1><ion-icon name="mic-outline"></ion-icon>Aṇrak</h1>
        <p>Enter the passphrase to view recordings.</p>
        <input
          type="password"
          autoFocus
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="Passphrase"
        />
        {error && <div className="login-error">{error}</div>}
        <button type="submit" disabled={busy || !passphrase}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
