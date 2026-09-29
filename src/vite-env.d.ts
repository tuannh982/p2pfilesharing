/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_URL?: string;
  readonly VITE_BROKER_HOST?: string;
  readonly VITE_BROKER_PORT?: string;
  readonly VITE_BROKER_PATH?: string;
  readonly VITE_BROKER_SECURE?: string;
  readonly VITE_TURN_URL?: string;
  readonly VITE_TURN_USERNAME?: string;
  readonly VITE_TURN_CREDENTIAL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
