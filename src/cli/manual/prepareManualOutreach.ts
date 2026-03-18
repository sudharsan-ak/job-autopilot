import fs from "fs";
import {
  getManualOutreachDir,
  getManualOutreachInputPath,
  getManualOutreachTemplate
} from "../../utils/manual/manualOutreach";

async function main() {
  const dir = getManualOutreachDir();
  const inputPath = getManualOutreachInputPath();

  if (!fs.existsSync(inputPath)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(inputPath, getManualOutreachTemplate(), "utf8");
    console.log(`Created manual outreach input file: ${inputPath}`);
    return;
  }

  console.log(`Manual outreach input file already exists: ${inputPath}`);
}

main().catch((error) => {
  console.error("prepareManualOutreach failed:", error);
  process.exit(1);
});
