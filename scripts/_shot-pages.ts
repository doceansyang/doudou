/**
 * 截取界面页面，用于核对「项目」相关的三处显示是否统一。
 * 走独立浏览器访问本地服务，不影响正在运行的软件窗口。
 *
 * 跑法：cd toonflow && bun scripts/_shot-pages.ts
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = "scripts/_out";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const targets: Array<[string, string, number]> = [
  ["home", "#/home", 4500],
  ["workspace", "#/workspace", 6000],
];

for (const [name, hash, wait] of targets) {
  try {
    await page.goto("http://localhost:3000/" + hash, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(wait);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log("✓ 已截图", name);

    // 硬数据核对：助手面板是否真的停靠右侧且铺满高度（不靠看图猜）
    if (name === "workspace") {
      const box = await page.locator("#agentPanel").boundingBox().catch(() => null);
      const vp = page.viewportSize();
      if (box && vp) {
        console.log(`  面板 box: x=${box.x} y=${box.y} w=${box.width} h=${box.height}`);
        console.log(`  视口: ${vp.width}x${vp.height}  →  右边缘差=${vp.width - (box.x + box.width)}px  底边差=${vp.height - (box.y + box.height)}px`);
      }
    }
    // 工作区页再补一张「文档」视图：要检查文件树里是否还混着内部目录
    if (name === "workspace") {
      for (const selector of ['.el-segmented__item:has-text("文档")', 'div:has-text("文档")']) {
        try {
          await page.locator(selector).first().click({ timeout: 3000 });
          await page.waitForTimeout(3500);
          await page.screenshot({ path: join(OUT, `${name}-doc.png`) });
          console.log("✓ 已截图", `${name}-doc`);
          break;
        } catch { /* 换下一个选择器 */ }
      }
    }
  } catch (error) {
    console.log("✗ 截图失败", name, error instanceof Error ? error.message : error);
  }
}

await browser.close();
console.log("Done");
