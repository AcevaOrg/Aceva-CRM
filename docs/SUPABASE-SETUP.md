# Supabase setup (database on Supabase, app on a VPS)

This guide moves the app's PostgreSQL database to Supabase. The backend API (NestJS) and the website (Next.js) run on a
VPS the company rents. It is written for the people who deploy: the project owner, a teammate and the QA engineer. You do
not need to be a database expert.

Checked against the Supabase and Prisma documentation on **2026-11-23**. The Supabase dashboard changes often, so a menu
name or position may differ from what is written here. Every dashboard path below comes from the official pages listed in
section 14. Where something could not be confirmed, the text says **Check** and tells you what to look at.

How to read the commands:

- **VPS (bash)**: run on the Ubuntu server, in an SSH session.
- **PC (PowerShell)**: run on a Windows computer.
- Words in angle brackets, like `<project-ref>` or `<db-password>`, are placeholders. Replace them with your own value.
  **Never write a real password, key or project reference into this file, into Git, or into a chat.** Keep them in the
  company password manager.
- **Never type a password into a command.** Anything typed at the prompt is saved in `~/.bash_history` and can end up in
  snapshots, copied logs and shared screens. This guide uses a hidden prompt (`read -rsp`), an editor (`nano`) or a
  helper script that asks for the password. If a password was typed into the shell by mistake, delete the line from
  `~/.bash_history` and change the password (12.2).
- **nano** is the text editor used for every file edit on the VPS. Type or paste the text. Press **Ctrl+O**, then
  **Enter** to save, and **Ctrl+X** to leave.

## Contents

1. What this guide does and does not do
2. Before you start
3. Create the project (staging)
4. Lock it down before any data goes in
5. Choose the connection and build `DATABASE_URL`
6. Database roles
7. Prepare the VPS and apply the migrations
8. The data
9. Prove it works
10. Backups and restore
11. Production
12. Running it
13. Troubleshooting
14. Sources

**Order of work:** the VPS and its user must exist before section 5.3. Do **7.0 and 7.1** first (first sign-in, user,
firewall, hardening), then sections 3, 4 and 5, then the rest of section 7.

### Words used in this guide

| Word | Meaning |
|---|---|
| API | The NestJS program (the backend). The website talks to it. |
| Emp-ID | A person's employee number, such as `ACV-0003`. It is the sign-in name. |
| Authenticator app, TOTP | The phone app (Google or Microsoft Authenticator) that shows a 6-digit code. It is the second step of sign-in. |
| argon2 | The way passwords are scrambled before they are stored. |
| Redis | A small, fast store on the VPS that holds a copy of each sign-in session. |
| Session | A signed-in browser. The cookie in the browser points to it. |
| Pooler, session pooler, transaction pooler | A Supabase gateway in front of the database. The session pooler (port 5432) keeps one database connection per client. The transaction pooler (port 6543) shares connections and is not used here. |
| Direct connection | Connecting to the database host itself, without the pooler. IPv6 only unless you buy an add-on. |
| Role, login | A database user. `postgres` owns everything. `aceva_api` and `aceva_backup` are limited users made in section 6. |
| Data API (PostgREST) | A web address Supabase builds from your tables. We switch it off. |
| Row-level security (RLS) | A database feature that hides rows from some users. Supabase can turn it on for every new table. |
| Migration | A file that changes the tables. `prisma migrate deploy` applies them in order. |
| Seed | A script that loads starting data. |
| Advisory lock | A database lock the migration tool takes so two migrations cannot run at once. |
| PITR | Point-in-time recovery: a Supabase add-on that restores the database to a chosen minute. |
| DNS `A` record | The DNS entry that points a domain name at the VPS's IPv4 address. |
| SPF and DKIM | DNS entries that prove a mail really comes from your domain. Without them mails land in spam. |
| systemd | The Ubuntu program that starts services and restarts them. A "unit" is its settings file. |
| cron | The Ubuntu scheduler that runs the nightly backup. |
| SSH, SSH tunnel | A secure sign-in to the VPS. A tunnel forwards a port of the VPS to your PC. |
| Deploy key | An SSH key that lets the VPS read the GitHub repository, and nothing more. |
| nginx | The web server in front of the site and the API. Also called a reverse proxy. |
| CORS, Origin | The browser's check of which web address a request comes from. The API accepts one exact address. |
| libpq URL | The form of database URL used by `psql` and `pg_dump`. |
| Root certificate | The file that proves that a database server really is Supabase. |
| age key | A pair of keys for encrypting backups. The public half encrypts. Only the secret half can decrypt. |

---

## 1. What this guide does and does not do

### 1.1 What Supabase is used for

Supabase is used **only as a managed PostgreSQL database**. Supabase looks after the server, the updates and the
backups. Nothing else of Supabase is used.

What stays ours:

- **Sign-in.** Passwords (argon2), the authenticator-app code (TOTP 2FA) and the sessions (Redis, with PostgreSQL as
  the permanent record) are all done by our backend. Supabase Auth is not used.
- **Permissions.** Every check of "may this person do this" is done by our backend (`AccessGuard`). The database
  does not decide who sees what. Row-level security is not used as our access control.
- **Files.** Documents, photos, task attachments and receipts are saved to a folder on the VPS (`FILE_STORAGE_ROOT`).
  Imported bank statements are read into database tables, and the file itself is not kept. Supabase Storage is not
  used, and Supabase backups do not contain the files in that folder.

What is switched off or never used:

- The **Data API** (the REST and GraphQL web address that Supabase builds from your tables). It is switched off
  in section 4, because all 91 tables live in the `public` schema, which that API would otherwise offer to the internet.
- Supabase **Auth**, **Realtime** and **Storage**. They keep running inside the project, so section 4.7 switches off
  what can be switched off.
- The Supabase keys (`anon`, `service_role`, publishable and secret keys). The app does not need any of them. Do not put
  them on the VPS. They stay valid anyway, so see 4.7.

### 1.2 Assumptions

- The VPS runs **Ubuntu 24.04 LTS** and has an **IPv4** address. (IPv6 may or may not work. This guide does not depend
  on it.)
- The VPS has at least **2 vCPU, 4 GB RAM** (or 2 GB plus a 2 GB swap file) and **20 GB disk**. It runs the API, the
  website, Redis and nginx (and Mailpit on staging), and it builds the website. These sizes are a starting point, not a
  measured figure. Run `free -h` before the first `npm run build`. If the build ends with `Killed`, the server is too
  small: add swap or choose a bigger plan. A swap file (VPS, bash):
  ```bash
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```
- The company is in Pakistan. Supabase has no Pakistan or Middle East region. The nearest is **South Asia (Mumbai)**
  (`ap-south-1`). The second choice is Southeast Asia (Singapore). **A region cannot be changed after the project is
  created.**
- Put the VPS in India (Mumbai) or as near to Mumbai as the provider allows. Every question the app asks the database
  makes a round trip. The demo data load alone makes hundreds of them, and most actions in the API run in a database
  transaction with a 5-second limit. A VPS on the other side of the world makes the app slow and makes those actions
  fail (section 7.6 and 13).
- Node.js 24 on the VPS (the repository says `>=22`; Prisma 7 needs 20.19, 22.12 or 24; the automatic checks in
  `.github/workflows/ci.yml` use 24).

### 1.3 The order

1. **Staging first.** A staging project with the demo data. You learn every step here, and you can throw it away.
2. **Production second.** A separate project, with real data. Staging and production must be **two separate Supabase
   projects**, because demo people can never be deleted from a database (the history tables are insert-only and an
   employee record cannot be removed). A database that has had the demo data can never become a production database.

> Production cannot go live yet. The repository has no way to create the first real users and the reference data
> (levels, roles, permissions, duties). See section 8.2. This is an open item for the team.

### 1.4 What this guide decides for you

| Question | Decision |
|---|---|
| Which connection from the VPS? | The **session pooler**, port **5432**, on the pooler host. Not the direct host (IPv6 only), not the transaction pooler (port 6543). |
| Database users | **Owner** `postgres.<project-ref>`: runs migrations and seeds. Its password is typed when `~/aceva-db.sh` asks for it and is **never stored on the VPS**. **API:** the limited login `aceva_api` (6.3). It is **required for production**. Staging may start with the owner login to get going, and switches before real use. **Backups:** the read-only login `aceva_backup` (6.4). |
| VPS users | You sign in as `aceva` (admin and deploy). The API runs as `aceva-api` and the website as `aceva-web`. Neither can read the other's files. The API's settings are in `/etc/aceva/api.env`, readable by root only (7.1, 9.3). |
| Certificate checking | On, with the Supabase root certificate saved on the VPS at `/etc/aceva/supabase-ca.crt`. |
| URLs | `DATABASE_URL` (the API's login) in `/etc/aceva/api.env`. The owner URLs for migrations and seeds are built in memory by `~/aceva-db.sh`. Section 5.4 explains why. |
| Data API | Off, and the Data API roles lose all rights on our tables. |
| Time zone | UTC, set on the database and on the logins, and checked. |
| Tests | Never against Supabase (section 9.8). Tests stay on the local PostgreSQL. |

Read section 9.8 ("Never run these") before anyone types a command on the production server.

---

## 2. Before you start

### 2.1 Accounts and people

1. Create the Supabase account with a company e-mail address, not a personal one. Turn on two-step sign-in for every
   person who has a Supabase login (see the account settings; the menu name may differ). Do the same for the VPS
   provider's account: its panel can open a console or take snapshots, and both contain every secret on the server.
2. Create **two organizations**: one for staging and one for production (a Free staging project needs its own
   organization, see 2.2).
   - **Every member of an organization can read all of its data** through the SQL Editor and Table Editor, as the
     `postgres` login. That access bypasses the app's permission checks and its audit log. Any Owner can also delete a
     project together with all its Supabase backups.
   - The **production organization** has only the owner and one administrator. Teammates and the QA engineer belong to
     the staging organization only.
   - Only Owners and Administrators can change the SSL and network settings.
   - If Organization settings offer a requirement for two-step sign-in (MFA) for all members, turn it on (**Check**:
     the menu name and the plans may differ).
   - Write the members of each organization in 2.4. Review the list every quarter. When someone leaves, remove them
     from the organization and change the database password (12.2).
3. You also need: the VPS (root or sudo access, the public IPv4 address), a domain name for the website, access to the
   GitHub repository (a read-only deploy key is enough, section 7.3), an SMTP service for production mail, and the
   company password manager. **The VPS must be prepared (7.0 and 7.1) before you reach section 5.3.**

### 2.2 Which plan, and what it costs

Prices below were read on 2026-11-23 from the Supabase pricing and billing pages. They change. Check
https://supabase.com/pricing before you pay.

| | Staging | Production |
|---|---|---|
| Plan | **Free** is acceptable for demo data only. Pro is easier. | **Pro. Never Free.** |
| Compute | Nano (Free) | Start with **Micro** (10 USD a month, covered by the 10 USD compute credit that Pro includes). Small is 15 USD. |
| Base price | 0 | 25 USD a month |
| Backups | **None** on Free | Daily, kept 7 days |
| Point-in-time recovery | No | Add-on: about 100 USD a month for 7 days (14 days about 200, 28 days about 400) |
| Database size | 500 MB on Free | See the pricing page |
| Data transfer (egress) | 5 GB on Free | 250 GB included, then 0.09 USD per GB. Pooler traffic counts. |
| IPv4 add-on | Not needed | Not needed. (It costs about 4 USD a month and only helps the direct connection.) |

Why the Free plan is not for production:

- A Free project is **paused after about a week of low activity**. Supabase counts database requests from a connected
  application as activity, and says a few requests a day are normally enough. The running API reads the database all
  day (the event dispatcher every 5 seconds, the job runner every 30 seconds), so staging should not pause. If it does,
  press **Resume project** (possible for up to 1 year after the pause).
- It has **no automatic backups**.
- It is limited to 500 MB. The payroll, ledger and audit history grow all the time.
- A paused database stops payroll runs, reminders, mails and sign-in.

Money notes:

- **Point-in-time recovery (PITR)** is recommended for production, because payroll and ledger data cannot be typed in
  again. It lets you restore to a chosen minute, with at most about 2 minutes of loss. Turning it on **stops the daily
  backups** (PITR replaces them). It is not covered by the spend cap. The owner decides whether the cost is worth it.
  Our own nightly dump (section 10) is useful either way.
- Pro has a **spend cap**, on by default. It does **not** cover compute, the IPv4 add-on, PITR or custom domains.
- Plans belong to an organization, not to a single project. A Free staging project needs its own organization on the
  Free plan, because Supabase does not allow Free and paid projects in one organization. A Free project can be moved to
  a paid organization later by project transfer. You are entitled to two active Free projects.
- Paid projects are never paused. An unpaid invoice can pause projects.
- Add the cost of the VPS, the domain and the SMTP service to the budget.

### 2.3 Password manager

Create one folder in the company password manager for each environment (staging, production). Put these in it, and
nowhere else:

- the Supabase database password of the owner login (letters and digits only, 32 characters; see 3.2),
- the passwords of the logins `aceva_api` and `aceva_backup` (6.3 and 6.4),
- the Redis password, the demo password (staging), the SMTP login,
- `DATA_ENCRYPTION_KEY` (see below),
- the backup secret key of that environment (section 10).

`DATA_ENCRYPTION_KEY` encrypts the 2FA secrets, CNIC numbers and bank account numbers in the database. The key is not in
the database. **A database backup without this key cannot be read.** Make a separate copy of it in the password manager
the day you create it, and never change it on a live database (key rotation is not built).

### 2.4 Information to write down

Fill this in as you go (in the password manager, not in this file):

| What | Where it comes from | Written down |
|---|---|---|
| Organization and project name | Step 3 | |
| `<project-ref>` | Project Settings, or the Connect dialog | |
| Region | Step 3 | |
| `<pooler-host>` | Connect dialog (never guess it) | |
| Database password | Step 3.2 | in the password manager |
| SHA-256 fingerprint of the certificate file | Step 5.3 | |
| VPS public IPv4 address | VPS provider panel | |
| Domain name of the site | DNS | |
| Members of each Supabase organization (review every quarter) | Organization settings | |
| Who is Owner and Administrator in Supabase | Organization settings | |

---

## 3. Create the project (staging)

### 3.1 The form

1. Sign in to the Supabase dashboard, choose the staging organization, and press **New project**.
2. **Project name:** `aceva-staging` (production will be `aceva-production`).
3. **Database password:** see 3.2.
4. **Region:** choose **South Asia (Mumbai)**. Choose the specific region. Do not choose one of the "general regions"
   (they let Supabase pick for you).
5. **Compute size:** Micro (or Nano on Free).
6. **Postgres version:** keep the default. New projects use **Postgres 17**, which is the version used by the local
   development database (`docker-compose.yml`). If the form lets you choose, choose 17.
   > Check: the exact minor version (17.x) is not fixed. Write down what `select version();` says after step 7.
7. **Data access / security options** (the names may differ):
   - untick **Enable Data API**,
   - untick **Automatically expose new tables** (called "Automatically expose new tables and functions" in some
     places),
   - leave **Enable RLS on new tables automatically** ticked. It makes a new table refuse every role except its owner.
     (This matters only for the logins in section 6.) If the form has no such option, skip it. 6.3 step 4 covers both
     cases.
8. Create the project. Wait until it says it is ready.

### 3.2 The database password

1. Make the password in the password manager: **letters and digits only, 32 characters.** Letters and digits need no
   special treatment inside a URL. Special characters (`@ : / ? # & %` and spaces) break the URL unless they are written
   as `%40 %3A %2F %3F %23 %26 %25 %20`. Avoiding them removes a whole group of errors.
2. Paste it into the form. Supabase never shows it again after creation. If you lose it, you reset it (section 12.2).

---

## 4. Lock it down before any data goes in

Do this now, while the database is empty.

### 4.1 Switch off the Data API

1. Dashboard, **Integrations**, **Data API**, tab **Overview**, turn **Enable Data API** off.
   (An older page of the Supabase docs says Project Settings, API. Use whichever your dashboard has.)
2. Open the tab **Settings** (Integrations, Data API). The list of exposed schemas should be empty. (The dashboard
   treats the Data API as on while that list is not empty. Supabase does not document this. The curl test in 7.8 is the
   proof.)

With the switch off, Supabase says the generated REST web address stops answering, whatever the table rights are.

### 4.2 Take away the Data API roles' rights (do this even though the Data API is off)

The Security Advisor (4.6) looks at the **rights** as well as at the exposed-schema list. Supabase made "not exposed by
default" the default for new projects from 2026-05-30, and says it applies to existing projects from 2026-10-30. The
documentation page on default rights still lists the old defaults, so do not rely on the change. Even with
"Automatically expose new tables" switched off, Supabase keeps the rights `truncate`, `references`, `trigger` and
`maintain` on new tables. The revokes below are needed in every case.

Dashboard, **SQL Editor**, new query, run:

```sql
-- Tables, sequences and functions that our migrations create later (the migrations run as postgres)
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role;

-- Anything that already exists in public (nothing yet, but harmless)
revoke all on all tables    in schema public from anon, authenticated, service_role;
revoke all on all sequences in schema public from anon, authenticated, service_role;
revoke all on all functions in schema public from anon, authenticated, service_role;
```

Check what is left. This must return **no rows** (run it again after the migrations in 7.8):

```sql
select r.rolname, count(*) as open_objects
from pg_roles r
cross join pg_class c
join pg_namespace n on n.oid = c.relnamespace
where r.rolname in ('anon', 'authenticated', 'service_role')
  and n.nspname = 'public'
  and c.relkind in ('r', 'p', 'v', 'm', 'f')
  and has_table_privilege(r.rolname, c.oid, 'select,insert,update,delete,truncate,references,trigger')
group by r.rolname;
```

(The list is for Postgres 17 and also works on older versions. Postgres 17 has one more right, `maintain`. You may add
it to the list.)

Also check that nobody can create objects in the schema. Every row must say `false`:

```sql
select r.role_name, has_schema_privilege(r.role_name, 'public', 'create') as can_create_in_public
from unnest(array['anon', 'authenticated', 'service_role']) as r(role_name);
```

If any row says `true`, run `revoke create on schema public from public, anon, authenticated, service_role;` and run the
check again. (6.3 adds `aceva_api` to this check.)

> Check: tables created by `postgres` follow the default rights above. The rule that tables created by another role get
> no rights for `anon` is an inference from how PostgreSQL works. It was not tested. The query above is the proof.

GraphQL uses the same database roles as the REST API, so removing their rights covers it too.

### 4.3 Enforce SSL

1. Dashboard, **Database Settings** (also called Database, Settings), section **SSL Configuration**, turn on
   **Enforce SSL on incoming connections**. Only an Owner or Administrator sees it.
2. Applying it reboots the database. Supabase's page says both "fast" and "a few minutes of downtime", so plan for a few
   minutes. Do it now while the database is empty. On production, do it in the maintenance window. It covers the
   database and both poolers. By default (before you do this) the database accepts connections without SSL.

### 4.4 Allow only the VPS (network restrictions)

Do this if your plan has the section. If it does not, skip to 4.5 and rely on the strong password, SSL and the
certificate check.

1. Find the VPS public IPv4 address (VPS provider panel, or on the VPS: `curl -4 https://api.ipify.org`).
2. Dashboard, **Database Settings**, **Network Restrictions** (Owner or Administrator). If the section is missing from
   Database Settings, first open **Project Settings**, **General**, and upgrade the Postgres version (do it now, while
   the database is empty, because it takes the project offline for a while). If the section is still missing after
   that, ask Supabase support whether your plan includes it.
   > Check: no official page lists which plans include Network Restrictions. If staging on Free does not have it,
   > production (Pro) must have it, and you tell the team. If Pro does not have it either, production is blocked until
   > Supabase answers.
3. Add the VPS IPv4 address as `<vps-ip>/32`. Admins sign in to the VPS with SSH and run `psql` there, so the list
   holds **only the VPS address**. Add a static office address only if it is truly needed, never a home address (home
   addresses in Pakistan are often shared between many customers, or change). Remove an address when the work is done.
   (The dashboard's SQL Editor is probably not affected by this list, because the editor runs over HTTPS. This is
   inferred. Test it once.)
4. Save.

Warnings:

- The list **replaces** the old one when you save it (and the command-line tool replaces it unless you add `--append`).
  If you forget the VPS address you lock the VPS out.
- It covers the database and the poolers. It does not cover the dashboard or the HTTPS addresses.
- The shared pooler is IPv4. If you later use the direct connection over IPv6, you must also add the VPS IPv6 address.
- If the VPS address ever changes, change it here first.
- **Production has its own VPS** (11.1). Its address is the only server address in the production list. Never share a
  VPS with staging, because the list would then admit every staging process too.

### 4.5 Keep the database time zone at UTC

The app asks for UTC on every connection (`-c TimeZone=UTC`). **Supabase's pooler silently drops that request**, in both
session and transaction mode (Supavisor issue 1272). Supabase databases are in UTC by default, but do not rely on a
default. Set it explicitly. In the SQL Editor:

```sql
alter database postgres set timezone to 'UTC';
alter role postgres set timezone to 'UTC';
```

> Check: if the second line is refused, the first line is enough. You prove the result in 9.4.

Newer versions of the pooler send a harmless NOTICE on every connection saying the option was ignored. That is not an
error.

### 4.6 The Security Advisor

1. Dashboard, **Advisors**, **Security Advisor**. Run it now, and again after 4.2 and after the migrations (7.8).
   The dashboard may show a rule by its name instead of its number. The numbers below are Supabase's lint numbers.
2. Must be clear: any **ERROR** about a table without row-level security that anyone can read (rule 0013, "RLS
   disabled in public"), or about sensitive column names such as `password` or `token` being exposed (rule 0023). The
   rule 0013 fires only when the schema is in the exposed list and `anon` or `authenticated` can read the table, so the
   revokes in 4.2 clear it either way, and 3.1 turns row-level security on for new tables. If an error stays, write its
   name in section 11.3 and **stop before production**.
   > Check on a real staging project: the exact names the dashboard shows.
3. May stay (not blockers): warnings that a function has no fixed `search_path` (rule 0011; our migration functions do
   not set one) and notes about tables without a primary key. Do not edit migrations to silence them. Write them in the
   team's list of later hardening.

### 4.7 Switch off what the app does not use

Keeping the Supabase keys off the VPS does not switch the Supabase services off. Auth and Storage keep running, and the
keys stay valid. Anyone who gets a key (from the dashboard, or from a pasted screenshot) could create Auth users, which
sends mails from the project, or use Storage at the company's cost.

1. Dashboard, **Authentication**: turn off new sign-ups, and turn off every sign-in provider (e-mail, phone, social).
   > Check: the menu names differ between dashboard versions, and no page in section 14 covers this. Look for the
   > setting that lets new users sign up and for the list of providers.
2. Dashboard, **Storage**: there must be no buckets.
3. Never create a secret key (`sb_secret_...`). The app does not need one.
4. After 7.8 has passed, open **Settings**, **API Keys**. If it offers to disable the legacy `anon` and `service_role`
   keys, disable them. (Check: the menu names may differ. The new publishable key stays and is harmless: with the Data
   API off it opens nothing.)

---

## 5. Choose the connection and build `DATABASE_URL`

### 5.1 Which connection

Supabase offers four ways in:

| Way | Host and port | Works from an IPv4-only VPS? | Use |
|---|---|---|---|
| Direct | `db.<project-ref>.supabase.co`, 5432, user `postgres` | **No.** IPv6 only, unless you buy the IPv4 add-on (Pro, about 4 USD a month). The add-on is not dual-stack. It swaps the IPv6 record for an IPv4 record. | Not used |
| **Session pooler** | `<pooler-host>`, **5432**, user `postgres.<project-ref>` | **Yes** (every plan) | **Everything: the API, seeds, migrations, backups** |
| Transaction pooler | `<pooler-host>`, 6543, user `postgres.<project-ref>` | Yes | **Never.** It does not support session-level locks (migrations take one), prepared statements or session settings. |
| Dedicated pooler | `db.<project-ref>.supabase.co`, 6543 | No (IPv6 only without the add-on) | Not used |

The session pooler keeps one database connection per client for the whole session. That is what Prisma's migration lock
needs. It is also what Supabase's own Prisma guide uses for servers. Our app's own locks are all transaction-level
(`pg_advisory_xact_lock`), which works everywhere.

### 5.2 Get the host and the user name from the dashboard

1. Dashboard, press **Connect** at the top of the project page. Choose the **Session pooler** connection string.
2. It looks like this (placeholders):
   `postgresql://postgres.<project-ref>:<db-password>@<pooler-host>:5432/postgres`
3. Copy the host and the user from the dashboard. **Do not build the host yourself.** It looks like
   `aws-<n>-<region>.pooler.supabase.com`, and `<n>` is a server group number (you will see `0` in some examples and
   `1` in others), not part of the region.
4. The user name must be `postgres.<project-ref>` with the dot and the project reference. Without the reference you get
   `Tenant or user not found`.

### 5.3 Put the Supabase certificate on the VPS

**Do sections 7.0 and 7.1 first.** This step needs the user `aceva` on the VPS.

The VPS must check that it is really talking to Supabase. Node does not trust the Supabase certificate by default, so
the file has to be given to it.

1. Dashboard, **Database Settings**, section **SSL Configuration**, press **Download certificate**. The file is the
   Supabase root certificate, usually named `prod-ca-2021.crt`. (One Supabase page calls it `prod-supabase.cer`. It is
   the same download.)
2. Copy it to the VPS. **PC (PowerShell)**. First look at the real file name:
   ```powershell
   Get-ChildItem $HOME\Downloads -Filter *.crt
   ```
   Use the file name you see in the next command (below it is `prod-ca-2021.crt`). `scp` asks for your key passphrase
   (or the VPS login password):
   ```powershell
   scp "$HOME\Downloads\prod-ca-2021.crt" aceva@<vps-ip>:/home/aceva/supabase-ca.crt
   ```
3. **VPS (bash):**
   ```bash
   sudo mkdir -p /etc/aceva
   sudo install -m 644 -o root -g root ~/supabase-ca.crt /etc/aceva/supabase-ca.crt
   rm ~/supabase-ca.crt
   openssl x509 -in /etc/aceva/supabase-ca.crt -noout -subject -issuer -enddate -fingerprint -sha256
   grep -c 'BEGIN CERTIFICATE' /etc/aceva/supabase-ca.crt
   ```
4. Look at the result:
   - The subject should name **Supabase Root 2021 CA**.
   - Write down the SHA-256 fingerprint. Staging and production must give the same one.
   - The `grep` should print `1`. If the file holds more than one certificate, the **root certificate must be first**
     (the Prisma migration tool reads only the first).
   - Put the `notAfter` date in the team calendar, six months ahead of it. Community reports say about 2031. That date
     is not on an official page.
5. The file may be readable by everyone, because a certificate is public. It must stay in this one place. The API
   re-reads the file every time it opens a connection, and a missing or unreadable file stops the connection.

### 5.4 The two URLs

Two different programs read the database URL:

- **node-postgres** (`pg`) reads it for the API and the seeds.
- **Prisma's own migration program** (the schema engine, written in Rust) reads it for `prisma migrate deploy`.

The backup script is a third program. It uses `pg_dump` (libpq), which reads the `PG...` variables and `~/.pgpass`
instead of this URL (10.2).

The two URL readers understand the SSL parts of the URL differently, and Prisma 7 has no separate "direct URL". So this
guide uses **two URLs with the same password**:

| Setting | node-postgres (API, seeds) | Prisma migration program |
|---|---|---|
| `sslmode=verify-full` | Full check of certificate and host name | Read as "TLS if possible". **Does not check the certificate by itself.** |
| `sslrootcert=<file>` | The certificate to trust | Ignored |
| `sslmode=require` | Treated as `verify-full`, with a warning. Changes meaning (no check) in the next major version of `pg`. | TLS required |
| `sslaccept=strict` | Ignored | **Check the certificate.** The default without it is not to check. |
| `sslcert=<file>` | A client certificate (not what we want) | The certificate to trust |

The Prisma column comes from the engine's source code (`quaint/src/connector/postgres/url.rs`, and the same strings are
in the installed 7.10.1 engine), not from Prisma's documentation. Prisma's own page lists only `sslmode` and an
`sslcert` example. Re-check it after every Prisma upgrade (12.5 runs the tests in 7.6 step 3).

The two URLs (replace the placeholders; the password needs no encoding if it is letters and digits):

```
App URL (API and seeds):
postgresql://<login>.<project-ref>:<password>@<pooler-host>:5432/postgres?sslmode=verify-full&sslrootcert=/etc/aceva/supabase-ca.crt

Migrate URL (migrations only, owner login):
postgresql://postgres.<project-ref>:<db-password>@<pooler-host>:5432/postgres?sslmode=require&sslaccept=strict&sslcert=/etc/aceva/supabase-ca.crt
```

Where they live, and why:

- The **app URL for the API** goes into `/etc/aceva/api.env` (7.4), a file only root can read. The `<login>` in it is
  `aceva_api` for production (6.3). Staging may start with `postgres` (see 6.2).
- The **migrate URL**, and the app URL for the seeds, are **built in memory** by `~/aceva-db.sh` (7.5) at the moment you
  run them, from the owner password you type. They are never saved in a file, and never in the API's settings.
- The reason: the owner login can drop tables, switch off the insert-only triggers that protect the audit, payroll and
  ledger history, and wipe everything with `npm run db:reset -w backend`. If its password sat in a file the API loads, a
  compromised API would have owner rights. Only when no owner password is on the server does a leak of the API's
  settings stop short of that.
- The app needs **no code change** for SSL. The parameters go in the URL, and the URL wins over the settings in the
  code.
- `backend/prisma.config.ts` reads only `DATABASE_URL`, and a variable that is already set in the shell wins over any
  `.env` file. The helper uses that: it sets `DATABASE_URL` for one command.
- **Run migrations only through `~/aceva-db.sh`. Never type a URL that contains a password at the prompt.** A plain
  `npm run db:migrate` with the app URL would work, but the connection would be encrypted and **not checked**, with no
  error to tell you. If a password was typed into the shell, delete it from `~/.bash_history` and change it (12.2).
- **Never use `sslmode=no-verify`, `sslaccept=accept_invalid_certs` or `uselibpqcompat=true` while the real password is
  in the URL**, and never `sslmode=require` in the app URL. A certificate error is exactly the case where someone may be
  between you and the server (a wrong host, a hijacked DNS entry). A fake server could then ask for the password and
  receive it. To find out whether the certificate is the cause, use the check in 5.6. It sends no password.
- Do not add `pgbouncer=true`. It is for the transaction pooler and old Prisma. We do not use either.

> Check: the Prisma migration program was tested against a local fake server on Windows, not against Supabase and not
> on Linux. Step 7.6 proves on your VPS that the certificate check really happens. A one-URL form also exists
> (`sslmode=verify-full&sslrootcert=...&sslaccept=strict&sslcert=...`, same file twice). It is less tested, so use the
> pair.

If the password has special characters, encode them, or reset it to letters and digits (12.2).

### 5.5 Where the value goes

- In `/etc/aceva/api.env` on the VPS. It is created in step 7.4, owned by root, mode `600`. It is not in the repository
  folder, so it can never be committed.
- **There is no `backend/.env` on the server.** The API reads `backend/.env` only if the file exists, and a real
  environment variable always wins. A `backend/.env` would be readable by the services, and `npm run db:reset` reads
  the database address from it. Without the file, a command typed by mistake stops with "DATABASE_URL is not set".
- Keep a copy of the settings in the password manager. Do not paste them into chat or tickets.
- Staging and production each have their **own** settings file, **each on its own VPS** (section 11).

### 5.6 Check the certificate and the network from the VPS (no password needed)

**VPS (bash):**

```bash
openssl s_client -starttls postgres -connect <pooler-host>:5432 -servername <pooler-host> \
  -CAfile /etc/aceva/supabase-ca.crt -verify_hostname <pooler-host> -verify_return_error </dev/null 2>&1 \
  | grep -E 'Verif|subject=|issuer='
```

The result should say `Verification: OK` or `Verify return code: 0 (ok)`. Community tests (not an official page) show the
chain `*.pooler.supabase.com`, then `Supabase Intermediate 2021 CA`, then `Supabase Root 2021 CA`.

Known issue: tools that turn on strict X.509 checks (Python 3.13 and later, `openssl ... -x509_strict`) reject the
pooler's intermediate certificate, which has no key-usage field (Supabase issue 50862, open). Node, `psql` and Prisma in
this guide are not affected. Do not switch to `no-verify` because of it.

If it fails, the problem is the network or the certificate file, not the password. See section 13. If 5.6 fails, stop
and compare the host and the certificate fingerprint with 2.4.

---

## 6. Database roles

### 6.1 What the repository needs

- The migrations contain **no** `CREATE ROLE`, `GRANT`, `REVOKE`, `OWNER TO`, `CREATE EXTENSION`, event trigger or
  `SECURITY DEFINER`. They use only normal PostgreSQL: tables, enums, plpgsql functions, triggers (including deferred
  constraint triggers), 7 sequences, `gen_random_uuid()` and partial unique indexes. Nothing is on Supabase's list of
  things the `postgres` role cannot do.
- So **the role that runs the migrations owns every table, sequence and function.** Whoever runs `migrate deploy`
  becomes the owner.
- The `postgres` role on Supabase is not a full superuser, but it can do everything these migrations do.
  > Check: Supabase does not publish a list that names these features. The first migration run on staging is the proof.

### 6.2 Which login does what

| Login | Used by | Password kept |
|---|---|---|
| `postgres.<project-ref>` (the owner) | migrations and seeds, through `~/aceva-db.sh` | **Nowhere on the VPS.** Typed when the helper asks. In the password manager. |
| `aceva_api.<project-ref>` (6.3) | the running API | In `/etc/aceva/api.env` (root only). |
| `aceva_backup.<project-ref>` (6.4) | the nightly dump | In `~/.pgpass` of the admin user (mode 600). |

The name `aceva_api` is chosen on purpose. The local development database has its own administrator login (see
`backend/.env.example`). It is not a Supabase login and has nothing to do with these.

**This differs from the quick start of the Supabase Prisma guide** (one login for everything), and it follows
`docs/SETUP.md`, which says that in production the app uses a limited user:

- **Staging** may start with the owner login in `/etc/aceva/api.env`, to get to a working system in few steps. Then do
  6.3 on staging, run the full screen round with `aceva_api`, and keep it.
- **Production must go live with `aceva_api`** (6.3), once the same commit has passed a full staging round with it.
  This is a "before the day" item in 11.2. The owner password never goes into the file the API loads. If it did, a
  compromised API could drop tables or switch off the triggers that protect the audit and ledger history.

Two things follow:

- A login is protected by the strong password, SSL, the certificate check and (if your plan has them) the network
  restrictions.
- The pool of 15 backend connections is counted **per login** (section 12.3).

### 6.3 The login for the running API (required for production)

A separate login that can only read and write rows helps only when the owner password is **nowhere** in the API's
settings (5.4). Then a leak of those settings cannot be used to drop tables or to rewrite history. Run it on staging
first, **after staging has passed section 9**, and on production only
**after the same commit has run on staging through a full round of sign-in and screen testing**. Run it **after the
migrations** (7.7), because it names the migration table. If anything fails, go back to the owner login on staging.
Nothing here has been run against this repository yet.

It works through the session pooler with a user name of the form `<role>.<project-ref>`. The tables stay owned by
`postgres`. Migrations keep using `postgres`.

1. **VPS (bash)**, connect as `postgres`. It asks for the password:
   ```bash
   export PGSSLMODE=verify-full PGSSLROOTCERT=/etc/aceva/supabase-ca.crt
   psql -h <pooler-host> -p 5432 -U postgres.<project-ref> -d postgres
   ```
   (`psql` comes with the PostgreSQL 17 client from section 7.2.)
2. In `psql`, make the login. `\password` asks for the password without saving it in the history. Use a new strong
   password from the password manager, letters and digits only:
   ```sql
   create role aceva_api with login;
   \password aceva_api
   ```
3. Give it only what the app needs. **No** `create` on the schema, **no** `TRUNCATE`:
   ```sql
   alter role aceva_api set timezone to 'UTC';
   grant usage on schema public to aceva_api;
   grant select, insert, update, delete on all tables in schema public to aceva_api;
   revoke all on table public._prisma_migrations from aceva_api;
   grant usage, select on all sequences in schema public to aceva_api;
   -- tables and sequences that later migrations create (the migrations run as postgres)
   alter default privileges for role postgres in schema public grant select, insert, update, delete on tables to aceva_api;
   alter default privileges for role postgres in schema public grant usage, select on sequences to aceva_api;
   ```
   Functions can be run by everyone by default. Nothing else is needed. The app creates no tables while it runs, uses
   `FOR UPDATE` (needs `UPDATE`) and sequences in column defaults (needs `usage` and `select` on them).
   Then run the schema check from 4.2 again, with `aceva_api` added to the list in the second query. It must say
   `false` for every role, `aceva_api` too:
   ```sql
   select r.role_name, has_schema_privilege(r.role_name, 'public', 'create') as can_create_in_public
   from unnest(array['anon', 'authenticated', 'service_role', 'aceva_api']) as r(role_name);
   ```
   If `aceva_api` says `true`, run `revoke create on schema public from public;`.
4. If you left "Enable RLS on new tables automatically" ticked (3.1), the tables refuse every role except `postgres`, so
   the API login would see no rows. Check, and fix:
   ```sql
   select count(*) as tables_with_rls from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;
   ```
   If this is more than 0, run `alter role aceva_api bypassrls;`. Supabase's Prisma guide creates its login with
   `bypassrls` as well. Our backend still decides who sees what, because the rows the role may touch are limited by the
   grants above. **If Supabase refuses this command, stop here.** On staging keep the owner login for now. For
   production, ask a developer. Do not go live with the owner login in `/etc/aceva/api.env`.
5. Change `DATABASE_URL` in `/etc/aceva/api.env` (`sudo nano /etc/aceva/api.env`) to the API login:
   `postgresql://aceva_api.<project-ref>:<api-password>@<pooler-host>:5432/postgres?sslmode=verify-full&sslrootcert=/etc/aceva/supabase-ca.crt`
   The owner password is not in that file and not anywhere else on the VPS. Restart the API:
   `sudo systemctl restart aceva-api`.
6. Test: sign in, open every module's main screen, create and approve a task, a leave request, a payroll draft. Any error
   with `permission denied for table ...` or `... for sequence ...` means a grant is missing. Add it and write it here.
   Then run 9.4 (time zone) again.
7. Bonus: the pool of 15 is counted **per login**, so the API (as `aceva_api`) no longer shares its pool with
   migrations, seeds and backups.
8. After any restore from a Supabase daily backup, **reset this login's password** (`\password aceva_api`). Daily backups
   do not keep the passwords of custom logins.

### 6.4 A read-only login for backups

The nightly dump needs to read every table, and nothing more. Do **not** run it with the owner login. Same way as in
6.3 (connect as `postgres` in `psql`):

```sql
create role aceva_backup with login bypassrls;
\password aceva_backup
alter role aceva_backup set timezone to 'UTC';
grant usage on schema public to aceva_backup;
grant select on all tables in schema public to aceva_backup;
grant select on all sequences in schema public to aceva_backup;
alter default privileges for role postgres in schema public grant select on tables to aceva_backup;
alter default privileges for role postgres in schema public grant select on sequences to aceva_backup;
```

`bypassrls` is needed because 3.1 leaves "Enable RLS on new tables automatically" on, and `pg_dump` stops on a table where
row security would hide rows. If Supabase refuses it, stop. Do not fall back to the owner login for a scheduled job. Ask
a developer. The password goes into `~/.pgpass` (10.2 step 1). The test is the first backup run (10.2 step 4): it must
finish with no error. An error such as "query would be affected by row-level security policy" means `bypassrls` is
missing.

---

## 7. Prepare the VPS and apply the migrations

### 7.0 First sign-in to the VPS

Do this before section 5.3. It assumes you have the root password (or a key) from the VPS provider.

1. **PC (PowerShell).** Check that SSH exists on your PC. OpenSSH is built into Windows 10 and 11:
   ```powershell
   ssh -V
   ```
   It prints a version.
2. Make a key pair for yourself (skip this if `$HOME\.ssh\id_ed25519.pub` already exists), and show the public half:
   ```powershell
   ssh-keygen -t ed25519 -C "<your-name>"
   Get-Content $HOME\.ssh\id_ed25519.pub
   ```
   Press Enter to accept the file name, and choose a passphrase. The second command prints one line that starts with
   `ssh-ed25519`. Copy it. That is your public key.
3. Sign in as root for the first time: `ssh root@<vps-ip>`. SSH asks "Are you sure you want to continue connecting
   (yes/no/[fingerprint])?", because the server is new to your PC. If the provider's panel shows the server's
   fingerprint, compare it. Then type `yes` and give the root password.
4. **VPS (bash)**, as root. Make the user `aceva` and give it your key (use the name `aceva`, so that the paths in this
   guide are right):
   ```bash
   adduser aceva
   usermod -aG sudo aceva
   install -d -m 700 -o aceva -g aceva /home/aceva/.ssh
   nano /home/aceva/.ssh/authorized_keys
   chown aceva:aceva /home/aceva/.ssh/authorized_keys
   chmod 600 /home/aceva/.ssh/authorized_keys
   exit
   ```
   `adduser` asks for a password (use a long one from the password manager) and a few other questions (press Enter).
   In `nano` paste the public key line, then save and leave (see the note at the top).
5. **PC (PowerShell).** Sign in as the new user:
   ```powershell
   ssh aceva@<vps-ip>
   ```
   When it works, the prompt changes to `aceva@<hostname>:~$`. Check: `sudo whoami` prints `root`. From now on you work
   as `aceva`, never as root. `exit` signs you out.

### 7.1 Packages, users, firewall and hardening

**VPS (bash)**, as `aceva` (a user with `sudo`), not as root.

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y git curl ca-certificates openssl build-essential ufw rsync unattended-upgrades fail2ban
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

Allow `OpenSSH` **before** you enable the firewall, or you lock yourself out. The API listens on port 4000 on all
interfaces and the website on port 3000 (the services in 9.3 bind the website to `127.0.0.1`). The firewall keeps both
away from the internet. Only the web server (section 9.5) may reach them. If the office has a fixed address, you may
use `sudo ufw allow from <office-ip> to any port 22 proto tcp` in place of `ufw allow OpenSSH`. Then a lost address
locks you out, and the provider's console is the way back in.

`build-essential` is only needed if npm has to compile a native package (argon2) because no ready-made one fits the
server.

**The clock must be right.** An authenticator code is accepted only within about 30 seconds either side, and the session
limits (30 minutes idle, 12 hours at most) use the server's time.

```bash
timedatectl
```

It must show `System clock synchronized: yes`. If not: `sudo timedatectl set-ntp true`, and check again. A clock that is
more than 30 seconds out makes every authenticator code fail.

**Harden SSH.** Do this **only after** key sign-in works for `aceva` (7.0 step 5). Keep your first window open until a
second window has shown that you can still sign in:

```bash
sudo tee /etc/ssh/sshd_config.d/10-aceva.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sudo sshd -t && sudo systemctl reload ssh
```

(The file name starts with `10`, so it is read before the provider's own settings and wins.) Then:

- `fail2ban` blocks addresses that guess passwords. It watches SSH by default. Check: `sudo fail2ban-client status sshd`.
- `unattended-upgrades` installs security updates by itself. Check: `systemctl is-enabled unattended-upgrades`.
- Provider snapshots contain every secret on the server. Limit who can take or download them.

**Make the two service users.** `aceva` is the admin and deploy user. **No service ever runs as `aceva`.** One bug in
the website must not give an attacker the database password, the encryption key and the backup keys.

```bash
sudo adduser --system --group --no-create-home aceva-api
sudo adduser --system --group --no-create-home aceva-web
sudo chmod 711 /home/aceva
```

`chmod 711` lets the service users walk through the home folder to the code in `~/Aceva-CRM`. They cannot list it.
Ubuntu 24.04 makes home folders `750` by default, which would block them. Files such as `~/.pgpass` and `~/.ssh` stay
private because they have mode `600` or `700`.

### 7.2 Node.js and the PostgreSQL 17 client

Any way of installing Node 22.12 or newer (or 24) is fine. NodeSource is one way:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt install -y nodejs
node --version
```

The PostgreSQL 17 client gives you `psql` and a `pg_dump` that can read a version 17 server (Ubuntu 24.04's own
`postgresql-client` is version 16, which cannot dump a 17 server):

```bash
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
sudo apt install -y postgresql-client-17
psql --version
```

### 7.3 Get the code and install it

1. Make a read-only deploy key and add the public part in GitHub:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/aceva_deploy -C "aceva-vps-deploy" -N ""
   cat ~/.ssh/aceva_deploy.pub
   ```
   On GitHub: the repository, **Settings**, **Deploy keys**, **Add deploy key**. Paste the line printed by `cat`.
   Leave "Allow write access" **unticked**.
2. Tell SSH to use the key. `nano ~/.ssh/config`, put these lines in, save, and then `chmod 600 ~/.ssh/config`:
   ```
   Host github.com
       IdentityFile ~/.ssh/aceva_deploy
       IdentitiesOnly yes
   ```
3. Test it:
   ```bash
   ssh -T git@github.com
   ```
   The first time SSH asks about GitHub's host key. Compare its fingerprint with GitHub's published list (section 14),
   then type `yes`. Expect: `Hi <repository-owner>! You've successfully authenticated, but GitHub does not provide
   shell access.` (GitHub's usual reply. Check if yours differs a little.) `<repository-url>` below is the SSH form of
   the address (`git@github.com:<organization>/<repository>.git`).
4. Clone and install. Deploy a commit that is **pushed to GitHub** (`main`), not a copy of a working folder from a PC (a
   PC folder can contain local changes, for example to `package-lock.json`):
   ```bash
   cd ~
   git clone <repository-url> Aceva-CRM
   cd Aceva-CRM
   echo "NODE_ENV is: ${NODE_ENV:-not set}"
   npm ci
   npm run build:contracts
   npm run db:generate -w backend
   ```
   - `NODE_ENV` must be **not set** here. With `NODE_ENV=production`, `npm ci` skips the development packages, and
     `prisma` and `tsx` (needed for migrations and seeds) are development packages.
   - `db:generate` is needed because the generated database client (`backend/src/generated`) is not in Git and the root
     `build` does not make it.

### 7.4 Create the API's settings file

The API's settings live in `/etc/aceva/api.env`, **not** in `backend/.env` (5.5). Only root can read it. systemd reads
it for the service (9.3).

```bash
sudo install -m 600 -o root -g root /dev/null /etc/aceva/api.env
sudo nano /etc/aceva/api.env
```

For now put these two lines in (the rest is added in 9.1):

```
NODE_ENV=production
DATABASE_URL=<the app URL from 5.4>
```

Rules for this file:

- One `NAME=value` per line. Do **not** put quotes around `DATABASE_URL`: the check below reads the raw line.
- The app's own loader (Node) cuts an unquoted value at the first `#`, and the checks in this guide read this file with
  Node. If a value contains `#`, a space or a `$` (typically `SMTP_PASSWORD`), wrap it in double quotes:
  `SMTP_PASSWORD="pa#ss"`. Node and systemd then read the value the same way. Do not use a backslash inside a value.
  Without the quotes a real SMTP password is silently cut short, and production mail fails with an authentication
  error and no hint why.
- Do not put `SHADOW_DATABASE_URL` or `TEST_DATABASE_URL` in this file, and do not create a `backend/.env`.
- After any change: `sudo systemctl restart aceva-api`.

Why `NODE_ENV=production` even on staging: `NODE_ENV` accepts only `development`, `test` or `production`. There is no
`staging`. The staging API runs as `production` (the session cookie then needs HTTPS, section 9.5).

Check that you point at the right project, with the password hidden. Do this **every time** before a migration or a
seed (the helper in 7.5 also prints its own target):

```bash
sudo grep '^DATABASE_URL=' /etc/aceva/api.env | sed -E 's#(://[^:]+):[^@]*@#\1:***@#; s#\?.*##'
```

The user part must show the `<project-ref>` of the project you mean. Compare it with the staging or production entry in
your notes.

### 7.5 A helper for migrations and seeds

The helper asks for the **owner** password each time and builds the URLs in memory. Nothing with the owner password is
saved. It also holds the safety rule that demo data goes to staging only.

**Step 1.** The helper reads three non-secret settings from `~/aceva-db.conf`. `nano ~/aceva-db.conf`, type these lines
with your own values (`env_name` is `staging` or `production`), save, then `chmod 600 ~/aceva-db.conf`:

```
env_name=staging
project_ref=<project-ref>
host=<pooler-host>
```

**Step 2.** Create the helper. Copy the whole block, from `cat` to `chmod`, in one go:

```bash
cat > ~/aceva-db.sh <<'EOF'
#!/usr/bin/env bash
# Usage: ~/aceva-db.sh check | status | deploy | cert-tests | seed | seed-passwords
# It asks for the owner password every time. The password is never saved in a file.
set -euo pipefail
conf="$HOME/aceva-db.conf"      # env_name, project_ref, host (no secrets)
env_name="$(sed -n 's/^env_name=//p' "$conf")"
project_ref="$(sed -n 's/^project_ref=//p' "$conf")"
host="$(sed -n 's/^host=//p' "$conf")"
case "$env_name|$project_ref|$host" in *"<"*|*"||"*|"|"*|*"|") echo "Fill in ~/aceva-db.conf first."; exit 1 ;; esac
ca=/etc/aceva/supabase-ca.crt
cd "$HOME/Aceva-CRM/backend"

echo "Target: $env_name, project $project_ref, host $host"
read -rsp "Password of postgres.$project_ref: " pw; echo
base="postgresql://postgres.${project_ref}:${pw}@${host}:5432/postgres"
app_url="${base}?sslmode=verify-full&sslrootcert=${ca}"
mig_url="${base}?sslmode=require&sslaccept=strict&sslcert=${ca}"

connect_test='
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, options: "-c TimeZone=UTC" });
  await c.connect();
  console.log((await c.query("select current_user as who, version() as v")).rows[0]);
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) await c.query("select 1");
  console.log("one round trip, average ms:", ((performance.now() - t0) / 5).toFixed(1));
  await c.end();
})().catch((e) => { console.error("FAILED:", e.code || "", e.message); process.exit(1); });
'

case "${1:-}" in
  check)  DATABASE_URL="$app_url" node -e "$connect_test" ;;
  status) DATABASE_URL="$mig_url" npx prisma migrate status ;;
  deploy)
    read -r -p "Apply the migrations to $env_name? Type yes: " answer
    [ "$answer" = "yes" ] || { echo "Stopped."; exit 1; }
    DATABASE_URL="$mig_url" npm run db:migrate ;;
  cert-tests)
    echo "--- Test 1 (migration program, certificate removed): must fail with P1011 and the word certificate."
    DATABASE_URL="${mig_url%%&sslcert=*}" npx prisma migrate status || true
    echo "--- Test 2 (migration program, wrong host name): must fail with P1011."
    ip="$(getent ahostsv4 "$host" | awk 'NR==1{print $1}')"
    DATABASE_URL="${mig_url/@${host}:/@${ip}:}" npx prisma migrate status || true
    echo "--- Test 3 (app driver, wrong root certificate): must fail with a certificate error."
    wrong=/etc/ssl/certs/ISRG_Root_X1.pem
    DATABASE_URL="${app_url/"$ca"/$wrong}" node -e "$connect_test" || true ;;
  seed|seed-passwords)
    [ "$env_name" = "staging" ] || { echo "Demo data is for staging only. Stopped."; exit 1; }
    if [ "$1" = "seed" ]; then
      read -r -p "Load the DEMO data into $env_name? Type yes: " answer
      [ "$answer" = "yes" ] || { echo "Stopped."; exit 1; }
      NODE_ENV=development DATABASE_URL="$app_url" npm run db:seed
    else
      read -rsp "Demo password (at least 10 characters): " DEMO_PASSWORD; echo
      NODE_ENV=development DATABASE_URL="$app_url" DEMO_PASSWORD="$DEMO_PASSWORD" npm run db:seed:passwords
    fi ;;
  *) echo "Usage: $0 check | status | deploy | cert-tests | seed | seed-passwords"; exit 1 ;;
esac
EOF
chmod 700 ~/aceva-db.sh
```

Check that the file starts correctly: `head -3 ~/aceva-db.sh` must show the line `#!/usr/bin/env bash` first.

### 7.6 Check the connection, then prove that the certificate is checked

1. Check with the app's own driver (the helper uses the app URL, as the owner):
   ```bash
   ~/aceva-db.sh check
   ```
   - `who` is `postgres.<project-ref>`, and the version says PostgreSQL 17.
   - A round trip should be a few milliseconds (under about 10 ms) when the VPS and the project are both in or near
     Mumbai. Above about 30 ms, move the VPS. Most actions in the API run in a database transaction with Prisma's
     default 5-second limit, and they fail with `P2028` ("Transaction already closed") when every query is slow. (This is
     a guide, not a Supabase figure.)
   - On failure see section 13.
2. Check the migration program's connection, and that it sees no migrations yet:
   ```bash
   ~/aceva-db.sh status
   ```
   It should list all 18 migrations as not yet applied.
3. **Prove that the certificate is really checked, by both programs.** Three tests, all must **fail**:
   ```bash
   ~/aceva-db.sh cert-tests
   ```
   - **Test 1** removes the trusted certificate from the migration URL but keeps `sslaccept=strict`. The error must
     contain `P1011` and the word *certificate*. If it shows `P1000`, `P1001` or an authentication error, the test
     proved nothing: go back to step 2 and fix the connection first. This test is valid only while the Supabase
     certificate is **not** in the server's trust store: `ls /usr/local/share/ca-certificates /etc/ssl/certs | grep -i
     supabase` must print nothing.
   - **Test 2** points the migration program at the pooler's IP address instead of its name. It must fail with `P1011`
     (a host-name mismatch). This proves the host name is checked, and it does not depend on the trust store.
   - **Test 3** gives the app driver a wrong root certificate (a public one from the operating system, the file
     `/etc/ssl/certs/ISRG_Root_X1.pem` of the `ca-certificates` package; check that it exists). It must fail with
     `SELF_SIGNED_CERT_IN_CHAIN` or a message like "unable to verify".
   If any test **connects**, the check on this server is off. Stop and ask a developer before you go on (the network
   restrictions in 4.4 are then your main protection). If the first status (step 2) fails with `P1011`, see section 13.
   Run these tests again after every Node, Prisma or `pg` update (12.5).

### 7.7 Apply the migrations

```bash
~/aceva-db.sh deploy
```

Type `yes` after you have read the target, then the owner password. `prisma migrate deploy` applies the 18 migrations in
order and ends with `All migrations have been successfully applied.` Then:

```bash
~/aceva-db.sh status
```

It should say `Database schema is up to date!`.

### 7.8 Check the result

In the dashboard **SQL Editor** (it runs as `postgres`):

```sql
-- 91 app tables plus Prisma's own _prisma_migrations = 92
select count(*) as tables from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE';

-- 18 finished migrations
select count(*) as finished from _prisma_migrations where finished_at is not null;
select count(*) as unfinished from _prisma_migrations where finished_at is null;
```

Expected: 92, 18, 0. If the numbers differ, run the first query on the local development database for comparison.

Then:

1. Run the "open tables" query from 4.2. It must still return no rows.
2. Run the Security Advisor again (4.6).
3. Test that the Data API is off. From any computer, with the **publishable** key (it starts with `sb_publishable_`)
   from **Settings**, **API Keys**. If your project still shows a legacy `anon` key, that works too. This key is public
   by design, but still do not paste it into chat:
   ```bash
   curl -s -H "apikey: <publishable-key>" "https://<project-ref>.supabase.co/rest/v1/employees?select=*"
   curl -s -H "apikey: <publishable-key>" "https://<project-ref>.supabase.co/rest/v1/"
   ```
   Send the key in the `apikey` header, **not** in an `Authorization: Bearer` header. There must be no rows in the
   answer, and the second call must not list any of our tables. An error message is the pass, **but read it**:
   - If the answer contains `42501` or `permission denied`, the Data API is **still on** and only the revoked rights
     stopped it. Go back to 4.1.
   - (The exact answer of a switched-off Data API is not documented.)
4. Rerun 4.2, this step and the Security Advisor after every Supabase upgrade or restore (12.5).

---

## 8. The data

### 8.1 Staging: the demo data

The demo seed creates fictional people, so it is for staging only. The seed and the demo logins **refuse to run when
`NODE_ENV=production`** (`Refusing to seed demo data in production.` and `Refusing to create demo logins in
production.`). The staging API runs as `production` (7.4). So the helper runs these two commands **one at a time with
`NODE_ENV=development` put in front, itself**. Nobody types that prefix by hand.

> Danger: that prefix switches the safety check off. Four things keep demo data away from production. First, the helper
> runs the seed commands only when `~/aceva-db.conf` says `env_name=staging`. Second, the production VPS has no
> `backend/.env` and no `DATABASE_URL` in the shell, so a command copied from this page stops with "DATABASE_URL is not
> set". Third, production has its own VPS (section 11). Fourth, the open item in 11.3 asks for a guard in the code.
> **Never put `NODE_ENV=development` in front of a command on the production server.**

Run the seeds **on the VPS**, close to the database. The seed is one transaction with a 60-second limit and hundreds
of small steps, so it can time out from a laptop on another continent.

```bash
~/aceva-db.sh seed
echo $?
```

Type `yes`, then the owner password. The last line printed is `Seed finished. Employees in database: 12`. The
`echo $?` must print `0`. If it prints anything else, read the last 20 lines of the output and stop.

- `db:seed` is safe to run again. It loads 5 levels, the permission list, 6 roles, 3 duties, demo departments and
  offices, 12 fictional people (ACV-0001, ACV-0003, ACV-0004, ACV-0006 to ACV-0014), the work schedule, leave types,
  finance settings, a 17-account development chart of accounts, 5 demo projects and 9 holidays.
- **The demo logins are not made here.** They are made in 9.6, after the web server is limited to the team's addresses
  (9.5). `db:seed:passwords` gives every person without a login the same password, and every demo account, including
  the Owner and the Director, shares it. The staging site is on the internet, so the allow-list must be active first.

Check in the SQL Editor: `select count(*) from employees;` gives 12.

To start again on staging, the clean way is to delete the project and make a new one. `npm run db:reset` drops and
recreates the `public` schema, which also removes Supabase's own settings on it (you would redo 4.2). It cannot run on
the server as set up here (there is no `DATABASE_URL`), and it must **never** be run against production.

### 8.2 Production: the real first users and the reference data

**There is no production bootstrap in the repository.** Please read this plainly:

- The levels, permissions, roles and duties are created **only inside the demo seed**. It refuses production, and it
  creates the 12 fictional people. Those people can never be deleted.
- The joining workflow cannot create the first people. A new employee needs a manager, and nobody can place a new person
  at or above their own level. The Owner (Level 1) can never be created through the app, and the Director (Level 2) only
  by a Level 1 person, who does not have the right to manage people.
- Nothing in the app creates the first password. Real people get a random temporary password by e-mail from the joining
  workflow.
- So there is **no safe way with the existing scripts.** Running the demo seed against production would put fictional
  people and a development chart of accounts into the real ledger, with no way to remove them. **Do not do it.**

**Open item for the team (a developer and the owner decide):** write a small one-off bootstrap script that

1. loads only the reference data (it can reuse `LEVELS`, `PERMISSIONS`, `ROLES`, `DUTIES` and `rebuildReportingClosure`
   exported by `backend/prisma/seed-data.ts`),
2. creates the real Owner (ACV-0001, Level 1, role owner, no manager) and the real Director (Level 2, reports to the
   Owner, duties hr and sales manager) with their real `@acevatech.com` addresses, one real department and one real
   office,
3. gives each a login row with an unusable random password marked "must change".

Until it exists, production cannot go live. When it exists, the procedure is:

1. Rehearse it on an empty scratch database first (a new Free project or the local database), never on staging with the
   demo data.
2. On production: migrate (7.7), run the bootstrap once, then check the counts in the SQL Editor.
3. The Owner and the Director set their own password with **Forgot password** on the sign-in page (enter the Emp-ID).
   The reset link is e-mailed to the official address, so production SMTP must work first (9.1). The reset works only
   for a person who already has a login row and an `@acevatech.com` address.
4. They then set up the authenticator app at first sign-in.
5. The Director and the Finance person enter the real work schedule, leave types, finance settings, chart of accounts and
   tax slabs through the screens. `docs/M7-M9-DECISIONS.md` marks the chart of accounts as blocking for real data, and
   says that payroll refuses to calculate until the accountant enters a tax slab version. The accountant must supply
   both first.

---

## 9. Prove it works

There is no way to run the automated test suite against Supabase (9.8). The proof is: the migrations went through, the
demo seed went through on staging, the health address says the database is up, the time zone is UTC, and a person can
sign in and use the screens.

### 9.1 What the API needs besides the database

Put these in `/etc/aceva/api.env` on the staging VPS (`sudo nano /etc/aceva/api.env`; the first two lines are already
there). Follow the rules in 7.4 (quotes around a value with `#`, a space or `$`).

| Variable | Staging value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Already set. |
| `CORS_ORIGIN` | `https://staging.<your-domain>` | **One exact value**: scheme and host, no slash at the end. It is also the check on the `Origin` of every data-changing request. A mismatch gives `403 origin_not_allowed` on every save, while reading still works. |
| `APP_URL` | `https://staging.<your-domain>` | Link base in the mails. |
| `REDIS_URL` | `redis://:<redis-password>@127.0.0.1:6379` | Redis on the same VPS (below). |
| `DATA_ENCRYPTION_KEY` | a **new** key for this environment | Make it on the VPS: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Copy it to the password manager now. |
| `FILE_STORAGE_ROOT` | `/var/lib/aceva/files` | An absolute folder outside the repository. |
| `TRUST_PROXY` | `1` | One proxy in front (nginx). Never `2` (see the note below the table). With `0`, every user looks like `127.0.0.1`, and the login rate limit locks everybody out together. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | `127.0.0.1`, `1025`, `false` | Staging uses Mailpit (below). These are also the defaults, so on production a forgotten setting gives no warning: the mails (reset links, the welcome mail with the temporary password, alerts) are simply never delivered. |
| `MAIL_FROM` | `Aceva <no-reply@acevatech.com>` | Default. Has a space, so write it in double quotes in this file. |
| `GEOIP_RANGES` | empty | Optional. Format `"39.45.0.0/16=Karachi; 182.185.0.0/16=Lahore"`. Empty (the default) means every city is unknown and the "login from a new city" alert never fires. The "new device" alert still works. Management decides whether to fill it before go-live. |

Leave `COOKIE_SECURE` unset. The API refuses `COOKIE_SECURE=false` in production.

**Behind a CDN** (such as Cloudflare): keep `TRUST_PROXY=1`. Let nginx take the client address from the CDN only, with
`set_real_ip_from <cdn-range>;` for each range the CDN publishes, and `real_ip_header CF-Connecting-IP;` (the header
name is the CDN's own). Limit the firewall's ports 80 and 443 to the CDN's published ranges. **Never set
`TRUST_PROXY=2` while the VPS answers the whole internet.** Anyone could then send a made-up `X-Forwarded-For` header
straight to the VPS and the app would take it as the client address. That defeats the per-address login limit and
writes false addresses and cities into the activity and audit records.

**The folder for files** (owned by the API's user; the admin user may read it, for the backup):

```bash
sudo mkdir -p /var/lib/aceva/files
sudo chown aceva-api:aceva-api /var/lib/aceva/files
sudo chmod 750 /var/lib/aceva/files
sudo usermod -aG aceva-api aceva
```

Sign out of SSH and in again, so that the new group counts. `id` must list `aceva-api`.

**Redis** (holds only the fast copy of the sessions; PostgreSQL has the permanent record):

```bash
openssl rand -hex 24
sudo apt install -y redis-server
sudo nano /etc/redis/redis.conf
```

In that file add `requirepass <redis-password>` (use the value printed above) and check that `bind` says
`127.0.0.1 -::1`. Then:

```bash
sudo systemctl restart redis-server
read -rsp 'Redis password: ' REDISCLI_AUTH; echo; export REDISCLI_AUTH; redis-cli ping; unset REDISCLI_AUTH
```

It should answer `PONG`.

**Mailpit for staging mail.** The demo people have addresses like `bilal@acevatech.com`. If staging used the real mail
service, alert mails, task mails and reset links would go to real addresses. Catch them in Mailpit instead:

1. Download Mailpit (a program with one file) from its releases page (https://github.com/axllent/mailpit/releases).
   Use the Linux amd64 archive. Check the file name and the checksum on the page:
   ```bash
   mkdir /tmp/mailpit-dl && cd /tmp/mailpit-dl
   curl -fsSL -o mailpit.tar.gz https://github.com/axllent/mailpit/releases/latest/download/mailpit-linux-amd64.tar.gz
   sha256sum mailpit.tar.gz
   tar -xzf mailpit.tar.gz mailpit
   sudo install -m 755 mailpit /usr/local/bin/mailpit
   cd ~ && rm -rf /tmp/mailpit-dl
   mailpit version
   sudo adduser --system --group --no-create-home mailpit
   ```
2. Make it a service. `sudo nano /etc/systemd/system/mailpit.service`:
   ```ini
   [Unit]
   Description=Mailpit (staging mail catcher)
   After=network.target

   [Service]
   User=mailpit
   ExecStart=/usr/local/bin/mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025
   Restart=on-failure
   NoNewPrivileges=yes
   PrivateTmp=yes
   ProtectSystem=strict
   ProtectHome=yes

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now mailpit
   curl -s http://127.0.0.1:8025/api/v1/info
   ```
   The last command should answer with a short JSON text. (Check the exact address on the Mailpit documentation if it
   does not.) Mailpit keeps the mails in memory, so a restart empties the inbox. That is fine for staging.
3. Read the mails through an SSH tunnel. **PC (PowerShell):**
   ```powershell
   ssh -L 8025:127.0.0.1:8025 aceva@<vps-ip>
   ```
   Then open http://127.0.0.1:8025 on the PC.

(Production uses a real SMTP service. See section 11.)

### 9.2 Build the API and the website

The website variables starting with `NEXT_PUBLIC_` are fixed into the site **when it is built**. A change needs a new
build. The default mode shows fake in-browser data, so a build without these lines looks fine but never talks to the API.

```bash
cd ~/Aceva-CRM
free -h
cat > frontend/.env.production <<'EOF'
NEXT_PUBLIC_API_MODE=mock
NEXT_PUBLIC_LIVE_MODULES=m1,m2,m3,m4,m5,m6,m7,m8,m9
NEXT_PUBLIC_API_URL=/api/v1
EOF
npm run build
```

`NEXT_PUBLIC_API_MODE=mock` with a module list is the mode the project's browser tests use
(`e2e/playwright.config.ts`, which lists the modules without m4; see also `docs/SETUP.md`): the listed modules use the
real API and anything else keeps demo data. This guide lists m1 to m9, so m4 (activity) also uses the API. Today `NEXT_PUBLIC_API_MODE=live` gives the same result, because the website has no module beyond m9 wired to the
API. Keep the list, so a future half-finished module stays on demo data. The file `frontend/.env.production` is ignored
by Git.

After you sign in (9.6), the modules m1 to m9 must show data from the database, not demo data. If you see demo data,
check `frontend/.env.production` and build again. (If the build ends with `Killed`, see 1.2.)

### 9.3 Start the API and the website, and check the health address

The API reads its settings from `/etc/aceva/api.env`, through the service. There is no `backend/.env`, and the API
user cannot read the file itself: systemd (running as root) reads it and hands the values over.

Create `/etc/systemd/system/aceva-api.service` (`sudo nano ...`):

```ini
[Unit]
Description=Aceva API
After=network-online.target redis-server.service
Wants=network-online.target

[Service]
User=aceva-api
Group=aceva-api
WorkingDirectory=/home/aceva/Aceva-CRM/backend
EnvironmentFile=/etc/aceva/api.env
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/aceva/files

[Install]
WantedBy=multi-user.target
```

Do not put `NODE_ENV=development` here. Run **one** API process only (no cluster mode): each one opens up to 10 database
connections. `ProtectSystem=strict` makes the whole disk read-only for the API, except the files folder.

And `/etc/systemd/system/aceva-web.service`. The website has its own user and **no access** to `/etc/aceva/api.env`
or to the files folder:

```ini
[Unit]
Description=Aceva website
After=network-online.target

[Service]
User=aceva-web
Group=aceva-web
WorkingDirectory=/home/aceva/Aceva-CRM/frontend
Environment=NODE_ENV=production
ExecStart=/home/aceva/Aceva-CRM/frontend/node_modules/.bin/next start -H 127.0.0.1 -p 3000
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
```

(Check that `ls /home/aceva/Aceva-CRM/frontend/node_modules/.bin/next` shows the file. The unit starts `next` directly
because `npm` wants to write its own cache and log files, and this user may not write anywhere. If the journal shows a
write error under `.next`, tell a developer. Do not give the website user write rights without thinking.)

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now aceva-api aceva-web
sudo systemctl status aceva-api --no-pager
sudo systemctl status aceva-web --no-pager
journalctl -u aceva-api -n 50 --no-pager
curl -s http://127.0.0.1:4000/api/v1/health
```

`active (running)` means the service started. `failed` means: read the journal output. You should see
`Aceva API listening on http://localhost:4000/api/v1` in it. The API stops at start-up with a list of every wrong
variable, so read that list if it stops. The health answer is `{"status":"ok","database":"up", ...}`. `"degraded"` and
`"down"` mean the API cannot reach the database (section 13).

### 9.4 Check that the session time zone is UTC

The app's `-c TimeZone=UTC` request is dropped by the pooler (4.5), so what counts is what the pooler's own connection
says. Check both ways, with the API's own login. **VPS (bash)** (`sudo` is needed only to read the settings file):

```bash
cd ~/Aceva-CRM/backend
sudo node --env-file=/etc/aceva/api.env -e '
const { Client } = require("pg");
(async () => {
  for (const options of [undefined, "-c TimeZone=UTC"]) {
    const c = new Client({ connectionString: process.env.DATABASE_URL, options });
    await c.connect();
    const r = await c.query("show timezone");
    console.log(options ? "with the app option: " : "without the option:  ", r.rows[0].TimeZone);
    await c.end();
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
'
```

**Both lines must say `UTC`.** If the first one says anything else, repeat 4.5 (and `alter role aceva_api set timezone
to 'UTC'` from 6.3) and connect again (an open connection keeps its old setting; restart the API after the change so it
opens new ones). Why it matters: the app asks for UTC on every connection as a precaution (`backend/src/prisma/connection.ts`).
All times are stored as `timestamptz`, so a different session zone does not change the stored times. It changes how
times print in `psql` and in the SQL Editor, and how any future `::date` or `date_trunc` SQL behaves. Keep the check,
and fix a result that is not UTC before go-live.

### 9.5 The website and the web server (what sign-in needs)

The repository has no deployment files yet, and this guide is about the database. These are only the parts without
which sign-in does not work. A full deployment guide is an open item.

- **HTTPS is required, even on staging.** In production the session cookie is `Secure`. A browser drops it on plain
  `http://`, so the sign-in seems to work but the session never sticks.
- **One address for the site and the API.** The site on `/` and the API on `/api/`, both through the web server, on one
  domain. The cookie has no domain setting, and the `Origin` check expects one exact value.
- The firewall (7.1) keeps ports 3000 and 4000 closed. The API's documentation pages (`/api/docs`, `/api/docs-json`)
  have no sign-in in any environment, so the web server must hide them.
- File uploads can be 10 MB, so the web server must allow bodies a little larger.
- **Staging is limited to the team's addresses. This is required, not optional.** Every demo account shares one
  password and is not forced to change it.

Install nginx and certbot, and point the domain's DNS `A` record at the VPS first:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo rm /etc/nginx/sites-enabled/default
```

(The second line removes nginx's default welcome site, so that only ours answers.)

**The team list (staging).** `sudo nano /etc/nginx/snippets/aceva-team-only.conf`, one `allow` line for each public
IPv4 address of the team (the office, or a person's home address; ask each person for it, and ask the Owner first when
people use home internet, because those addresses can change). The VPS's own address is on the list too, so that checks
made on the server itself work:

```nginx
allow <vps-ip>;
allow <office-ip>;
deny all;
```

The words `<vps-ip>` and `<office-ip>` are placeholders on purpose: while one is still there, `nginx -t` stops with an
error, so the site cannot start open. Replace them.

**The site.** `sudo nano /etc/nginx/sites-available/aceva`:

```nginx
server {
    listen 80;
    server_name staging.<your-domain>;
    client_max_body_size 12m;

    location ^~ /api/docs { return 404; }

    location /api/ {
        include snippets/aceva-team-only.conf;   # staging only: remove this line on production
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        include snippets/aceva-team-only.conf;   # staging only: remove this line on production
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

The team list sits inside the two `location` blocks, not at the top of the `server` block. That keeps the certificate
check of Let's Encrypt (which comes from outside, over port 80) working. Then:

```bash
sudo ln -s /etc/nginx/sites-available/aceva /etc/nginx/sites-enabled/aceva
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d staging.<your-domain>
```

`certbot` asks a few things: enter a company e-mail address (for expiry warnings), agree to the terms, say no or yes to
the mailing list as you like, and choose the option that **redirects HTTP to HTTPS**. The success line is
`Successfully deployed certificate`. Then check:

```bash
curl -s https://staging.<your-domain>/api/v1/health
```

The answer is JSON with `"status":"ok"` in it. (Run it on the VPS. If you get `403`, the VPS address is missing from the
team list.)

**Check the team list from outside.** From a phone on mobile data (not a team address), open
`https://staging.<your-domain>/login` in the browser, or on a computer outside the team run
`curl -s -o /dev/null -w '%{http_code}' https://staging.<your-domain>/login`. It must say `403`. If it shows the login
page, **stop**: do not make the demo logins (9.6).

### 9.6 Sign in on staging

1. **Make the demo logins now**, and only now. Only after the check at the end of 9.5 gave `403` from outside:
   ```bash
   ~/aceva-db.sh seed-passwords
   ```
   Type the owner password, then a long random demo password of at least 10 characters (it is not shown). It prints
   `Created 12 demo login(s).`. Check in the SQL Editor: `select count(*) from credentials;` gives 12.
2. **At once**, sign in as the four people who must set up an authenticator app: ACV-0001 (Owner), ACV-0003
   (Director), ACV-0004 (CTO) and ACV-0010 (Finance). Whoever signs in first registers their own authenticator on the
   account, so do not wait. Scan the QR code with an authenticator app (the QA engineer's phone is fine for demo
   accounts) and enter the 6-digit code.
3. Open `https://staging.<your-domain>/login` and sign in as the Director: Emp-ID `ACV-0003` and the demo password.
4. Open a few screens (people, tasks, leave, payroll). Look in `journalctl -u aceva-api` for errors, and in the browser's
   network view for `403` or `401` on every save.
5. Check in the SQL Editor that the session was saved: `select count(*) from sessions;` is more than 0.

### 9.7 Mails

1. On the sign-in page choose **Forgot password** and enter `ACV-0003`. The mail goes to the Director's official address
   on file and arrives in Mailpit (9.1). The link starts with your `APP_URL`.
2. Failed mails are retried by the app (after 10 seconds, 30 seconds, 2 minutes, and so on). If nothing arrives, check
   `SMTP_HOST`, `SMTP_PORT` and `APP_URL` first.

### 9.8 Never run these (the warning list)

| Command | What it does | Variable it reads | Rule |
|---|---|---|---|
| `npm test`, `npm run test -w backend` (also the Vitest set-up) | Rebuilds a test database from scratch with `DROP SCHEMA public CASCADE`, then migrates and seeds | `TEST_DATABASE_URL` (it also copies it into `DATABASE_URL`) | **Never run tests on a server.** The name must contain `test`, and a Supabase database is called `postgres`, so the guard would refuse. Do not weaken it. Do not set `TEST_DATABASE_URL` on the VPS. |
| `npm run test:e2e`, `e2e/reset-test-db.ts` | Same reset, for the browser tests | `TEST_DATABASE_URL` | Same. |
| `npm run db:reset -w backend` | `prisma migrate reset --force`. **No question asked, no guard.** Drops everything. | `DATABASE_URL`, read through `prisma.config.ts` | Never against any database you want to keep. On the server there is no `DATABASE_URL` (no `backend/.env`), so it gets an empty address. Never put a URL in front of it. On staging prefer a new project. |
| `npm run db:migrate:dev -w backend` | `prisma migrate dev`. Needs a throw-away database and may offer to reset. | `DATABASE_URL`, `SHADOW_DATABASE_URL` | Never on Supabase. Leave `SHADOW_DATABASE_URL` unset on the VPS. |
| `npm run db:seed:passwords -w backend` | Gives every person without a login the demo password | `DATABASE_URL`, `DEMO_PASSWORD`, `NODE_ENV` | Staging only, through `~/aceva-db.sh seed-passwords`. Refuses `production` by itself. It also gives every real employee without a login one known password, so never on production. |
| `npm run db:seed` | Loads the demo people. Also deletes reporting-line rows and roles that left the structure. | `DATABASE_URL`, `NODE_ENV` | Staging only, through `~/aceva-db.sh seed`. The helper refuses unless the settings say `staging`. Nobody types the `NODE_ENV=development` prefix by hand. |
| A plain `npm run db:migrate` | `prisma migrate deploy` with the app URL | `DATABASE_URL` | Use `~/aceva-db.sh deploy` (7.5). A plain run gives an encrypted but unchecked connection. |
| SQL `TRUNCATE`, `DELETE`, `UPDATE` on `audit_log` and the other history tables | Fails by design: those tables are insert-only (`Table ... is insert-only`) | | Restore options that `TRUNCATE` or `DELETE` rows (for example `pg_restore --data-only --clean`, or loading into a database that already has data) fail for the same reason. Always restore into an empty database (10.3, 10.4). |

Also never: hand-edit `_prisma_migrations`, delete a migration file that has been applied, or run `prisma db push`.

---

## 10. Backups and restore

Three things must be backed up together. Without all three a restore is incomplete:

1. the **database** (Supabase backups and our own nightly dump),
2. the **uploaded files** (`FILE_STORAGE_ROOT` on the VPS; not in any Supabase backup),
3. the **`DATA_ENCRYPTION_KEY`** (in the password manager; without it the 2FA secrets, CNIC and bank numbers in a
   restored database cannot be read).

### 10.1 What Supabase gives you

- **Free:** no backups.
- **Pro:** a daily backup, kept 7 days (Dashboard, **Database**, **Backups**; the name may differ). Team keeps 14 days,
  Enterprise up to 30.
- **Point-in-time recovery** (add-on, Pro and above): restore to a chosen minute. It replaces the daily backups.
- Daily backups **do not contain the passwords of custom logins** (reset `aceva_api` and `aceva_backup` after a restore,
  6.3 and 6.4).
- A restore makes the project unavailable while it runs. Deleting a project deletes its backups for good.
- Supabase does not say whether the dashboard settings come back after a restore (SSL enforcement, network
  restrictions, add-ons, the Data API switch). Check each setting in section 4 again after any restore.

### 10.2 Our own nightly dump from the VPS

Needs the PostgreSQL 17 client (7.2) and the read-only login (6.4). A `pg_dump` older than the server refuses to run.
(The Supabase command-line `supabase db dump` needs Docker, which a VPS may not have, so use plain `pg_dump`.)

Dump names say which environment they come from (`db-staging-...`, `db-production-...`), and each environment has its
own off-site folder and its own age key pair. This stops a staging dump from being restored into production, and the
other way round.

**Step 1.** Make a place for the dumps and a password file for `pg_dump`. The file keeps the password out of the process
list. Make it empty with the right mode first, then fill it with `nano`, so the password is never typed on the command
line (where it would stay in `~/.bash_history`):
```bash
sudo mkdir -p /var/backups/aceva
sudo chown aceva:aceva /var/backups/aceva
sudo chmod 700 /var/backups/aceva
install -m 600 /dev/null ~/.pgpass
nano ~/.pgpass
```
In `nano`, type one line and save:
```
<pooler-host>:5432:postgres:aceva_backup.<project-ref>:<backup-password>
```
Check: `ls -l ~/.pgpass` shows `-rw-------`. (A password with `:` or `\` needs escaping in this file. Letters and digits
do not.)

**Step 2. Encryption keys.** Backups hold payroll, CNIC and bank data, so they are encrypted with a public key. The
secret key is made on an **admin PC**, never on the VPS. The VPS keeps only the public key, so a thief of the VPS cannot
read old backups. (A secret key that is made on the server and "shredded" can survive in journals, on SSD and virtual
disks, and in provider snapshots.) Do this once for each environment.
1. On the admin PC, get `age` from its releases page (https://github.com/FiloSottile/age/releases): the Windows build,
   unzip it. **PC (PowerShell)**, in the folder with the program:
   ```powershell
   .\age-keygen.exe -o aceva-backup-key-staging.txt
   ```
   It prints `Public key: age1...`. Keep that line.
2. Open the file `aceva-backup-key-staging.txt`. Copy the line `AGE-SECRET-KEY-...` into the password manager, in that
   environment's folder. Then delete the file: `Remove-Item .\aceva-backup-key-staging.txt`. Use a PC you trust.
3. On the VPS, install `age` (it is needed for encrypting) and use only the public key `age1...` in the script:
   ```bash
   sudo apt install -y age
   ```
> Check: `age` is in the Ubuntu 24.04 package list. If `apt` cannot find it, use the GitHub release of `age`.

**Step 3.** The script, `~/bin/aceva-backup.sh`. Set `environment` to `staging` or `production`:
```bash
mkdir -p ~/bin
cat > ~/bin/aceva-backup.sh <<'EOF'
#!/usr/bin/env bash
# Nightly backup: the database dump and the uploaded files, both encrypted. Local copy only.
set -euo pipefail
umask 077

export PGSSLMODE=verify-full
export PGSSLROOTCERT=/etc/aceva/supabase-ca.crt
export PGPASSFILE="$HOME/.pgpass"

environment="staging"                    # staging or production
host="<pooler-host>"
user="aceva_backup.<project-ref>"
recipient="<age-public-key>"
dest=/var/backups/aceva
files_root=/var/lib/aceva/files
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

pg_dump --host "$host" --port 5432 --username "$user" --dbname postgres \
  --schema public --format custom --no-owner --no-privileges \
  | age -r "$recipient" -o "$dest/db-$environment-$stamp.dump.age.part"
mv "$dest/db-$environment-$stamp.dump.age.part" "$dest/db-$environment-$stamp.dump.age"

tar -C "$files_root" -cf - . | age -r "$recipient" -o "$dest/files-$environment-$stamp.tar.age.part"
mv "$dest/files-$environment-$stamp.tar.age.part" "$dest/files-$environment-$stamp.tar.age"

# keep 14 days on this server
find "$dest" -name '*.age' -mtime +14 -delete

touch "$dest/LAST_OK"
echo "$stamp backup ok"
EOF
chmod 700 ~/bin/aceva-backup.sh
```
Replace the placeholders with `nano ~/bin/aceva-backup.sh` after you made it. A dump goes under a `.part` name first, so
a failed run never leaves a half file that looks complete.

**Step 4.** Run it once by hand: `~/bin/aceva-backup.sh`. Check that two `.age` files appear (`ls -l /var/backups/aceva`)
and that the last line says `backup ok`. This step needs no off-site copy. It makes the local files only.

**Step 5. The off-site copy.** A backup that sits only on the VPS is lost with the VPS, or with an attacker on it.
Production needs this step before go-live. The target is a place that is **not this server and not Supabase**: another
server you can reach over SSH, or object storage.
1. On the VPS, make a key just for this, with no passphrase (a cron job cannot type one), and pin the backup host's key,
   so that nobody can stand in for it. **Never use `StrictHostKeyChecking=no`.**
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/aceva_backup -N "" -C aceva-backup-<environment>
   ssh-keyscan -t ed25519 <backup-host> > /tmp/backup-host.key
   ssh-keygen -lf /tmp/backup-host.key
   ```
   Compare the fingerprint it prints with the one the owner of the backup host gives you. Only if they are the same:
   ```bash
   cat /tmp/backup-host.key >> ~/.ssh/known_hosts
   rm /tmp/backup-host.key
   cat ~/.ssh/aceva_backup.pub
   ```
2. On the **backup host**, as the backup user, add the public key line to `~/.ssh/authorized_keys` **with limits**, so the
   key can only write into one folder and cannot open a shell, read, or (if your version supports it) delete:
   ```
   restrict,command="rrsync -wo <backup-folder>" ssh-ed25519 AAAA... aceva-backup-<environment>
   ```
   (`rrsync` comes with `rsync`. Check `rrsync -help` on the backup host: newer versions also offer `-no-del` and
   `-no-overwrite`. Use them if they exist.) Use one folder for each environment.
3. On the VPS, make `~/bin/aceva-offsite.sh` and run it once (copy the whole block):

```bash
cat > ~/bin/aceva-offsite.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
rsync -a --exclude LAST_OK --exclude '*.part' \
  -e "ssh -i $HOME/.ssh/aceva_backup -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes" \
  /var/backups/aceva/ "<backup-user>@<backup-host>:./"
echo "offsite ok"
EOF
chmod 700 ~/bin/aceva-offsite.sh
~/bin/aceva-offsite.sh
```

   It must end with `offsite ok`. Look in the backup folder on the backup host: the `.age` files are there.
4. Old backups are deleted **on the backup host**, never from the VPS (a stolen VPS key must not be able to delete the
   copies). On the backup host, a daily `cron` line: `find <backup-folder> -name '*.age' -mtime +<days> -delete`.
5. Another way: object storage with versioning and object lock, and a write-only key in `rclone`. Either way, the VPS
   must not be able to delete or overwrite what it already wrote.

**Step 6.** Add the schedule: `crontab -e` (the first time it asks which editor: choose `nano`), add the line, save
(Ctrl+O, Enter, Ctrl+X), then check with `crontab -l`:
```
0 21 * * * /home/aceva/bin/aceva-backup.sh >> /home/aceva/aceva-backup.log 2>&1 && /home/aceva/bin/aceva-offsite.sh >> /home/aceva/aceva-backup.log 2>&1
```
Cron uses the server's time zone. On a server in UTC this is 02:00 in Pakistan. Check with `timedatectl`.

**Where to keep the files, and for how long:**

- On the VPS: 14 days (the script deletes older ones).
- Off the VPS: at least 30 days. Ask the Finance person how long finance records must be kept, and use that. Set the
  deletion rule on the receiving side (Step 5, point 4).
- Every Monday somebody looks at `ls -l /var/backups/aceva` and the date of `LAST_OK`, and at the newest files on the
  backup host. A backup nobody checks is not a backup.

The dump holds the `public` schema only: our 91 tables, the functions, triggers and `_prisma_migrations`. It does not
hold Supabase's own schemas or the login roles. Recreate roles from sections 6.3 and 6.4.

### 10.3 Restore test (do it on staging, then every quarter)

Never test a restore by restoring over a live database. Use a **separate, short-lived machine**: a throw-away VPS, or a
computer that nobody else uses. **Never the production VPS, and never a developer's everyday PC.** A production dump
holds real HR, payroll and bank data. When the test is done, delete the machine (or wipe its disk). `shred` cannot erase
a file reliably on a journaling file system, on an SSD or in a snapshot, so the machine itself is what gets destroyed.

**Never restore a production dump into staging, and never a staging dump into production.** Check the environment in the
file name.

1. **On the test machine (bash).** Install PostgreSQL 17 (do the repository steps of 7.2 first, because Ubuntu's own
   package is version 16), `age`, and make a scratch database:
   ```bash
   sudo apt install -y postgresql-17 age
   sudo -u postgres createdb aceva_restore_test
   ```
2. Copy the encrypted files from the off-site place to the test machine (for example `scp` them from the backup host).
3. Get the secret key from the password manager into a file. Make it empty with the right mode first:
   ```bash
   install -m 600 /dev/null ~/key.txt
   nano ~/key.txt
   ```
   Paste the line `AGE-SECRET-KEY-...`, and save.
4. Restore the database. The decrypted dump is **piped**, so no plain copy of it ever lands on the disk:
   ```bash
   age -d -i ~/key.txt db-<environment>-<stamp>.dump.age | sudo -u postgres pg_restore --no-owner --no-privileges --dbname aceva_restore_test
   ```
   A message that schema `public` already exists is expected. Any other error is not.
5. Compare with the live database. Run in `psql` on the scratch database (`sudo -u postgres psql aceva_restore_test`)
   and in the Supabase SQL Editor, and compare the numbers (small differences are fine if the app has been used since):
   ```sql
   select (select count(*) from employees) as employees,
          (select count(*) from audit_log) as audit_log,
          (select count(*) from _prisma_migrations) as migrations;
   ```
6. Restore the files the same way into a scratch folder and open one document:
   ```bash
   mkdir ~/restore-files
   age -d -i ~/key.txt files-<environment>-<stamp>.tar.age | tar -x -C ~/restore-files
   ```
7. Clean up: `sudo -u postgres dropdb aceva_restore_test`, remove `~/restore-files` and `~/key.txt`, then **delete the
   machine**.
8. Write the date, the file used and how long it took in the team's log.

> Check: these restore commands have not been run against real Supabase dumps yet. The first restore test on staging
> proves them. Fix this guide with what you find.

### 10.4 Disaster: restoring into a new Supabase project

1. Create a new project and do sections 3, 4 and 5 for it (new database password, so also a new `DATABASE_URL` in
   `/etc/aceva/api.env`). In `~/aceva-db.conf` change `project_ref` and `host`.
2. Put the new project's **owner** line into `~/.pgpass` (`nano ~/.pgpass`, one more line like the one in 10.2 step 1,
   with `postgres.<new-project-ref>`). Put the secret backup key into a file (10.3 step 3). Then restore the newest
   **production** dump. **Check that the file name says `production`.** The password is read from `~/.pgpass`, so it is
   neither on the command line nor in the process list, and no plain dump file exists:
   ```bash
   export PGSSLMODE=verify-full PGSSLROOTCERT=/etc/aceva/supabase-ca.crt PGPASSFILE="$HOME/.pgpass"
   age -d -i ~/key.txt db-production-<stamp>.dump.age | pg_restore --host <new-pooler-host> --port 5432 --username postgres.<new-project-ref> --dbname postgres --no-owner --no-privileges
   ```
   Read every error. The only expected one is that schema `public` already exists.
3. Do 4.2 again (rights), then 4.5 (time zone), then 6.3 and 6.4 (the logins, with new passwords), then 4.7.
4. Run `~/aceva-db.sh status`. It must say `Database schema is up to date!`.
5. Put back the files and the same `DATA_ENCRYPTION_KEY`, change `DATABASE_URL` in `/etc/aceva/api.env`, restart the
   API, run section 9.
6. Clean up. Delete the owner line from `~/.pgpass` and the key file `~/key.txt`. The backup key was on a server, so
   make a **new** key pair (10.2 step 2), put its public key into the script, and retire the old one.

### 10.5 Practise the Supabase restore once (only if staging is on Pro)

Restore a daily backup of staging from the dashboard once, before production. Learn how long the project is unavailable,
and check that the API reconnects. After it, redo 6.3 step 8 if you use the API login (and reset `aceva_backup`).

---

## 11. Production

### 11.1 What is different

Make a **second Supabase project** (`aceva-production`, in its own organization, 2.1) with sections 3 to 7. **Production
uses its own VPS. Sharing a VPS with staging is not allowed.** Staging runs with weaker controls (a public site with
one shared demo password, a habit of typing `NODE_ENV=development`, Mailpit, possibly a Free project with no network
restrictions). On a shared VPS, one compromise of staging would reach the production secrets on the same disk, and the
production network list would admit every staging process. The VPS's public IPv4 is the only server address in the
production network restrictions (4.4).

| | Staging | Production |
|---|---|---|
| VPS | its own | **its own** (never shared with staging) |
| Supabase organization | staging organization | production organization, only the owner and one administrator |
| Supabase plan | Free or Pro | **Pro** (compute at least Micro) |
| Backups | none on Free | daily, and the nightly dump; decide on **PITR** |
| Network restrictions | if the plan has them | **On** (only the production VPS) |
| SSL enforcement | on | **on** |
| Data API, rights | off, revoked | **off, revoked** (4.1, 4.2) |
| Database password, `DATA_ENCRYPTION_KEY`, Redis password | their own | **new and different** (never reuse staging's) |
| API login | owner at first, then `aceva_api` | **`aceva_api` (6.3), required**; no owner password in `/etc/aceva/api.env` |
| API settings | `/etc/aceva/api.env` with `NODE_ENV=production` | the same; no `DEMO_PASSWORD` anywhere; **no `backend/.env`** |
| `~/aceva-db.conf` | `env_name=staging` | `env_name=production` (the demo seed commands then refuse) |
| Data | demo seed (8.1) | the bootstrap (8.2), then real data |
| Mail | Mailpit | a real SMTP service with `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` (in double quotes if it has `#`, a space or `$`, 7.4), and `MAIL_FROM` on a domain with SPF and DKIM set up (otherwise the mails land in spam) |
| `GEOIP_RANGES` | empty | decide before go-live (9.1): empty means the "new city" alert never fires |
| `CORS_ORIGIN`, `APP_URL` | `https://staging.<your-domain>` | the real `https://` address, exactly the same value in both |
| Website build | `mock` mode with the module list (9.2) | the same, but **no screen backed by the in-browser demo data may be reachable** (11.3) |
| Web server | team addresses only (9.5) | open to staff (remove the `include` lines); `/api/docs` hidden |

### 11.2 Cut-over checklist

Do it in a quiet period, with two people.

Before the day:

1. The same commit has been through staging: migrations, a full sign-in and screen round, and the restore test.
2. Production project exists, locked down, and 5.6 and 7.6 pass from the production VPS.
3. The bootstrap script exists and has been rehearsed on a scratch database (8.2).
4. Real SMTP works (send one test mail).
5. A backup plan is working (10.2, with the off-site copy), and the restore test has been done once.
6. The owner has decided about PITR.
7. **The API runs as `aceva_api` (6.3), 9.4 and a full screen round have passed with it on staging, and the production
   settings file holds no owner password.** There is no `backend/.env` on the production VPS.
8. SSH is hardened (7.1), the services run as `aceva-api` and `aceva-web`, and the production VPS is not shared with
   staging.
9. The items in 11.3 are done or knowingly accepted.
10. Tell the staff the time of the maintenance window.

On the day:

1. Check the target: the "which database" command from 7.4 and the helper's own "Target" line show the production
   `<project-ref>`.
2. Take a backup first: `~/bin/aceva-backup.sh` (and a Supabase backup or PITR marker in the dashboard).
3. `~/aceva-db.sh status`, then `~/aceva-db.sh deploy`.
4. Run the bootstrap (8.2), and the counts.
5. Start the API and the website. Check `https://<your-domain>/api/v1/health`, and 9.4 (UTC).
6. The Owner and the Director set their passwords and 2FA (8.2). Smoke test: sign in, one task, one leave request, one
   attendance entry, one mail.
7. Run the Security Advisor and the "open tables" query (4.2).
8. Open the site to staff.

Rollback plan:

- **Before real data exists:** stop the services. If the database has to start again, delete the project and create a
  new one (sections 3 to 7). Nothing is lost.
- **After real data exists:** Prisma Migrate has no "undo". Rolling back the code after a migration needs a database
  restore. Use PITR to the minute before the deploy, or the dump taken in step 2. Then deploy the previous commit.
  Expect the project to be unavailable during the restore.
- Keep the previous release folder or tag until the new one has run a full day.

### 11.3 Open items for the team

1. **The production bootstrap script** (8.2). Production cannot go live without it.
2. **A deployment guide** for the web server, services and updates. 9.3 and 9.5 only show enough to sign in.
3. **A pool size setting.** The app does not set a maximum, so each API process opens up to 10 database connections
   (`pg`'s default). A lower value needs a small code change.
4. **Certificate check by the migration program on Linux** (7.6 step 3). Untested on the real servers.
5. **The API login's exact rights** (6.3). Proven only after a staging round.
6. **Function `search_path` warnings** in the Security Advisor (4.6). Needs a migration, so it is a later task.
7. **File storage.** Files live on the VPS disk (documents, photos, task attachments, receipts). Supabase Storage is not
   used. A second copy exists only through the nightly job. Imported bank statements are not files: they are in the
   database.
8. **Whether the company accepts that HR, payroll and finance data sit with a foreign provider.** The data is encrypted
   at rest, and some fields are also encrypted by the app. Management should decide and sign it off knowingly.
9. **A code guard against demo data on production.** Today only habit and the helper stop the demo seeds, because they
   check nothing but `NODE_ENV`. Suggested: the demo seeds refuse when the database carries a production marker, for
   example `alter database postgres set app.environment = 'production'`, read with
   `current_setting('app.environment', true)`. (Check that the dashboard accepts this setting.)
10. **No screen backed by the in-browser demo data in the production build.** Some screens of modules that are not built
    yet (for example the Settings screen that edits tax slabs) are "mock only" in the code. They show made-up data and
    keep changes only in the browser. Before go-live, no such screen may be reachable in the production build. Hide the
    menu entries, or build production in `live` mode so unbuilt modules fail visibly.
11. **Any Security Advisor error that stayed** after 4.2 (4.6), written here by name.

---

## 12. Running it

### 12.1 Deploy a new version

**VPS (bash)**, in this order. The database changes **before** the API restarts:

1. Backup first, for production always: `~/bin/aceva-backup.sh`.
2. Fetch the code: `cd ~/Aceva-CRM && git fetch && git checkout <tag-or-commit> && git status` (clean).
3. `npm ci && npm run build:contracts && npm run db:generate -w backend` (with `NODE_ENV` not set, 7.3).
4. `~/aceva-db.sh status`, read what it will apply, then `~/aceva-db.sh deploy`.
5. `npm run build` (the website variables from 9.2 must be in `frontend/.env.production` when you build).
6. `sudo systemctl restart aceva-api aceva-web`
7. `curl -s https://<your-domain>/api/v1/health`, then a short smoke test.

Notes:

- Between steps 4 and 6 the old API runs on the new database. A migration that only adds things is safe. For a migration
  that removes or renames something, **stop the API first** (`sudo systemctl stop aceva-api`), migrate, then start the
  new one.
- Never run two deployments at once. Two migrations at once fight for the lock (section 13).
- Staging always goes first, with the same commit.

### 12.2 Change the database password

1. In the password manager, make the new password (letters and digits, 32 characters).
2. Dashboard, **Database Settings**, **Database password**, **Reset database password**. Enter the new one. From now on
   every connection with the old password fails, so do the next steps at once.
3. The owner password is not stored on the VPS: `~/aceva-db.sh` asks for it. If the API still uses the owner login
   (staging, at the start), change `DATABASE_URL` in `/etc/aceva/api.env` (`sudo nano`), then
   `sudo systemctl restart aceva-api`.
4. Run 7.6 step 1 and 9.3 to check.
5. For the custom logins: `\password aceva_api` in `psql` (6.3), then change `DATABASE_URL` in `/etc/aceva/api.env` and
   restart the API. `\password aceva_backup` (6.4), then change `~/.pgpass`.
6. Plan 2 minutes of downtime. Do it in a quiet hour.
7. Do the same whenever a password was typed into a shell or pasted into a chat (delete the line from
   `~/.bash_history` too), and whenever someone with access to the project leaves the team (also remove them from the
   Supabase organization, 2.1).

### 12.3 Connection limits and pool size

| Compute | Direct connections | Pooler clients | Pool size (per login) |
|---|---|---|---|
| Free (Nano) and Micro | 60 | 200 | 15 |
| Small | 90 | 400 | 15 |
| Medium | 120 | 600 | 15 |
| Large | 160 | 800 | 20 |

- The **pool size** is the number of real database connections per login, database and mode. In session mode the number
  of clients is capped at the pool size. Supabase's pages disagree on whether the extra client waits (up to about a
  minute, says the Supabase FAQ) or is refused at once with `max clients reached ... pool_size`. **Plan as if it is
  refused at once.**
- While the API uses the owner login (staging at the start), one pool of 15 is shared by: the API (up to 10), a
  migration, a seed, and every `psql` session. One API process plus one other job fits. A second API process, or several
  `psql` windows left open, do not.
- To raise it: Dashboard, **Database Settings**, **Connection pooling**, **Pool size** (the name may differ). Do not set
  it close to the direct limit: Supabase's own services use connections from the same total.
- The API login (6.3) gets its own pool, and the backup login (6.4) another one.
- A very long statement is cut off: the Supabase timeouts page says the `postgres` login has a default cap of about 2
  minutes. If a dump or a migration step needs longer, `alter role postgres set statement_timeout = '10min';` works
  through the poolers. Check: the default for a custom login such as `aceva_api` or `aceva_backup` is not documented.

### 12.4 Monitoring

- **Our own check:** ask `https://<your-domain>/api/v1/health` every minute from outside (any uptime service) and alert
  on anything but `"status":"ok"`.
- **Supabase dashboard:** **Reports** (connections, CPU, memory, disk), **Advisors** (security and performance). Look at
  them weekly, and after each deploy.
- **Billing:** set the e-mail for invoices to a mailbox that is read. An overdue invoice pauses projects.
- **Backups:** the Monday check in 10.2.
- **Disk:** watch the database size. The audit and ledger tables only grow.
- **Logs:** `journalctl -u aceva-api`. The API logs a warning if Redis is down (it keeps running, with sessions from
  PostgreSQL).
- **Access:** the members of both Supabase organizations and the VPS provider's account, every quarter (2.1).

### 12.5 Upgrades

- **Supabase:** a Postgres upgrade or a compute change puts the project offline for a while (a resize usually takes under
  2 minutes). There is no fixed maintenance window. Choose the time yourself, take a dump first, and try on staging
  first. Enforcing SSL reboots the database (4.3). After a Supabase upgrade or a restore, run 4.2, 7.8 and the Security
  Advisor again.
- **PostgreSQL major version:** after an upgrade of the server to a newer major version, install the matching
  `postgresql-client-<n>` (7.2), or `pg_dump` will refuse to run.
- **Node, Prisma, `pg`:** update on staging, run 7.6 (including the failing checks in step 3), run the migrations, then
  9. Also run `~/aceva-db.sh cert-tests` again on the production VPS after the update there. The SSL behaviour of `pg`
  changes in its next major version (`sslmode=require`). Our URL uses `verify-full`, so it is ready.
- **The Supabase certificate:** the file has an end date (5.3). Download the new one in good time, check it, replace
  `/etc/aceva/supabase-ca.crt`, and run 5.6 and 7.6 before and after.
- **The IPv4 address of the VPS** is in the network restrictions (4.4). Change it there first if the VPS is replaced.

---

## 13. Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| `self signed certificate in certificate chain` (`SELF_SIGNED_CERT_IN_CHAIN`) from the API, a seed or the connection check | The Node driver does not trust Supabase's certificate. The URL has no `sslrootcert`, or it says `sslmode=require` only. | Use the app URL from 5.4 (`sslmode=verify-full` and `sslrootcert=/etc/aceva/supabase-ca.crt`). Check that the file exists and is readable (5.3). To find out whether the certificate is the cause, run the check in 5.6. It sends no password. **Never** connect with `sslmode=no-verify`, `sslaccept=accept_invalid_certs` or `uselibpqcompat=true` while the real password is in the URL. If 5.6 fails, stop and compare the host and the certificate fingerprint with 2.4. |
| `ENOENT: no such file or directory, open '/etc/aceva/supabase-ca.crt'` or `EACCES` | The certificate file is missing or not readable by the user that runs the program. The path is read at each new connection. | Fix the path and the permissions (5.3). Use an absolute path. A relative path depends on the folder the program was started in, which differs under systemd. |
| `connect ENETUNREACH 2a05:...:5432` (an IPv6 address), or Prisma `P1001: Can't reach database server at db.<project-ref>.supabase.co:5432` | The URL uses the direct host, which is IPv6 only, and the VPS has no IPv6. | Use the session pooler host from the Connect dialog (5.2). Do not buy the IPv4 add-on for this. |
| `password authentication failed for user "postgres.<project-ref>"` (or `"postgres"`) | Wrong password, a password with special characters not encoded in the URL, or the password was reset. | Check the password in the password manager. Letters and digits only avoids encoding. After a reset, update `/etc/aceva/api.env` and `~/.pgpass` where they hold it (12.2). If the user in the message is just `postgres`, the URL probably points at the direct host (`db.<project-ref>.supabase.co`). Use the session pooler string from Connect (5.2). A pooler user name without the project ref gives `Tenant or user not found` instead (next row). |
| `FATAL: Tenant or user not found` | The user name has no `.<project-ref>`, the project reference is wrong, or the host is not the project's pooler host. | Copy the user and host from Connect (5.2). The user is `postgres.<project-ref>` (or `aceva_api.<project-ref>`, `aceva_backup.<project-ref>`). Do not build the host from the region: the `aws-0` or `aws-1` part is a group number. |
| `too many connections`, `sorry, too many clients already`, or an error with `max clients reached` and `pool_size` (the wording differs by version) | More clients than the pool allows (15 on small computes), or too many direct connections. | Close `psql` windows. Run only one API process. Check what is connected in the SQL Editor: `select usename, state, count(*) from pg_stat_activity group by 1, 2;`. Raise the pool size or use the API login (12.3, 6.3). |
| `prepared statement "s0" already exists` or `prepared statement "s1" does not exist` | The connection goes through the **transaction** pooler (port 6543) or an old PgBouncer. | Use port **5432** on the pooler host. Do not add `pgbouncer=true`. |
| Migration stops with `P1002` and `Timed out trying to acquire a postgres advisory lock (SELECT pg_advisory_lock(72707369))` after about 10 seconds | Another migration is running, a crashed earlier one still holds the lock, or the URL uses port 6543. | Wait and try again. Make sure nobody else is deploying. Check the port. Find the holder in the SQL Editor: `select l.pid, a.usename, a.state, a.query_start from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.locktype = 'advisory' and l.granted;`. If it is a dead migration session, end it with `select pg_terminate_backend(<pid>);`. Last resort only, and only when you are sure nothing else is migrating: `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK=1` for that one run. It removes the safeguard. |
| `P1011` with `root certificate not trusted` or `cert file not found` from `migrate` | The migrate URL has `sslaccept=strict` but the certificate is missing, unreadable, or not the **first** certificate in the file. | Check that the file in 5.3 exists and that the root is first (`grep -c BEGIN`). Only as a **last resort**, and only after a developer agrees and it is written in the server log, install the certificate in the server's trust store (`sudo cp /etc/aceva/supabase-ca.crt /usr/local/share/ca-certificates/supabase-ca.crt && sudo update-ca-certificates`) and retry. After that, **test 1 in 7.6 step 3 can no longer prove anything**. Use test 2 (the host-name test) and test 3 from then on. |
| `psql` or the SQL Editor shows times in another zone, `SHOW timezone` is not `UTC` | The pooler dropped `-c TimeZone=UTC` and the database or login is not in UTC. No error is shown. All times are stored as `timestamptz`, so the stored times are right. Only how they print changes (and how any future `::date` or `date_trunc` SQL behaves). | Run the SQL in 4.5, restart the API, run 9.4. |
| `NOTICE` lines about ignored startup parameters in the logs | Newer pooler versions say the time zone option was ignored. | Harmless. Keep the time zone set in 4.5. |
| `are treated as aliases for 'verify-full'` (Node shows it as `(node:<pid>) Warning: SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' ...`) | An app or seed URL has `sslmode=require`. | Use `sslmode=verify-full` in `DATABASE_URL`. `require` belongs only in the migrate URL. |
| `ERR_TLS_CERT_ALTNAME_INVALID` | The host in the URL is not the name in the certificate (for example an IP address or an old host). | Use the host from Connect, not an IP address. |
| A seed or any screen action fails with `Transaction already closed` or `P2028`, or a timeout | Round trips to the database are too slow (7.6 step 1). Most actions run in a transaction with a 5-second limit, and the seed is one 60-second transaction. | Move the VPS closer to the project (same region). Run seeds on the VPS, not from a laptop. Do not raise limits. |
| `Refusing to seed demo data in production.` or `Refusing to create demo logins in production.` | `NODE_ENV=production` is set. This is the safety check. | On staging only, use `~/aceva-db.sh seed` and `~/aceva-db.sh seed-passwords` (8.1, 9.6). On production it must stay. |
| `DATABASE_URL is not set` when a seed or `db:reset` is started by hand | There is no `backend/.env` on the server, on purpose (5.5). | Use `~/aceva-db.sh`. Do not create `backend/.env` to make it work. |
| `403 origin_not_allowed` on every save | `CORS_ORIGIN` is not exactly the address in the browser (`http` or `https`, `www`, a trailing slash). | Make it identical to the site address, restart the API. |
| Sign-in works but you are signed out at once, or the screens show fake data | No HTTPS (cookie dropped), or the website was built without the `NEXT_PUBLIC_` lines (9.2). | Use HTTPS (9.5). Rebuild the website with the variables set. |
| Every user is blocked after a few wrong passwords, or every sign-in shows the same address | `TRUST_PROXY` is 0 behind the web server. | Set `TRUST_PROXY=1` (9.1) and restart. |
| Every authenticator code is refused | The VPS clock is more than 30 seconds out. | Run `timedatectl` and fix it (7.1). |
| `permission denied for table ...` or `... for sequence ...` | The API login is missing a grant (6.3). | Add the grant as the `postgres` login. Write it into this guide. |
| `EACCES` or `Permission denied` for files under `/home/aceva/Aceva-CRM` when a service starts | The service user cannot walk through the admin's home folder. | `sudo chmod 711 /home/aceva` (7.1). |
| The service fails with `status=226/NAMESPACE` | A folder named in `ReadWritePaths` does not exist. | Make `/var/lib/aceva/files` (9.1). |
| The API starts but `/api/v1/health` says `"database":"down"` | The database is unreachable: paused (Free), network restriction, wrong password, or the certificate. | Check the project is active in the dashboard, then run 7.6 step 1 for the exact error. |
| `Invalid environment configuration:` followed by a list | A variable is missing or wrong (`DATA_ENCRYPTION_KEY` must be 32 bytes in base64, `REDIS_URL` must start with `redis://`). | Fix each line in the list in `/etc/aceva/api.env`. |
| A mail fails with an authentication error, only on production | The SMTP password has a `#` or a space and was cut short. | Put the value in double quotes (7.4). |

---

## 14. Sources

Supabase (read on 2026-11-23). The dashboard moves things (checked on 2026-11-23), so use these pages if a menu name
here does not match.

- Connecting to Postgres, pooler modes, IPv4 and IPv6, limits:
  https://supabase.com/docs/guides/database/connecting-to-postgres
- Pooling and limits:
  https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits
- Connection management: https://supabase.com/docs/guides/database/connection-management
- Prisma with Supabase (session pooler for servers): https://supabase.com/docs/guides/database/prisma
- Prisma troubleshooting on Supabase (max client connections):
  https://supabase.com/docs/guides/database/prisma/prisma-troubleshooting
- IPv4 add-on: https://supabase.com/docs/guides/platform/ipv4-address and
  https://supabase.com/docs/guides/platform/manage-your-usage/ipv4
- SSL enforcement and the certificate (Database Settings, SSL Configuration):
  https://supabase.com/docs/guides/platform/ssl-enforcement
- Network restrictions: https://supabase.com/docs/guides/platform/network-restrictions and
  https://supabase.com/changelog/20522-supavisor-starts-enforcing-network-restrictions
- Securing the Data API (switch off, default rights): https://supabase.com/docs/guides/api/securing-your-api
- Change: tables not exposed automatically:
  https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically
- Advisors (Security Advisor): https://supabase.com/docs/guides/observability/advisors
- Security Advisor rule 0013 (source of the lint):
  https://raw.githubusercontent.com/supabase/splinter/main/lints/0013_rls_disabled_in_public.sql
- Production checklist: https://supabase.com/docs/guides/security/production-checklist
- API keys (publishable and secret keys; the legacy `anon` and `service_role` keys are being retired):
  https://supabase.com/docs/guides/getting-started/api-keys
- Regions: https://supabase.com/docs/guides/platform/regions
- Pricing: https://supabase.com/pricing
- Billing (Free and paid projects cannot share an organization), cost control, free project pausing:
  https://supabase.com/docs/guides/platform/billing-faq,
  https://supabase.com/docs/guides/platform/cost-control and
  https://supabase.com/docs/guides/platform/free-project-pausing
- Compute sizes and limits: https://supabase.com/docs/guides/platform/compute-and-disk
- Backups: https://supabase.com/docs/guides/platform/backups
- Point-in-time recovery: https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery
- Backup and restore (dump and restore commands):
  https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore
- Upgrades: https://supabase.com/docs/guides/platform/upgrading
- Roles and the `postgres` role: https://supabase.com/docs/guides/database/postgres/roles and
  https://supabase.com/docs/guides/database/postgres/roles-superuser
- Time zone configuration: https://supabase.com/docs/guides/database/postgres/configuration
- Statement timeouts: https://supabase.com/docs/guides/database/postgres/timeouts
- "Tenant or user not found": https://supabase.com/docs/guides/troubleshooting/tenant-or-user-not-found
- Supavisor drops startup options: https://github.com/supabase/supavisor/issues/1272 and
  https://github.com/supabase/supavisor/pull/1273
- Supavisor FAQ: https://supabase.github.io/supavisor/faq/ and the Supabase knowledge-base FAQ (session mode and the
  queue of clients): https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI
- Open report about the pooler's intermediate certificate: https://github.com/supabase/supabase/issues/50862

Prisma:

- Migrations in production and the advisory lock:
  https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production
- PostgreSQL connection options: https://www.prisma.io/docs/orm/overview/databases/postgresql
- System requirements: https://www.prisma.io/docs/orm/reference/system-requirements
- Prisma 7 config reference (no direct URL): https://www.prisma.io/docs/orm/v7/reference/prisma-config-reference
- Poolers and Prisma: https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections/pgbouncer
- Community report on TLS in the CLI: https://github.com/prisma/orm/discussions/28610
- URL options read by the migration program (source code). The link is the commit of the engines that ship with Prisma
  7.10.1; if it does not open, read the same file on the `main` branch:
  https://github.com/prisma/prisma-engines/blob/d1b3f377ca835d73fd50954a5e22128b9ebdd6b8/quaint/src/connector/postgres/url.rs

Drivers and tools:

- node-postgres SSL: https://node-postgres.com/features/ssl
- `pg-connection-string` (the `sslmode` and `sslrootcert` rules):
  https://github.com/brianc/node-postgres/blob/master/packages/pg-connection-string/README.md
- Node.js command-line options (`NODE_EXTRA_CA_CERTS`): https://nodejs.org/api/cli.html
- `pg_dump`: https://www.postgresql.org/docs/current/app-pgdump.html
- PostgreSQL packages for Ubuntu: https://www.postgresql.org/download/linux/ubuntu/
- Node.js packages for Ubuntu (NodeSource): https://github.com/nodesource/distributions
- Mailpit: https://github.com/axllent/mailpit/releases and https://mailpit.axllent.org/docs/
- age (file encryption): https://github.com/FiloSottile/age and https://github.com/FiloSottile/age/releases
- GitHub's published SSH key fingerprints:
  https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
- GitHub deploy keys: https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys
- systemd (`EnvironmentFile` and the sandbox settings):
  https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html
- nginx access rules and the real-address module:
  https://nginx.org/en/docs/http/ngx_http_access_module.html and
  https://nginx.org/en/docs/http/ngx_http_realip_module.html
- certbot: https://certbot.eff.org/
- sshd settings: https://man.openbsd.org/sshd_config

In this repository:

- `docs/SETUP.md` (local development), `backend/.env.example`, `backend/prisma.config.ts`,
  `backend/src/prisma/connection.ts`, `backend/src/config/env.ts`, `backend/src/main.ts`,
  `backend/prisma/seed-data.ts`, `docs/M7-M9-DECISIONS.md`.
