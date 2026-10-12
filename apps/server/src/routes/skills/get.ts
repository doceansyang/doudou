import { loadSkillsFromDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readFile } from "@toonflow/file";
import { dirname, join, resolve } from "node:path";
import { Router } from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

const router = Router();

export default router.get("/", async (_req, res) => {
  const { skills } = loadSkillsFromDir({ dir: resolve(dirname(u.conf.path), "skills"), source: "user" });
  const items = await Promise.all(skills.map(async (skill) => {
    const { frontmatter } = parseFrontmatter(await readFile(skill.filePath, "utf8"));
    const metadata = frontmatter.metadata && typeof frontmatter.metadata === "object" && !Array.isArray(frontmatter.metadata)
      ? frontmatter.metadata as Record<string, unknown> : {};
    let github = "";
    if (typeof metadata.github === "string" && URL.canParse(metadata.github)) {
      const url = new URL(metadata.github);
      if (url.origin === "https://github.com" && !url.username && !url.password) github = url.href;
    }
    // 技能自带的名字常常和市场的 identifier 不同（权威名称在包里），靠安装时落下的来源文件对齐。
    let marketIdentifier = "";
    try {
      const origin = JSON.parse(await readFile(join(dirname(skill.filePath), u.skillFile.marketFileName), "utf8")) as { identifier?: unknown };
      if (typeof origin.identifier === "string") marketIdentifier = origin.identifier.trim();
    } catch { /* 本地安装的技能没有来源记录，属正常情况 */ }
    return {
      name: skill.name,
      version: typeof metadata.version === "string" ? metadata.version.trim() : "",
      displayName: typeof metadata.displayName === "string" && metadata.displayName.trim() ? metadata.displayName : skill.name,
      description: skill.description,
      author: typeof metadata.author === "string" ? metadata.author : "",
      marketIdentifier,
      github,
    };
  }));
  res.json(success(items.sort((left, right) => left.name.localeCompare(right.name))));
});
