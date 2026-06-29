// Minimaler Ambient-Typ-Shim für `ari-client` (kein offizielles @types-Paket).
// Bewusst lose typisiert (any), da die ARI-Ressourcen dynamisch sind.
declare module "ari-client" {
  export interface AriChannel {
    id: string;
    answer(): Promise<void>;
    // Optional: ARI-Hangup mit Grund (z. B. { reason: "unallocated" } → 404 an den Anrufer).
    hangup(opts?: { reason?: string; reason_code?: string }): Promise<void>;
    play(opts: { media: string; [key: string]: unknown }): Promise<{ id: string; [key: string]: any }>;
    [key: string]: any;
  }
  export interface AriBridge {
    id: string;
    addChannel(opts: { channel: string | string[] }): Promise<void>;
    record(opts: Record<string, unknown>): Promise<any>;
    destroy(): Promise<void>;
    [key: string]: any;
  }
  export interface AriClient {
    on(event: string, listener: (...args: any[]) => void): void;
    start(app: string | string[]): void;
    channels: any;
    bridges: any;
    recordings: any;
    [key: string]: any;
  }
  export function connect(url: string, username: string, password: string): Promise<AriClient>;
  const _default: { connect: typeof connect };
  export default _default;
}
