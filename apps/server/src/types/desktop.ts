export type PluginInstallType = "node" | "tool" | "skill" | "provider" | "agent" | "ext";
export type PluginInstallRequest = { type: PluginInstallType; url: string; fileName: string };

export type desktopUpdateAttempt = {
  attemptId: string;
  runtimeId: string;
  channel: string;
  targetVersion: string;
  targetHash: string;
  failure?: string;
};

export type updateSnapshot = {
  version: string;
  channel: string;
  hash: string;
  latestVersion: string;
  latestHash: string;
  /** 发布清单里的更新说明（可为空） */
  notes: string;
  /** 安装包直链（来自发布清单）；「检测 + 一键下载」用它，而不是应用内自更新 */
  downloadUrl: string;
  error: string;
  updateAvailable: boolean;
  updateReady: boolean;
  updating: boolean;
  canUpdate: boolean;
  installFailure?: {
    attemptId: string;
    targetVersion: string;
    targetHash: string;
    currentVersion: string;
    currentHash: string;
    message: string;
    downloadUrl: string;
  };
};

export interface DesktopRuntime {
  openUrl(url: string): void;
  showItemInFolder(path: string): void;
  readClipboardText(): string | null;
  writeClipboardText(text: string): void;
  selectProviderFile(): Promise<string | null>;
  selectDirectory(): Promise<string | null>;
  selectSaveFile(fileName: string): Promise<string | null>;
  saveFile(token: string, content: Uint8Array): Promise<boolean>;
  ready(failed?: boolean): Promise<void>;
  openDevTools(): void;
  updater: {
    getLocalInfo(): Promise<{ version: string; channel: string; hash: string; baseUrl: string }>;
    updateInfo(): { version?: string; hash?: string; error?: string; installError?: string; updateAvailable?: boolean; updateReady?: boolean; downloadUrl?: string; notes?: string } | undefined;
    checkForUpdate(): Promise<{ error?: string }>;
    confirmStartup?(failed?: boolean): void | Promise<void>;
    downloadUpdate?(): Promise<void>;
    applyUpdate?(): Promise<void>;
  };
}
