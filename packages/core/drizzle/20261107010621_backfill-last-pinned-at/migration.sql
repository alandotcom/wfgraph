-- Give every existing draft snapshot a last pin, its creation time, before the check that requires one is added.
UPDATE "workflow_versions"
SET "last_pinned_at" = "published_at"
WHERE "kind" = 'draft_snapshot';
