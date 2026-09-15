import { prisma } from '../db/prisma.js';

async function main() {
  const settings = await prisma.contentLocationSetting.deleteMany({});
  const items = await prisma.contentItem.deleteMany({});
  console.log(`Deleted ${items.count} items and ${settings.count} location settings from database.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
