import { prisma } from './prisma.js';

async function main() {
  console.log('Seeding Parallax Flow Multi-Tenant Database...');

  // 1. Roles
  const adminRole = await prisma.role.upsert({
    where: { key: 'ACADEMY_ADMIN' },
    create: {
      key: 'ACADEMY_ADMIN',
      name: 'Academy Administrator',
      description: 'Tenant-scoped administrative role',
    },
    update: {},
  });

  const studentRole = await prisma.role.upsert({
    where: { key: 'ACADEMY_STUDENT' },
    create: {
      key: 'ACADEMY_STUDENT',
      name: 'Academy Student',
      description: 'Enrolled student role',
    },
    update: {},
  });

  // 2. Users (Valid UUIDs)
  const userAdminA = await prisma.user.upsert({
    where: { email: 'admin@abcacademy.edu.in' },
    create: {
      id: '00000000-0000-4000-a000-000000000001',
      email: 'admin@abcacademy.edu.in',
      fullName: 'Prof. Ramesh Sharma',
      roleId: adminRole.id,
    },
    update: {},
  });

  const userAdminB = await prisma.user.upsert({
    where: { email: 'info@xyzinstitute.com' },
    create: {
      id: '00000000-0000-4000-a000-000000000002',
      email: 'info@xyzinstitute.com',
      fullName: 'Ananya Roy',
      roleId: adminRole.id,
    },
    update: {},
  });

  const studentA = await prisma.user.upsert({
    where: { email: 'rahul.verma@gmail.com' },
    create: {
      id: '00000000-0000-4000-a000-000000000101',
      email: 'rahul.verma@gmail.com',
      fullName: 'Rahul Verma',
      phone: '+91 98765 11111',
      roleId: studentRole.id,
    },
    update: {},
  });

  const studentB = await prisma.user.upsert({
    where: { email: 'priya.singh@gmail.com' },
    create: {
      id: '00000000-0000-4000-a000-000000000102',
      email: 'priya.singh@gmail.com',
      fullName: 'Priya Singh',
      phone: '+91 98765 22222',
      roleId: studentRole.id,
    },
    update: {},
  });

  // 3. Academies
  const academyA = await prisma.academy.upsert({
    where: { id: '00000000-0000-4000-b000-000000000001' },
    create: {
      id: '00000000-0000-4000-b000-000000000001',
      slug: 'abc-academy',
      name: 'ABC Academy of Commerce',
      email: 'contact@abcacademy.edu.in',
      phone: '+91 98765 43210',
      address: '104 MG Road, Indiranagar',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560038',
      status: 'ACTIVE',
      adminName: 'Prof. Ramesh Sharma',
      adminEmail: 'admin@abcacademy.edu.in',
    },
    update: {},
  });

  const academyB = await prisma.academy.upsert({
    where: { id: '00000000-0000-4000-b000-000000000002' },
    create: {
      id: '00000000-0000-4000-b000-000000000002',
      slug: 'xyz-institute',
      name: 'XYZ Professional Institute',
      email: 'info@xyzinstitute.com',
      phone: '+91 98123 45678',
      address: '42 Park Street',
      city: 'Kolkata',
      state: 'West Bengal',
      postalCode: '700016',
      status: 'ACTIVE',
      adminName: 'Ananya Roy',
      adminEmail: 'info@xyzinstitute.com',
    },
    update: {},
  });

  // 4. Memberships
  await prisma.academyMembership.upsert({
    where: { userId_academyId: { userId: userAdminA.id, academyId: academyA.id } },
    create: {
      userId: userAdminA.id,
      academyId: academyA.id,
      role: 'ACADEMY_ADMIN',
      status: 'ACTIVE',
    },
    update: {},
  });

  await prisma.academyMembership.upsert({
    where: { userId_academyId: { userId: userAdminB.id, academyId: academyB.id } },
    create: {
      userId: userAdminB.id,
      academyId: academyB.id,
      role: 'ACADEMY_ADMIN',
      status: 'ACTIVE',
    },
    update: {},
  });

  await prisma.academyMembership.upsert({
    where: { userId_academyId: { userId: studentA.id, academyId: academyA.id } },
    create: {
      userId: studentA.id,
      academyId: academyA.id,
      role: 'ACADEMY_STUDENT',
      status: 'ACTIVE',
    },
    update: {},
  });

  await prisma.academyMembership.upsert({
    where: { userId_academyId: { userId: studentB.id, academyId: academyB.id } },
    create: {
      userId: studentB.id,
      academyId: academyB.id,
      role: 'ACADEMY_STUDENT',
      status: 'ACTIVE',
    },
    update: {},
  });

  // 5. Courses
  const courseA1 = await prisma.course.upsert({
    where: { slug: 'ca-foundation-2026-abc' },
    create: {
      id: '00000000-0000-4000-c000-000000000001',
      academyId: academyA.id,
      slug: 'ca-foundation-2026-abc',
      code: 'CAF-101',
      name: 'CA Foundation Comprehensive Batch 2026',
      description: 'Complete coaching program for CA Foundation Accounting & Law.',
      status: 'ACTIVE',
    },
    update: {},
  });

  const courseB1 = await prisma.course.upsert({
    where: { slug: 'corporate-taxation-xyz' },
    create: {
      id: '00000000-0000-4000-c000-000000000002',
      academyId: academyB.id,
      slug: 'corporate-taxation-xyz',
      code: 'TAX-201',
      name: 'Advanced Corporate Taxation Masterclass',
      description: 'Practical corporate GST and Direct Tax practice course.',
      status: 'ACTIVE',
    },
    update: {},
  });

  // 6. Enrollments
  await prisma.academyCourseEnrollment.upsert({
    where: { studentId_courseId: { studentId: studentA.id, courseId: courseA1.id } },
    create: {
      academyId: academyA.id,
      studentId: studentA.id,
      courseId: courseA1.id,
      status: 'ACTIVE',
    },
    update: {},
  });

  await prisma.academyCourseEnrollment.upsert({
    where: { studentId_courseId: { studentId: studentB.id, courseId: courseB1.id } },
    create: {
      academyId: academyB.id,
      studentId: studentB.id,
      courseId: courseB1.id,
      status: 'ACTIVE',
    },
    update: {},
  });

  console.log('Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
