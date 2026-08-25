import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const chatRateLimits = sqliteTable("chat_rate_limits", {
  visitorHash: text("visitor_hash").primaryKey(),
  minuteWindow: integer("minute_window").notNull(),
  minuteCount: integer("minute_count").notNull().default(0),
  dayWindow: integer("day_window").notNull(),
  dayCount: integer("day_count").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

export const chatMessages = sqliteTable("chat_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  visitorHash: text("visitor_hash").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  status: text("status").notNull(),
  origin: text("origin").notNull(),
  model: text("model"),
  reasoning: text("reasoning"),
  ipAddress: text("ip_address"),
  country: text("country"),
  region: text("region"),
  city: text("city"),
  latitude: text("latitude"),
  longitude: text("longitude"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_chat_messages_created_at").on(table.createdAt),
  index("idx_chat_messages_session_created").on(table.sessionId, table.createdAt),
]);

export const adminCredentials = sqliteTable("admin_credentials", {
  id: integer("id").primaryKey(),
  username: text("username").notNull(),
  passwordSalt: text("password_salt").notNull(),
  passwordHash: text("password_hash").notNull(),
  iterations: integer("iterations").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
