import fs from "fs";
import path from "path";

const testDir = path.resolve("test");
const files = fs.readdirSync(testDir).filter(f => f.endsWith(".js"));

(async () => {
  for (const file of files) {
    console.log(`\n=== Running test: ${file} ===`);
    await import(path.join(testDir, file));
  }
})();
