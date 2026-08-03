CREATE TABLE "workflow_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"version" integer NOT NULL,
	"graph" jsonb NOT NULL,
	"catalog_fingerprint" text NOT NULL,
	"graph_digest" text NOT NULL,
	"published_at" timestamp DEFAULT (now() at time zone 'utc') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "workflow_version_id" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "published_version_id" text;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_workflow_id_version_uidx" ON "workflow_versions" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE INDEX "workflow_versions_workflow_id_published_at_idx" ON "workflow_versions" USING btree ("workflow_id","published_at");--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "workflow_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_published_version_id_workflow_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "workflow_versions"("id") ON DELETE set null ON UPDATE no action;