# Parallax Flow - Final Academy Admin Release Gate

Verification date: 2026-08-25 (Asia/Calcutta)

```text
ACADEMY ADMIN MODULE
====================
BACKEND PRODUCTION GATES PASSED
BROWSER VERIFICATION BLOCKED

R2 PRODUCTION GATE BLOCKED
```

This attempt stopped before any Cloudflare request because no R2 configuration could be proven disposable/non-production. No production R2 bucket, production API, production PostgreSQL database, or Supabase project was contacted. No application source, schema, migration, database record, or R2 object was modified.

## 1. R2 Environment

| TEST | EXPECTED | ACTUAL | STATUS |
| --- | --- | --- | --- |
| Active smoke-process configuration | All five R2 variables are present through secure process injection | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, and `R2_ENDPOINT` were all absent | **BLOCKED** |
| Bucket classification | Bucket name is explicitly disposable/test/staging/smoke | No active bucket was configured | **BLOCKED** |
| Existing backend environment | Any discovered credentials must be provably non-production before use | `server/.env` contains all five keys, but the bucket name is unclassified; values were not printed and the credentials were not used | **BLOCKED - SAFETY STOP** |
| Secret file tracking | Credential-bearing environment file is ignored and untracked | `.gitignore` ignores `server/.env`; `git ls-files` confirms it is untracked | **PASS** |
| Frontend credential exposure | No frontend R2 credential variables | No `VITE_*R2*` keys were found in frontend environment files; R2 credential references are backend-only | **PASS** |

Required configuration before retry:

```text
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET_NAME=parallax-flow-academy-admin-smoke-test (or another clearly disposable name)
R2_ENDPOINT
```

The temporary token must be restricted to the disposable bucket. Do not place these values in frontend variables or commit them.

## 2. Upload Verification

| TEST | EXPECTED | ACTUAL | STATUS |
| --- | --- | --- | --- |
| Academy Admin A creates the smoke folder hierarchy | `Smoke Test/Test Documents` persists through the Academy API | Not executed because the R2 environment and browser prerequisites failed | **BLOCKED** |
| Real PDF upload | Browser obtains a presigned URL, uploads one PDF, then finalizes metadata | Not executed; no R2 request was made | **BLOCKED** |
| Credential secrecy | Browser receives a signed URL but never raw R2 credentials | Static/environment checks pass, but the live network flow was not available | **UNVERIFIED LIVE** |

## 3. PostgreSQL Persistence

| TEST | EXPECTED | ACTUAL | STATUS |
| --- | --- | --- | --- |
| Uploaded content row | PostgreSQL stores the file, filename, hierarchy, MIME type, size, and scoped object key | No smoke record was created | **BLOCKED** |
| Refresh persistence | The real API returns the same persisted hierarchy after refresh | Browser/upload flow was not executed | **BLOCKED** |
| Existing database baseline | Disposable PostgreSQL schema and content persistence integration pass | Immediately preceding gate: 17 migrations current; deterministic seed twice; 49/49 integration tests with 0 skips | **PASS - BASELINE** |

## 4. R2 Object Verification

| TEST | EXPECTED | ACTUAL | STATUS |
| --- | --- | --- | --- |
| Object existence | One object exists in the dedicated disposable bucket | No approved disposable bucket was available | **BLOCKED** |
| Object scope and metadata | Key is course/page/folder scoped; size and MIME type match | Provider contract tests pass, but no live Cloudflare object was created | **UNVERIFIED LIVE** |
| Public access | Raw object URL is not public | No live object existed to probe | **BLOCKED** |

## 5. Student Download Verification

| TEST | EXPECTED | ACTUAL | STATUS |
| --- | --- | --- | --- |
| Authorized Academy A student | Entitled student receives a short-lived signed GET URL and the PDF | Not executed | **BLOCKED** |
| Secret and path minimization | Student receives no credentials and no unnecessary raw storage path | Automated API/provider tests pass; live browser/network verification was not executed | **UNVERIFIED LIVE** |
| Unauthorized student | Unentitled/cross-academy student receives no signed URL | Disposable-database tenant tests pass; live R2 request was not executed | **PASS - API BASELINE / UNVERIFIED LIVE** |

## 6. Signed URL Expiry Verification

| TEST | EXPECTED | ACTUAL | STATUS |
| --- | --- | --- | --- |
| Before expiry | Live signed URL returns the PDF | Not executed | **BLOCKED** |
| After expiry | The same URL is rejected after the configured TTL | Not executed | **BLOCKED** |
| Configured duration | Existing tested download TTL remains 300 seconds | Unit/provider contract tests verify 300-second signing; Cloudflare enforcement was not observed | **PASS - CONTRACT / UNVERIFIED LIVE** |

## 7. Delete Verification

| TEST | EXPECTED | ACTUAL | STATUS |
| --- | --- | --- | --- |
| Content lifecycle | Delete/archive changes PostgreSQL state according to the existing lifecycle | No smoke content was created | **BLOCKED** |
| R2 deletion | Only the smoke object is removed when physical deletion is required | No live object existed | **BLOCKED** |
| Post-delete authorization | No new signed URL can be generated for deleted content | Automated lifecycle tests pass; live R2 behavior was not executed | **UNVERIFIED LIVE** |
| Cleanup safety | No unrelated object or record is modified | The smoke stopped before mutations; nothing required cleanup | **PASS** |

## 8. Cross-Academy Isolation

| TEST | EXPECTED | ACTUAL | STATUS |
| --- | --- | --- | --- |
| Academy Admin A to Academy B students/courses/content/questions/broadcasts | HTTP 403 or 404; no foreign data returned | Passed in the 49-test disposable PostgreSQL integration suite | **PASS** |
| Manipulated course/content identifiers | No foreign metadata or signed URL | Passed at API/service boundary; no live R2 URL was requested | **PASS - API / UNVERIFIED LIVE R2** |
| Direct Academy B object attempt | Object remains inaccessible | No disposable R2 object was available | **BLOCKED** |

## 9. Client Academy-ID Tampering Test

| TEST | EXPECTED | ACTUAL | STATUS |
| --- | --- | --- | --- |
| Academy B ID in query | Server-derived Academy A context remains authoritative | Disposable integration passed | **PASS** |
| Academy B ID in body | Supplied tenant ID is ignored/rejected | Disposable integration passed | **PASS** |
| Academy B ID in headers | Supplied tenant ID cannot override membership | Disposable integration passed | **PASS** |
| Live R2 URL generation while tampering | No Academy B object is signed | Not executed without disposable R2 | **BLOCKED** |

## 10. Refresh Persistence

| TEST | EXPECTED | ACTUAL | STATUS |
| --- | --- | --- | --- |
| Upload then refresh | Folder/file remain after browser refresh | Not executed | **BLOCKED** |
| Navigate away and return | Content remains API/database backed | Not executed in a browser | **BLOCKED** |
| No mock/local-only persistence | Existing API and integration tests use PostgreSQL-backed services | Automated baseline passed | **PASS - BASELINE** |

## 11. Browser Verification

| TEST | EXPECTED | ACTUAL | STATUS |
| --- | --- | --- | --- |
| Browser availability | Connected in-app or extension browser | Browser discovery returned an empty list (`[]`) after the documented retry procedure | **BLOCKED** |
| Academy Admin six-module navigation | Overview, Students, Courses, Content, Questions, Broadcast load visually | Source/routes and automated tests pass; real visual navigation was not executed | **UNVERIFIED** |
| Excluded navigation | Packages, Orders, Coupons, Store, Store Merchandising, Academies, Revenue, Paid Content, and Paid Courses are absent | Source/routes confirm absence; visual check unavailable | **PASS - SOURCE / UNVERIFIED VISUAL** |
| Browser console/network | No broken route, secret exposure, or false-success response | No connected browser | **BLOCKED** |

## 12. Academy Admin RBAC

| TEST | EXPECTED | ACTUAL | STATUS |
| --- | --- | --- | --- |
| Exact allowed modules | Only Overview, Students, Courses, Content, Questions, Broadcast | Source audit and automated route/security tests pass | **PASS** |
| Commerce endpoints | Packages, Orders, Coupons, Store, and Store Merchandising return 403 | Disposable-database HTTP integration passed | **PASS** |
| Commercial creation | Paid/store content, store sections, packages, coupons, and promotional broadcasts are rejected/unmounted | Disposable-database integration passed | **PASS** |
| Super Admin regression | Super Admin retains authorized platform/commerce access | Disposable-database integration passed | **PASS** |
| Multiple Academy memberships | Academy context fails closed with HTTP 409 | Disposable-database integration passed | **PASS** |

## 13. Security Verification

| TEST | EXPECTED | ACTUAL | STATUS |
| --- | --- | --- | --- |
| Frontend dependency audit | No known vulnerabilities | 0 vulnerabilities in the immediately preceding gate | **PASS** |
| Production backend runtime audit | No vulnerable Prisma CLI/config tooling | Runtime image audit reported 0 vulnerabilities; `prisma`, `@prisma/config`, and `deepmerge-ts` are absent | **PASS** |
| Build/migration tooling disclosure | Do not hide the known advisory | Development/tooling tree still records the documented Prisma CLI/config `deepmerge-ts@7.1.5` chain | **PASS - DISCLOSED AND RUNTIME-ISOLATED** |
| Production isolation | No production/Supabase/R2 access | No external R2 request was issued and no production system was contacted | **PASS** |

## 14. Test Suite Results

These results were executed immediately before this smoke attempt; no application source, schema, migration, or dependency changed afterward.

| TEST | EXPECTED | ACTUAL | STATUS |
| --- | --- | --- | --- |
| Frontend tests | All pass | 100/100 across 18 files | **PASS** |
| Frontend typecheck | No errors | Passed | **PASS** |
| Frontend production build | Successful build | 2,103 modules transformed | **PASS** |
| Backend unit tests | All pass | 31/31, 0 skips | **PASS** |
| Full PostgreSQL integration | All pass with no manual skips | 49/49, 0 skips | **PASS** |
| Backend typecheck | No errors | Passed | **PASS** |
| Backend production build | Successful build | Passed | **PASS** |
| Prisma validation | Valid schema | Passed | **PASS** |
| Migration status | No pending migrations | 17 migrations; schema up to date | **PASS** |
| Runtime health baseline | Both endpoints return 200 | Production image returned 200 from `/health/live` and `/health/ready` | **PASS - BASELINE** |

## 15. Production Docker Verification

| TEST | EXPECTED | ACTUAL | STATUS |
| --- | --- | --- | --- |
| Image build | Multi-stage production image builds | Passed | **PASS** |
| Runtime identity | Non-root | Image user is `node` | **PASS** |
| Runtime dependency isolation | Prisma CLI/config and `deepmerge-ts` absent | Direct image inspection passed | **PASS** |
| Container health | Docker health check reaches `/health/ready` | Container reached `healthy` against disposable PostgreSQL | **PASS** |
| Health endpoints | Live and ready both return HTTP 200 | Passed | **PASS** |

## 16. Remaining Blockers

| TEST | EXPECTED | ACTUAL | STATUS |
| --- | --- | --- | --- |
| Disposable R2 credentials | Dedicated, minimum-permission, clearly non-production credential set | Not available in active environment; existing file-based bucket is unclassified and was not used | **R2 PRODUCTION GATE BLOCKED** |
| Disposable R2 live lifecycle | Upload/HEAD/GET/expiry/delete and cross-tenant denial | Not executed | **R2 PRODUCTION GATE BLOCKED** |
| Connected browser | In-app or extension browser available | No browser connection discovered | **BROWSER VERIFICATION BLOCKED** |
| Visual persistence and navigation | Complete real UI flow | Not executed | **BROWSER VERIFICATION BLOCKED** |

To resume safely:

1. Inject a dedicated temporary R2 credential set into the backend process environment, with a bucket name that is explicitly identifiable as disposable/non-production.
2. Confirm that the token is scoped only to that bucket.
3. Connect the in-app browser or browser extension and open `http://localhost:5173`.
4. Re-run this gate from Section 1. Do not reuse the unclassified `server/.env` credential set unless its non-production ownership and bucket scope are independently confirmed.
