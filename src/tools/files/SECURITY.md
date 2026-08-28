# File-tool path safety notes

The resolver canonicalizes the fixed workspace root, rejects absolute, UNC, device, drive-relative,
home-relative, and parent-segment inputs, and checks real paths using the host platform's path
semantics. On Windows, `path.relative` and the explicit `.git` comparison therefore enforce
case-insensitive containment and write denial.

Existing targets are resolved through symbolic links and directory junctions. A new target is
rebased onto its immediate existing parent's real path. Writes repeat this resolution immediately
before opening the file and fail if existence or the canonical target changed.

This repeated check narrows but cannot eliminate the filesystem TOCTOU window between final
validation and the operating-system open/write call. The first version does not claim protection
against a malicious local process racing path components; OS-level handles or sandboxing would be
needed for that guarantee.
