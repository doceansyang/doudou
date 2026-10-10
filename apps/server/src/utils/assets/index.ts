import { mkdir, realpath } from "@toonflow/file";
import { dirname, join } from "node:path";
import conf from "@/utils/conf";

export async function getAssetsDirectory() {
  const directory = join(dirname(conf.path), "assets");
  await mkdir(directory, { recursive: true });
  return realpath(directory);
}
