# Module 14 acceptance checklist (plan section 19)

Source of truth: `Aceva_Digital_System_Development_Plan_v2.docx`, section 19 "Module 14: Internal communication and team
collaboration", and `spec.md` section 9.14. Final company structure: Level 1 CEO / Founder / Owner (one person), Level 2
Director, Level 3 CTO, Level 4 Sales and Finance, Level 5 Developer / SQA. Comms admins (`comms.admin`): the Director
and the CTO. Publishers (`announcements.publish`): the CEO / Founder / Owner, the Director and the CTO.

**Status: BUILT, NOT YET ACCEPTED** (uncommitted on branch `cycle3-m13-m15`, on top of merge `51201eb`, waiting for the
project owner's review). Results: "Verification" at the end.

Words used: **Done** = built, and the "Verified by" column names the automated tests that check it. **Partly** = built,
with the limit stated. **Deferred** = not built, with the reason. **Production** = a deployment step, not code.

## Requirement by requirement

| # | Plan section 19 requirement | Status | Verified by |
|---|---|---|---|
| 1 | Direct messages and group chats | Done (M14.1/14.2) | `m14-messages`, `m14-live.spec` |
| 2 | Department channels, membership from the company hierarchy | Done (M14.1) | `m14-messages` |
| 3 | Project channels | Done: created from a real Module 5 project (`projectId`, its name and code) in the live dialog | `m14-links`, `m14-review.spec` (channels) |
| 3a | ...access based on project membership | **Deferred**: Module 5 has no project membership (`projects` is a plain list: code, name, client). Project channel members are added by hand by the comms admins and moderators | |
| 4 | Replies, reactions, mentions, editing, deletion with an audit record | Done (M14.1/14.2) | `m14-messages`, `m14-live.spec` |
| 5 | Delivery/read status | Done: per message (sent, delivered, read) with who, in DMs and groups (channels show no receipts, decision of M14.1) | `m14-collab.spec` (per-message status) |
| 6 | Online status according to company policy | Done: online/offline only (decision D8), shown only to people who share a DM or group | `m14-realtime`, `m14-live.spec` |
| 6a | Last-seen status | **Deferred**: no company policy exists; the owner chose online-only until one does | |
| 7 | Announcements, company-wide or selected teams; pinned; require acknowledgement | Done; acknowledgement progress for publishers only | `m14-announcements`, `m14-collab.spec` |
| 8 | File sharing with file-type and size limits | Done: PDF, PNG, JPEG, Word (.docx) recognised by content, at most 10 MB; 10 uploads a minute and 60 an hour per person | `m14-files`, `m14-file-safety`, frontend `logic.test` |
| 9 | Malware scanning | Done: ClamAV (clamd, INSTREAM) checks every upload in memory before it is stored; fail closed. Scan job: five attempts (about 2.6 hours), then the file sweep re-arms it at most every 6 hours until a check answers; the file stays unopenable meanwhile | `malware-scanner.test`, `m14-files`, `m14-file-safety` (stuck scan), `m14-clamav` (real ClamAV), `m14-collab.spec` and `m14-review.spec` (real ClamAV, outage and late check shown live) |
| 10 | Private storage and permission-checked download links | Done: private FileStorage; every download checked with the rules of the message or meeting and audited; a comms admin who only manages a channel gets none of its files | `m14-files`, `m14-file-safety`, `m14-collab.spec`, `m14-review.spec` |
| 10a | Files uploaded but never sent | Done: discarded after 24 hours (record kept, bytes removed); sent and meeting files are never touched; a send racing the discard is decided by the database | `m14-file-safety` |
| 11 | Notifications for new messages, mentions, replies and announcements | Done through the Module 12 core. **Channels notify mentions and replies only**; DMs and groups also notify new messages (one per conversation until read). No message text, agenda or notes in any notification | `m14-notifications`, `m14-announcements`, `m14-meetings`, `m14-collab.spec` |
| 12 | User controls for non-essential notifications | Partly, as the plan's notification settings and `spec.md` define them: each person switches the **email** of each non-essential type on or off; the notification itself always appears in the app (bell and `/notifications`), which the screen says. No in-app mute | `m14-notifications`, `m14-review.spec` (switch off: no email, still in the app; switch on: email) |
| 13 | Search and message history | Done: search (M14.1); "Load older messages" | `m14-messages`, `m14-collab.spec` |
| 14 | Saved messages, pinned messages | Done (M14.1/14.2); the pin list comes from the server | `m14-messages`, `m14-live.spec` |
| 15 | Links to related tasks or projects | Done: message to task and meeting to tasks, following Module 5's visibility rule (someone who may not see the task is told only that one is linked); project channels belong to Module 5 projects | `m14-links`, `m14-collab.spec`, `m14-review.spec` (meeting page) |
| 16 | Meetings: create, invite, date/time, agenda, notes, files | Done, with RSVP and cancel (reason); files added by the organizer | `m14-meetings`, `m14-files`, `m14-collab.spec`, `m14-review.spec` |
| 16a | Calendar integration | **Deferred**: the plan says it "can be added if approved"; there is no approval on record. The meeting page shows a disabled "Add to calendar" that says so | |
| 17 | Message only people and channels you may access; removing an employee disables access immediately | Done (M14.1/14.2) | `m14-messages`, `m14-live.spec` |
| 18 | Admins create channels and set moderators | Done: comms admins create department and project channels in the live dialog; a channel overview (`/messages/channels`) where a comms admin manages a channel, appoints moderators and archives it without reading its messages | `m14-messages`, `m14-collab.spec`, `m14-review.spec` (channels) |
| 19 | Admins manage retention | Done as **policy recording**: comms admins record management's periods (confirm again, reason, audited); everyone sees the policy in conversation details | `m14-retention`, `m14-review.spec` (retention card), frontend `logic.test` |
| 19a | Automatic removal after the retention period | **Deferred** (owner's decision): the periods are management's to set, and removal would also have to rewrite the insert-only older-version rows of edited messages, which needs a change to an existing database function. The screens and `GET /comms/policy` (`automaticRemoval: false`) say nothing is removed yet | |
| 20 | Admins review security/audit events | Done: comms admins read every Module 14 audit record and refusal on its routes on `/messages/channels` (`GET /comms/admin/audit`, filters and paging), metadata only. The general Module 4 activity search does not label `/comms` API routes as "Messages" (Module 4 is unchanged) | `m14-admin-audit` |
| 21 | Private conversations not exposed to general managers | Done: managers and admins get "not found" for DMs, groups and meetings and never read a channel they only manage; the audit view holds no content | `m14-messages`, `m14-meetings`, `m14-file-safety`, `m14-admin-audit` |
| 22 | HTTPS | **Production**: plain HTTP on 127.0.0.1 locally; HTTPS for the website, the API and `/socket.io` is a deployment requirement (`docs/SETUP.md`) | |
| 22a | Secure sessions, role-based access, rate limits, audit logs | Done: sessions (M2), permissions checked on the server, 30 messages a minute, 10 uploads a minute and 60 an hour, socket limits (M14.2), audit records without content | `m14-messages`, `m14-realtime`, `m14-file-safety`, `m14-admin-audit` |
| 23 | Do not use online status as a performance score | Done: never stored, never a metric | `m14-realtime` |
| 24 | Topic editing, moderator appointment/removal, archiving, moderator removal with a reason | Done (server M14.1; screens now), in groups and channels | `m14-collab.spec`, `m14-review.spec` |
| 25 | "Open topic" channels (in the earlier demo only) | **Not in the plan**: not offered in the live screens (every channel belongs to a department or project) | |

## Database

Five additive migrations after `20261120090000_m14_messaging`: `20261123090000_m14_announcements`,
`20261123100000_m14_meetings`, `20261123110000_m14_files`, `20261123120000_m14_links`,
`20261124090000_m14_file_safety`. No existing migration changed. Backup and rollback: `docs/SETUP.md`.

## Not runtime-tested

- The `clamav` service in `docker-compose.yml` (Docker is not installed on the development machine). Its image tag
  `clamav/clamav:1.5.5` was checked on Docker Hub and its healthcheck against the image's Dockerfile; the integration
  itself was tested with the same ClamAV version installed natively.
- The migrations on a populated database other than the test database.

## Verification (on aceva_test only; aceva_dev untouched)

| Check | Result |
|---|---|
| Backend full suite (`npx vitest run`, real PostgreSQL, Redis and ClamAV) | 93 files, **1538 / 1538** |
| Module 14 backend tests | `m14-messages`, `m14-realtime`, `m14-notifications` 5, `m14-announcements` 9, `m14-meetings` 8, `m14-files` 9, `m14-file-safety` 7, `m14-clamav` 2 (real ClamAV), `m14-links` 5, `m14-retention` 2, `m14-admin-audit` 3, `malware-scanner.test` 4 |
| Contracts | 55 / 55 |
| Frontend unit tests (`npm test -w frontend`) | 5 / 5 (`retentionNotice`, file limits live and demo) |
| Typecheck | backend 0 errors, frontend 0 errors |
| Lint | backend 0 problems; frontend 0 errors, 10 older warnings (unchanged) |
| Builds | backend `tsc` build and frontend production build (live modules incl. m14) |
| Migrations | 26 applied on aceva_test; database and `schema.prisma` identical (`prisma migrate diff`: empty) |
| Playwright `e2e/m14-review.spec.ts` (real ClamAV, clamd stopped and restarted by the outage test) | **5 / 5** |
| Playwright `e2e/m14-collab.spec.ts` (real ClamAV) | **9 / 9** |
| Playwright `e2e/m14-live.spec.ts` | 9 / 9 |
| Playwright `m12-live` + `m13-live` | 13 / 13 |

The Playwright specs ran one at a time on the final build. ClamAV used for the checks: the official portable ClamAV
1.5.5 for Windows (its Talos signature verified), clamd on 127.0.0.1:3310 only, stopped after the runs.
