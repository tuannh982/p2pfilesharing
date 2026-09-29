import { isFileSystemAccessSupported } from './sink/file';

export interface EnvironmentSupport {
  secureContext: boolean;
  webRtc: boolean;
  fileSystemAccess: boolean;
}

export function detectSupport(): EnvironmentSupport {
  return {
    secureContext: globalThis.isSecureContext === true,
    webRtc: typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === 'function',
    fileSystemAccess: isFileSystemAccessSupported(),
  };
}

export function unsupportedReason(support: EnvironmentSupport): string | null {
  if (!support.secureContext) {
    return 'This page is not on HTTPS, so the browser will not allow peer-to-peer connections.';
  }
  if (!support.webRtc) {
    return "This browser can't do peer-to-peer connections. Try a recent Chrome, Edge, Firefox, or Safari.";
  }
  return null;
}
