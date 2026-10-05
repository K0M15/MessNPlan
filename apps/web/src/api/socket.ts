import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;

/** Verbindet zum gleichen Origin; im Dev leitet Vite /socket.io an die API weiter. */
export function connectSocket(): Socket {
  socket ??= io({ withCredentials: true, autoConnect: true });
  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}

// Nach einem Token-Refresh (neues Access-Cookie) den Socket neu verbinden,
// falls die Verbindung wegen abgelaufener Authentifizierung getrennt wurde.
if (typeof window !== 'undefined') {
  window.addEventListener('pp:auth-refreshed', () => {
    if (socket && !socket.connected) socket.connect();
  });
  window.addEventListener('pp:auth-expired', () => {
    disconnectSocket();
  });
}
