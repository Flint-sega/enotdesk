# Security Policy

EnotDesk gives remote control of real machines, so vulnerabilities are taken seriously. Please help keep users safe by reporting privately.

## Supported versions

Only the latest release and the `main` branch receive security fixes. There are no LTS branches.

## How to report a vulnerability (private channel)

**Do not open a public issue for a security problem.**

Use GitHub’s private vulnerability reporting on this repository:
<https://github.com/Flint-sega/enotdesk/security/advisories/new>

This channel is private — only maintainers see the report until a fix is ready and you agree to disclose. If private reporting is unavailable for some reason, contact the maintainer directly and ask for an encrypted channel before sending details.

Please include:

- affected component (server `server/app.mjs` routes / signaling, client input pipeline, preload bridge, file serving, …);
- steps to reproduce or a proof of concept;
- impact you believe it has;
- any constraints on disclosure.

## What to expect

- Acknowledgement within 7 days.
- An assessment and a fix timeline within another 14 days for accepted reports.
- Credit in the release notes if you wish (say so in the report).

## Scope notes

In scope: the HTTP/WS API (`/api/v1`, `/signal`), authentication and tokens, RBAC, the input protocol allowlists, DataChannel services (chat/clipboard/file), file serving from the dist directory, the preload bridge boundary, and the docker stack.

Out of scope: issues requiring physical access or a malicious local user on either machine; social engineering of session participants (the consent model requires the human to approve); self-XSS in chat content beyond protocol limits; reports about unsigned builds — unsigned binaries are a documented, deliberate trade-off (see README “Security notes”), though a real way to bypass the consent prompt is very much in scope.

## Safe testing

Test only against servers and machines you own or have explicit permission to control. EnotDesk sessions are designed to be visible to the receiving user — do not test on third parties.
