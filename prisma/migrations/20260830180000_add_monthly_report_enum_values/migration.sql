-- PostgreSQL requires new enum values to be committed before they are used by
-- indexes or data statements. This compatibility migration intentionally runs
-- before the existing monthly-report pipeline migration; its IF NOT EXISTS
-- clauses also make it safe for databases where those values already exist.
ALTER TYPE "ContentEntityType" ADD VALUE IF NOT EXISTS 'MONTHLY_REPORT';
ALTER TYPE "LearningResourceType" ADD VALUE IF NOT EXISTS 'MONTHLY_REPORT';
