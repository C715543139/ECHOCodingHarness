# Testing ECHO Harness

## Automated quality gate

Run `pnpm check` for formatting, linting, type checking, coverage, build, and smoke checks. Tests use
the deterministic `FakeProvider`; CI does not contact a paid model service.

## Real OpenAI-compatible Provider smoke check

The real Provider smoke check is disabled by default. Build first, then explicitly enable one
bounded request from PowerShell:

```powershell
$env:ECHO_RUN_PROVIDER_SMOKE = '1'
$env:ECHO_BASE_URL = 'https://provider.example/v1'
$env:ECHO_API_KEY = '<secret>'
$env:ECHO_MODEL = '<model>'
pnpm build
pnpm smoke:provider
```

The script requires all three Provider settings, disables retries, limits output, applies a
60-second abort timeout, and never prints the key or model response. Remove the API key from the
shell environment after the check.
