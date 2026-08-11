CREATE TABLE "collector_state" (
	"symbol" varchar(20) PRIMARY KEY NOT NULL,
	"interval" varchar(8) NOT NULL,
	"last_open_time" timestamp with time zone,
	"last_price" numeric(24, 8),
	"last_price_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"ws_connected_since" timestamp with time zone,
	"reconnect_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "klines" (
	"symbol" varchar(20) NOT NULL,
	"interval" varchar(8) NOT NULL,
	"open_time" timestamp with time zone NOT NULL,
	"close_time" timestamp with time zone NOT NULL,
	"open" numeric(24, 8) NOT NULL,
	"high" numeric(24, 8) NOT NULL,
	"low" numeric(24, 8) NOT NULL,
	"close" numeric(24, 8) NOT NULL,
	"volume" numeric(32, 8) NOT NULL,
	"quote_volume" numeric(32, 8) NOT NULL,
	"trade_count" integer NOT NULL,
	"taker_buy_base" numeric(32, 8) NOT NULL,
	"taker_buy_quote" numeric(32, 8) NOT NULL,
	"is_closed" boolean DEFAULT false NOT NULL,
	"source" varchar(8) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "klines_symbol_interval_open_time_pk" PRIMARY KEY("symbol","interval","open_time")
);
--> statement-breakpoint
CREATE TABLE "pipeline_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pipeline_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"symbol" varchar(20),
	"type" varchar(32) NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "klines_symbol_interval_time_idx" ON "klines" USING btree ("symbol","interval","open_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pipeline_events_ts_idx" ON "pipeline_events" USING btree ("ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pipeline_events_type_ts_idx" ON "pipeline_events" USING btree ("type","ts" DESC NULLS LAST);