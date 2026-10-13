import type { ExtDefinition } from "@toonflow/ext-scaffold/runtime";

export default {
  id: "ext-media",
  displayName: "音视频",
  icon: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#4e9fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m10 8 6 4-6 4z"/></svg>'),
  // 常见音视频都要收进来：豆包等平台导出的音频常见 m4a/aac，视频常见 mov/mkv/webm，
  // 漏一个就会出现「尚未启用支持此文件的扩展」——用户看着就像功能坏了。
  extensions: [
    // 视频
    "mp4", "mov", "m4v", "mkv", "webm", "avi", "wmv", "flv", "ts", "3gp",
    // 音频
    "mp3", "m4a", "m4b", "aac", "wav", "flac", "ogg", "oga", "opus", "wma", "amr", "pcm",
  ],
  resourceKind: "file",
} satisfies Omit<ExtDefinition, "load">;
