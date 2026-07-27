# 💡 Aivin SDK — Examples

Real plugins across common use cases. Each one is the complete `manifest.json` + `src/main.ts` pair.

These use the one recommended style — import just the namespace(s) you need. (`ctx.sdk.*` is
the legacy alternative: still works, not recommended for new code.) See
[SDK.md](./SDK.md#calling-the-sdk).

## 1. Text Summarizer

```json
{
  "version": "1.0.0",
  "plugins": [
    {
      "id": "auto-generated-hex-id",
      "name": "text-summarizer",
      "description": "AI text summarization plugin",
      "func": "main",
      "input": {
        "text": "string - text to summarize"
      },
      "output": {
        "data": "string - the summary"
      }
    }
  ]
}
```

```typescript
import { ai } from '@aivin-labs/sdk';
import { PluginStatus } from '@aivin-labs/sdk';
import type { PluginInput, PluginContext, PluginResponse } from '@aivin-labs/sdk';

export async function main(
  mission: string,
  input: PluginInput,
  ctx: PluginContext,
): Promise<PluginResponse> {
  const summary = await ai.prompt(`Summarize the following text in 3 sentences:\n\n${input.text}`, {
    temperature: 0.3,
    max_tokens: 150,
  });

  return { status: PluginStatus.SUCCESS, data: summary };
}
```

## 2. Todo Manager (persistent storage)

```json
{
  "version": "1.0.0",
  "plugins": [
    {
      "id": "auto-generated-hex-id",
      "name": "todo-manager",
      "description": "Add and list personal tasks",
      "func": "main",
      "input": {
        "action": "enum - what to do. enum: add, list. default: list",
        "task": "string - task content (only for action=add)"
      },
      "output": {
        "data": "object|array - created todo, or the list"
      }
    }
  ]
}
```

```typescript
import { store } from '@aivin-labs/sdk';
import { PluginStatus, PluginErrorCode } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  if (input.action === 'add') {
    const todo = await store.set('todos', crypto.randomUUID(), {
      user_id: ctx.user?.id,
      task: input.task,
      completed: false,
      created_at: Date.now(),
    });
    return { status: PluginStatus.SUCCESS, data: todo, message: `Added: ${input.task}` };
  }

  if (input.action === 'list') {
    const todos = await store.query('todos', { user_id: ctx.user?.id }, { created_at: -1 });
    return { status: PluginStatus.SUCCESS, data: todos };
  }

  return {
    status: PluginStatus.FAIL,
    message: `Unknown action: ${input.action}`,
    error_code: PluginErrorCode.INVALID_INPUT,
  };
}
```

## 3. Realtime Notification

```json
{
  "version": "1.0.0",
  "plugins": [
    {
      "id": "auto-generated-hex-id",
      "name": "weather-notifier",
      "description": "Cache a weather reading and notify the workspace",
      "func": "main",
      "input": {
        "city": "string",
        "temperature": "number",
        "condition": "string"
      },
      "output": {
        "message": "string"
      }
    }
  ]
}
```

```typescript
import { redis, realtime } from '@aivin-labs/sdk';
import { PluginStatus } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const { city, temperature, condition } = input;

  // Cache for 1 hour so repeated triggers don't re-notify immediately.
  const cacheKey = `weather:${city}`;
  const cached = await redis.get(cacheKey);
  if (cached === `${temperature}:${condition}`) {
    return { status: PluginStatus.SUCCESS, message: 'No change since last reading' };
  }
  await redis.setex(cacheKey, 3600, `${temperature}:${condition}`);

  await realtime.publish({
    event: 'weather.update',
    data: { city, temperature, condition },
    target: 'workspace',
  });

  return {
    status: PluginStatus.SUCCESS,
    message: `Updated ${city}: ${temperature}°C, ${condition}`,
  };
}
```

## 4. Background Email (self-scheduling)

```json
{
  "version": "1.0.0",
  "plugins": [
    {
      "id": "auto-generated-hex-id",
      "name": "email-sender",
      "description": "Send an email, retrying via the queue if it fails",
      "func": "main",
      "input": {
        "to": "string",
        "subject": "string",
        "body": "string",
        "attempt": "number - optional, internal"
      },
      "output": {
        "message": "string"
      }
    }
  ]
}
```

```typescript
import { notification, queue } from '@aivin-labs/sdk';
import { PluginStatus, PluginErrorCode } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const { to, subject, body, attempt = 0 } = input;
  try {
    await notification.sendMail({ to, subject, body });
    return { status: PluginStatus.SUCCESS, message: `Email sent to ${to}` };
  } catch (error) {
    if (attempt < 3) {
      // Reschedule a retry of this same plugin — the host re-invokes main() after delay_ms.
      await queue.scheduleJob({
        input: { to, subject, body, attempt: attempt + 1 },
        delay_ms: 60_000 * (attempt + 1),
      });
      return {
        status: PluginStatus.WAITING,
        message: `Send failed, retry ${attempt + 1}/3 scheduled`,
      };
    }
    return {
      status: PluginStatus.ERROR,
      message: `Send failed after 3 attempts: ${error.message}`,
      error_code: PluginErrorCode.SERVICE_UNAVAILABLE,
    };
  }
}
```

## 5. Smart Search (RAG)

```json
{
  "version": "1.0.0",
  "plugins": [
    {
      "id": "auto-generated-hex-id",
      "name": "smart-search",
      "description": "Semantic search over the workspace knowledge base",
      "func": "main",
      "input": {
        "query": "string"
      },
      "output": {
        "data": "array - matching results"
      }
    }
  ]
}
```

```typescript
import { knowledge } from '@aivin-labs/sdk';
import { PluginStatus } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const results = await knowledge.search(input.query, { limit: 5, threshold: 0.7 });
  return { status: PluginStatus.SUCCESS, data: results };
}
```

## 6. Multi-step Workflow (delegation + HIL)

```json
{
  "version": "1.0.0",
  "plugins": [
    {
      "id": "auto-generated-hex-id",
      "name": "expense-approval",
      "description": "Route an expense for approval, escalating to a human above a threshold",
      "func": "main",
      "input": {
        "amount": "number",
        "description": "string"
      },
      "output": {
        "data": "string - approval status"
      }
    }
  ]
}
```

```typescript
import { task, hil } from '@aivin-labs/sdk';
import { PluginStatus } from '@aivin-labs/sdk';

const AUTO_APPROVE_LIMIT = 500;

export async function main(mission, input, ctx) {
  const { amount, description } = input;

  if (amount <= AUTO_APPROVE_LIMIT) {
    await task.create({
      title: `Auto-approved: ${description}`,
      workspace_id: ctx.workspace.id,
      content: `Amount: $${amount}`,
    });
    return { status: PluginStatus.SUCCESS, data: 'auto_approved' };
  }

  const decision = await hil('expense-approval', `Approve expense: ${description} ($${amount})?`, {
    selections: [
      { label: 'Approve', value: 'approve' },
      { label: 'Reject', value: 'reject' },
    ],
  });

  if (decision.value === 'approve') {
    await task.create({
      title: `Approved: ${description}`,
      workspace_id: ctx.workspace.id,
      content: `Amount: $${amount}, approved by human review`,
    });
    return { status: PluginStatus.SUCCESS, data: 'approved' };
  }

  return { status: PluginStatus.SUCCESS, data: 'rejected' };
}
```

## 7. MongoDB-style storage

```json
{
  "version": "1.0.0",
  "plugins": [
    {
      "id": "auto-generated-hex-id",
      "name": "user-directory",
      "description": "Look up and upsert users in an isolated Mongo-backed collection",
      "func": "main",
      "input": {
        "email": "string"
      },
      "output": {
        "data": "object - the user record"
      }
    }
  ]
}
```

```typescript
import { mongo } from '@aivin-labs/sdk';
import { PluginStatus } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const Users = mongo.model('users');
  let user = await Users.findOne({ email: input.email });
  if (!user) {
    user = await Users.create({ email: input.email, created_at: new Date() });
  }
  return { status: PluginStatus.SUCCESS, data: user };
}
```

## Trying these locally

```bash
aivin start
curl -X POST http://localhost:4001/invoke -H 'content-type: application/json' \
  -d '{"input": {"text": "Long text to summarize..."}}'
```

See [SDK.md](./SDK.md) for the full reference and [MANIFEST.md](./MANIFEST.md) for every manifest
field.
