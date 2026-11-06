CREATE TABLE "workflow_cancel_decisions" (
	"delivery_id" text,
	"workflow_id" text,
	"decided_at" timestamp NOT NULL,
	CONSTRAINT "workflow_cancel_decisions_pkey" PRIMARY KEY("delivery_id","workflow_id")
);
--> statement-breakpoint
ALTER TABLE "workflow_cancel_decisions" ADD CONSTRAINT "workflow_cancel_decisions_wHqviay3ZngT_fkey" FOREIGN KEY ("delivery_id") REFERENCES "workflow_event_inbox"("id") ON DELETE CASCADE;