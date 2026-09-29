export interface NetworkConfig {
  broker: { host: string; port: number; path: string; secure: boolean };
  iceServers: RTCIceServer[];
}

const env = import.meta.env;

const DEFAULT_TURN_URLS = ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'];

export function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 443;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 443;
}

const hasCompleteTurnOverride =
  env.VITE_TURN_URL !== undefined &&
  env.VITE_TURN_USERNAME !== undefined &&
  env.VITE_TURN_CREDENTIAL !== undefined;

const turn: RTCIceServer = hasCompleteTurnOverride
  ? {
      urls: [env.VITE_TURN_URL],
      username: env.VITE_TURN_USERNAME,
      credential: env.VITE_TURN_CREDENTIAL,
    }
  : { urls: DEFAULT_TURN_URLS, username: 'peerjs', credential: 'peerjsp' };

export const APP_URL: string | undefined = env.VITE_APP_URL;

export const NETWORK: NetworkConfig = {
  broker: {
    host: env.VITE_BROKER_HOST ?? '0.peerjs.com',
    port: parsePort(env.VITE_BROKER_PORT),
    path: env.VITE_BROKER_PATH ?? '/',
    secure: env.VITE_BROKER_SECURE === 'false' ? false : true,
  },
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    turn,
  ],
};
