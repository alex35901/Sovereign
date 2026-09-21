# Security policy

Sovereign is a self-hosted household budgeting application. One household runs one copy, on
infrastructure it rents in its own name. This document says what is promised about keeping that
copy safe to run, and on what timetable.

## Reporting something

Open a GitHub issue. If the finding is one that could be used against a running deployment before
it is fixed, say so in the first line and leave the details out; a private channel will be arranged
in the reply.

## Patching identified vulnerabilities

An identified vulnerability is one reported by `npm audit`, by Dependabot, by a provider's own
advisory, or by a person. The clock starts when it is identified, not when it is triaged.

| Severity | Fixed and deployed within |
| --- | --- |
| Critical | 7 days |
| High | 14 days |
| Moderate | 30 days |
| Low | 90 days, or the next dependency pass |

Severity is the advisory's own rating, adjusted down only with a written reason on the issue, and
only for a path this application does not take. A development-only dependency that cannot reach a
running deployment is Low regardless of its rating.

Deployment is part of the window, not after it. A fix merged and not deployed has not been made.

### How they are identified

- **Dependabot** opens a pull request for every advisory affecting a dependency, and a weekly pull
  request for ordinary updates. Configured in `.github/dependabot.yml`.
- **`npm run audit`** runs the same check by hand, and fails on anything Moderate or worse that has
  a fix available.
- **`npm run eol`** reports runtimes and dependencies that have passed, or are about to pass, the
  end of their support.

Both scripts are part of `npm run check`, which builds, audits, checks end-of-life dates and runs
the unit suite. That is what a release is expected to pass.

## End-of-life software

Nothing is run past the end of its upstream support. In practice this is a small list, because the
application has few moving parts:

| Component | Policy |
| --- | --- |
| Node.js | An Active LTS or Current release. Moved off a line within 30 days of that line entering maintenance-only, and never run after its end-of-life date. Pinned in `package.json` under `engines`. |
| Postgres | A version still receiving upstream minor releases. The provider applies these; the version is checked at each dependency pass. |
| Direct dependencies | A major version still receiving fixes upstream. A dependency whose upstream has stopped is replaced or vendored, not left in place. |
| Browsers | The application targets current evergreen browsers. No support is promised for a browser its vendor no longer updates. |

`npm run eol` prints the Node end-of-life dates it knows about and compares them against what is
configured, so the date arrives as a failing check rather than as a surprise.

## What is deliberately not stored

The document is encrypted in the browser and the server cannot read it. Credentials that authorise
every request live in server environment variables and never reach the browser. Credentials that
belong to the household live inside the encrypted document. See
[the privacy policy](public/privacy.html) for the whole of it.
