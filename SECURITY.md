# Security Policy

## Supported versions

Only the latest published version of `merchid` receives fixes. This project is
pre-1.0: patches land on the newest release, not on older lines.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (Security → Report a vulnerability).

Please include what the issue lets an attacker do, the affected version, and a
minimal reproduction. Expect an acknowledgement within a few days; this is a
single-maintainer project, so timelines are best-effort.

**Never include real credentials in a report** — no session cookies, tokens,
OTP codes, phone numbers, merchant ids, or HAR captures. Redact them, and
describe the shape of the data instead. If a credential of yours has already
leaked, rotate it first: log out of the provider dashboard to invalidate the
session, then report.

## Scope

In scope: credential leakage through logs, error messages, or the published
package; incorrect payment matching that could misattribute funds; session or
token handling flaws in this library.

Out of scope: vulnerabilities in Gojek/GoBiz or Shopee themselves. This project
is an unaffiliated client of their private APIs — report those to the provider.
