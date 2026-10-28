# Cleaning historical audit credentials

The dashboard masks credential values when it reads old audit entries. Old
`audit-log.jsonl` records on disk are left unchanged until an operator chooses
to clean them. New records are redacted before they are written.

Stop **all** app processes or Azure Container App revisions that write the
same audit file before applying the offline cleanup. Use an absolute path to
the actual JSONL file. The commands report counts and never print key values.

```sh
node scripts/redact-audit-log.js --file /absolute/path/to/audit-log.jsonl
node scripts/redact-audit-log.js --file /absolute/path/to/audit-log.jsonl --apply
```

The first command is a dry run. The second atomically replaces the file only
when redaction is needed. Malformed JSON stops the operation before any write
and reports the line number for repair. No cleanup runs during app startup or
settings review.
