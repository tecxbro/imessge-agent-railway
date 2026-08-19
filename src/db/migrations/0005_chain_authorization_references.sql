CREATE TABLE "chain_authorization_identities" (
	"chain_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"is_principal" boolean NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_authorization_identities_pk" PRIMARY KEY("chain_id","identity_id")
);
--> statement-breakpoint
ALTER TABLE "chain_authorization_identities" ADD CONSTRAINT "chain_authorization_identities_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_authorization_identities" ADD CONSTRAINT "chain_authorization_identities_identity_id_channel_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."channel_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chain_authorization_one_principal_unique" ON "chain_authorization_identities" USING btree ("chain_id") WHERE "chain_authorization_identities"."is_principal" = true;--> statement-breakpoint
CREATE INDEX "chain_authorization_identity_idx" ON "chain_authorization_identities" USING btree ("identity_id");
