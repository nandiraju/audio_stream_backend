import { useCallback, useState } from 'react';
import Login from './Login.jsx';
import Recordings from './Recordings.jsx';
import { getToken, setToken } from './api.js';

export default function App() {
  const [authed, setAuthed] = useState(() => !!getToken());

  const handleLoggedOut = useCallback(() => {
    setToken('');
    setAuthed(false);
  }, []);

  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;
  return <Recordings onUnauthorized={handleLoggedOut} />;
}
