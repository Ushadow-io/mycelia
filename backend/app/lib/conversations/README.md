# Conversation Architecture

Proper layered architecture for conversation data access, following ushadow's router→service→store pattern.

## Architecture Layers

```
Router (30 lines max) → Service (business logic) → Store (database)
```

### 1. Store (`store.server.ts`)
**Purpose**: Encapsulate all MongoDB queries
**Rules**:
- No business logic
- Just database operations
- Returns raw documents

```typescript
// ❌ BAD: Direct MongoDB in router
const conversations = await db.collection('objects').find({
  isConversation: true,
  "metadata.extractedWith.chunkId": { $in: chunkIds }
}).toArray();

// ✅ GOOD: Use the store
const conversations = await ConversationStore.findRecent(auth, { chunkIds });
```

### 2. Service (`conversation.server.ts`)
**Purpose**: Business logic and data transformation
**Rules**:
- Orchestrates store calls
- Transforms data formats (mycelia ↔ Chronicle)
- Applies business rules (validation, limits)
- Returns clean DTOs

```typescript
// Get conversations in Chronicle format
const conversations = await ConversationService.getRecentConversations(auth, {
  limit: 25,
  skip: 0
});
```

### 3. Router (`data.conversations.ts`)
**Purpose**: Thin HTTP adapter
**Rules**:
- Max 30 lines per endpoint
- Parse request params
- Call service
- Return JSON response

```typescript
export async function dataConversationsHandler(req: Request, res: Response) {
  const auth = await authenticateOr401(req, res);
  const limit = parseInt(req.query.limit as string) || 25;

  const conversations = await ConversationService.getRecentConversations(
    auth,
    { limit }
  );

  res.json({ conversations });
}
```

## API Endpoints

### GET /data/conversations
Returns conversations in Chronicle format.

**Query params**:
- `limit` (number): Max results (default 25, max 100)
- `skip` (number): Pagination offset (default 0)
- `start` (ISO date): Filter by start date
- `end` (ISO date): Filter by end date

**Response**:
```json
{
  "conversations": [
    {
      "conversation_id": "507f1f77bcf86cd799439011",
      "user_id": "user123",
      "created_at": "2026-01-27T17:48:39.221Z",
      "title": "Testing OMI Device",
      "summary": "Testing the OMI device...",
      "detailed_summary": "Full conversation details...",
      "segment_count": 2,
      "has_memory": true,
      "memory_count": 4
    }
  ],
  "count": 1,
  "limit": 25,
  "skip": 0
}
```

### GET /data/conversations/:id
Get a single conversation by ID.

### GET /data/conversations/stats
Get conversation statistics.

## Chronicle Format Compatibility

The service transforms mycelia's conversation model to match Chronicle's format:

| Chronicle Field | Mycelia Source | Notes |
|-----------------|----------------|-------|
| `conversation_id` | `_id` | MongoDB ObjectId as string |
| `title` | `name` | Conversation title |
| `summary` | Generated from `details` | First sentence |
| `detailed_summary` | `details` | Full markdown content |
| `created_at` | `createdAt` | ISO 8601 timestamp |
| `segment_count` | `metadata.transcription.segmentCount` | Number of transcript segments |
| `has_memory` | `metadata.transcription.hasMemory` | Boolean flag |
| `memory_count` | `metadata.transcription.memoryCount` | Memory item count |

## Benefits of This Architecture

1. **Testable**: Each layer can be unit tested independently
2. **Reusable**: Services can be called from multiple routes
3. **Maintainable**: Clear separation of concerns
4. **Consistent**: Follows ushadow's backend patterns
5. **Type-safe**: Full TypeScript typing throughout

## Migration Guide

### Before (Direct MongoDB):
```typescript
const conversations = await db.collection("objects").find({
  isConversation: true,
  "metadata.extractedWith.chunkId": { $in: chunkIds }
}).sort({ createdAt: -1 }).toArray();
```

### After (Layered):
```typescript
const conversations = await ConversationService.getConversationsForChunks(
  auth,
  chunkIds
);
```

## Adding New Queries

1. **Add to Store** (if new database access needed):
```typescript
static async findByUser(auth: Auth, userId: string) {
  const db = await getRootDB();
  return await db.collection("objects").find({
    isConversation: true,
    userId
  }).toArray();
}
```

2. **Add to Service** (if business logic needed):
```typescript
static async getUserConversations(auth: Auth, userId: string) {
  const conversations = await ConversationStore.findByUser(auth, userId);
  return conversations.map(c => this.transformToChronicleFormat(c, auth));
}
```

3. **Add to Router** (new HTTP endpoint):
```typescript
export async function userConversationsHandler(req: Request, res: Response) {
  const auth = await authenticateOr401(req, res);
  const userId = req.params.userId;

  const conversations = await ConversationService.getUserConversations(
    auth,
    userId
  );

  res.json({ conversations });
}
```
