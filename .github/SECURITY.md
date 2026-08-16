# Security Policy

Invook processes private mailbox data and provider credentials. Please report
suspected vulnerabilities privately so maintainers can investigate before
details are disclosed publicly.

## Supported Versions

Invook has not published a stable release. Security fixes are applied to the
latest commit on the `main` branch. Older commits and unmaintained branches are
not supported.

## Reporting a Vulnerability

Email <hello@thinkingsoundlab.com> with the subject
`[Invook security] <short description>`. Do not open a public GitHub issue,
discussion, or pull request for an undisclosed vulnerability.

Include, when available:

- the affected component, route, or commit;
- a clear description and potential impact;
- minimal steps or a proof of concept that reproduces the issue;
- required configuration and whether the issue is remotely exploitable;
- suggested mitigations; and
- how you would like to be credited, or whether you prefer anonymity.

Use synthetic data and redact all credentials, access tokens, email content,
raw MIME, attachments, and provider payloads. If sensitive evidence is required,
ask the maintainers to agree on a safe transfer method before sending it.

Maintainers will acknowledge the report as soon as practical, validate its
scope, and coordinate remediation and disclosure with the reporter. A report
may be declined when it cannot be reproduced, affects only an unsupported
version, or concerns a third-party service outside Invook's control; in that
case, the maintainers will explain the decision when possible.

## Disclosure

Please allow maintainers reasonable time to investigate and release a fix
before public disclosure. Once remediation is available, maintainers may publish
a GitHub Security Advisory describing the impact, affected versions, fix, and
reporter credit.
