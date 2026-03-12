import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  parentId: text('parent_id'),
  title: text('title').notNull(),
  status: text('status').notNull().default('pending'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const checkpoints = sqliteTable('checkpoints', {
  checkpointId: text('checkpoint_id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  stepId: text('step_id').notNull(),
  llmContextRef: text('llm_context_ref').notNull(),
  pendingApprovalId: text('pending_approval_id'),
  createdAt: text('created_at').notNull(),
});

export const auditLogs = sqliteTable('audit_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  traceId: text('trace_id').notNull(),
  taskId: text('task_id'),
  requestId: text('request_id'),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  result: text('result').notNull(),
  details: text('details'),
  timestamp: text('timestamp').notNull(),
});

export const approvalRecoveries = sqliteTable('approval_recoveries', {
  approvalId: text('approval_id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  requestId: text('request_id').notNull(),
  traceId: text('trace_id').notNull(),
  approvalJson: text('approval_json').notNull(),
  messagesJson: text('messages_json').notNull(),
  step: integer('step').notNull(),
  toolCallJson: text('tool_call_json').notNull(),
  executionJson: text('execution_json').notNull(),
  createdAt: text('created_at').notNull(),
});

export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  content: text('content').notNull(),
  category: text('category').notNull(), // 'preference' | 'fact' | 'skill' | 'context'
  sensitivity: text('sensitivity').notNull().default('public'), // 'public' | 'restricted' | 'secret'
  accessCount: integer('access_count').notNull().default(0),
  lastAccessedAt: text('last_accessed_at').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  metadata: text('metadata'), // JSON string for extra data
});

export const memoryEmbeddings = sqliteTable('memory_embeddings', {
  memoryId: text('memory_id')
    .primaryKey()
    .references(() => memories.id),
  embeddingModel: text('embedding_model').notNull(),
  embeddingDim: integer('embedding_dim').notNull(),
  embeddingJson: text('embedding_json').notNull(),
  contentHash: text('content_hash').notNull(),
  updatedAt: text('updated_at').notNull(),
});
