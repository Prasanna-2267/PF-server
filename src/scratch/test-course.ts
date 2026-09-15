import { getAdminCourse } from '../services/adminCourseService.js';

async function main() {
  try {
    const result = await getAdminCourse('38cf980b-4288-4df8-8a2e-8181ef00913c');
    console.log('SUCCESS:', result);
  } catch (err: any) {
    console.error('EXACT ERROR NAME:', err?.name);
    console.error('EXACT ERROR MESSAGE:', err?.message);
    console.error('EXACT ERROR CODE:', err?.code);
    console.error('EXACT ERROR STACK:', err?.stack);
  }
}

main();
