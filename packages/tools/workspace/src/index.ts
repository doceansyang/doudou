import { z } from "zod";
import type { ToolDefinition, ToolPlugin } from "@toonflow/tools-scaffold/runtime";

const configSchema = z.object({ readOnly: z.boolean().default(false) }).strict();

const plugin: ToolPlugin = {
  validateConfig: config => configSchema.parse(config),
  createTools({ cwd, config, files, sdk }) {
    const { readOnly } = configSchema.parse(config);
    const tools: ToolDefinition[] = [
      sdk.defineTool(sdk.createReadToolDefinition(cwd, { operations: {
        readFile: path => files.readFile(path, true),
        access: path => files.access(path, true),
        detectImageMimeType: path => files.detectImageMimeType(path, true),
      } })),
      sdk.defineTool(sdk.createLsToolDefinition(cwd, { operations: {
        exists: async path => {
          try { await files.access(path, true); return true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
        },
        stat: path => files.stat(path, true),
        readdir: path => files.readdir(path, true),
      } })),
    ];
    if (!readOnly) {
      tools.splice(1, 0,
        sdk.defineTool(sdk.createWriteToolDefinition(cwd, { operations: {
          writeFile: files.writeFile,
          mkdir: path => files.mkdir(path, true),
        } })),
        sdk.defineTool(sdk.createEditToolDefinition(cwd, { operations: { readFile: files.readFile, access: files.access, writeFile: files.writeFile } })),
      );
    }
    return tools.map(tool => ({
      ...tool,
      promptGuidelines: [
        ...(tool.promptGuidelines ?? []),
        ...(readOnly ? ["当前文件工具只支持读取，不能用它们写入或编辑文件；其他工具的能力以各自说明为准。"] : []),
      ],
    }));
  },
};

export default plugin;
