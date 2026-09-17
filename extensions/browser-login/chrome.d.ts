type ExtensionSender = {
  id?: string;
  url?: string;
  tab?: { id?: number };
  documentId?: string;
  frameId?: number;
};
type ExtensionListener = (
  message: unknown,
  sender: ExtensionSender,
  reply: (value: unknown) => void,
) => boolean | void;
declare const chrome: {
  runtime: {
    id: string;
    getURL(path: string): string;
    getManifest(): { version: string };
    onInstalled: { addListener(listener: () => void): void };
    onMessage: { addListener(listener: ExtensionListener): void };
    onMessageExternal: { addListener(listener: ExtensionListener): void };
    sendMessage(message: unknown): Promise<unknown>;
  };
  action: { onClicked: { addListener(listener: () => void): void } };
  tabs: {
    query(
      query: object,
    ): Promise<Array<{ id?: number; url?: string; title?: string }>>;
    get(id: number): Promise<{ id?: number; url?: string }>;
    create(options: { url: string }): Promise<unknown>;
    sendMessage(
      tabId: number,
      message: unknown,
      options?: { documentId?: string; frameId?: number },
    ): Promise<unknown>;
  };
  scripting: {
    executeScript(options: {
      target: { tabId: number };
      files: string[];
    }): Promise<Array<{ documentId: string }>>;
  };
  permissions: {
    request(options: { origins: string[] }): Promise<boolean>;
    contains(options: { origins: string[] }): Promise<boolean>;
  };
  storage: {
    session: {
      get(key: string): Promise<Record<string, unknown>>;
      set(value: Record<string, unknown>): Promise<void>;
      remove(key: string): Promise<void>;
    };
  };
};
