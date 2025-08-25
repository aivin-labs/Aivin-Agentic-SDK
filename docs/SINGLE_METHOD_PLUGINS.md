# Single Method Plugin Pattern

## Tổng quan

Plugin bây giờ sử dụng **Single Method Pattern** - mỗi plugin chỉ expose một entry point duy nhất:
- Plugin register với một channel: `plugin.{pluginName}`
- Tất cả requests đều đi qua entry point này
- Đơn giản hóa nghiệp vụ và giảm complexity

## Cấu trúc Plugin

### 1. Manifest (Simplified)

```json
{
  "id": "auto-generated-hex-id",
  "name": "my-plugin",
  "description": "Simple plugin with single method",
  "author": "Developer Name",
  "input": "Bạn nhận về yêu cầu từ user",
  "output": {
    "success": "boolean - Trạng thái xử lý",
    "data": "any - Dữ liệu kết quả", 
    "message": "string - Thông điệp. default: 'Success'"
  },
  "version": "1.0.0",
  "trigger_type": ["manual", "api", "chat"],
  "initial": {
    "config": "default values"
  }
}
```

### 2. Handler Structure

```typescript
// handler.ts - Single entry point
export async function main({ ctx, data, options = {} }) {
  // Tất cả logic của plugin ở đây
  
  // Call server handlers khi cần
  const result = await PubSubIO.request('server.processData', {
    input: data,
    config: options
  });
  
  return {
    success: true,
    data: result,
    message: 'Processed successfully'
  };
}

// Hoặc default export
export default async function({ ctx, input }) {
  // Logic here
  return { success: true, data: input };
}
```

## Communication Pattern

### Server → Plugin

```typescript
// Server gọi plugin qua single channel
const result = await PubSubIO.request('plugin.my-plugin', {
  ctx: userContext,
  data: inputData,
  options: { timeout: 30000 }
});
```

### Plugin → Server

```typescript
// Plugin gọi server handlers
export async function main({ ctx, taskData }) {
  // Create task via server
  const task = await PubSubIO.request('task.create', {
    workspaceId: ctx.workspace.id,
    title: taskData.title,
    assigneeId: taskData.assigneeId
  });
  
  // Send notification via server
  await PubSubIO.request('notification.send', {
    userId: taskData.assigneeId,
    message: `New task: ${task.title}`,
    type: 'task'
  });
  
  return {
    success: true,
    data: task,
    message: 'Task created and notification sent'
  };
}
```

## Plugin Registration

### Server Side
Plugin server tự động register single channel:

```typescript
// PluginServer tự động làm việc này:
await PubSubIO.emit('plugin-server-register', {
  server_id: 'node:my-plugin',
  plugin_channel: 'plugin.my-plugin', // Single channel
  plugin_info: {
    id: manifestId,
    name: 'my-plugin',
    version: '1.0.0',
    method: 'single'
  }
});

// Listen on single channel
await PubSubIO.listen('plugin.my-plugin', async (jobData) => {
  // Route to main entry point
  return await executeMainFunction(jobData);
});
```

### Entry Point Resolution

Plugin server tự động resolve entry point:

1. **Specified entry_point**: Dùng `manifest.entry_point` (mặc định: "main")
2. **Default export**: Nếu handler.ts export default function
3. **First function**: Fallback đến function đầu tiên tìm thấy

```typescript
// Priority order:
const entryPoint = manifest.entry_point || 'main';

// 1. Try specified entry point
if (handler[entryPoint] && typeof handler[entryPoint] === 'function') {
  targetFunction = handler[entryPoint];
}
// 2. Try default export
else if (typeof handler === 'function') {
  targetFunction = handler;
}
// 3. Try first available function
else {
  const functions = Object.keys(handler).filter(k => typeof handler[k] === 'function');
  if (functions.length > 0) {
    targetFunction = handler[functions[0]];
  }
}
```

## Examples

### 1. Text Processing Plugin

**manifest.json:**
```json
{
  "name": "text-processor",
  "description": "Process text with various transformations",
  "input": {
    "text": "string - Text cần xử lý",
    "operation": "string - Loại xử lý (uppercase, lowercase, reverse). default: uppercase"
  },
  "output": {
    "success": "boolean - Trạng thái xử lý",
    "data": "string - Text đã xử lý",
    "operation": "string - Loại xử lý đã thực hiện",
    "original_length": "number - Độ dài text gốc",
    "processed_length": "number - Độ dài text sau xử lý"
  }
}
```

**handler.ts:**
```typescript
export async function main({ ctx, text, operation = 'uppercase' }) {
  let result;
  
  switch (operation) {
    case 'uppercase':
      result = text.toUpperCase();
      break;
    case 'lowercase':
      result = text.toLowerCase();
      break;
    case 'reverse':
      result = text.split('').reverse().join('');
      break;
    default:
      result = text;
  }
  
  // Log activity
  await PubSubIO.request('activity.log', {
    userId: ctx.user.id,
    action: 'text_processed',
    data: { operation, length: text.length }
  });
  
  return {
    success: true,
    data: result,
    operation,
    original_length: text.length,
    processed_length: result.length
  };
}
```

### 2. AI Chat Plugin

**manifest.json:**
```json
{
  "name": "ai-chat-assistant",
  "description": "AI-powered chat assistant",
  "input": {
    "message": "string - Tin nhắn từ user",
    "model": "string - AI model sử dụng. default: gpt-4"
  },
  "output": {
    "success": "boolean - Trạng thái xử lý",
    "data": "string - Phản hồi từ AI",
    "model": "string - Model đã sử dụng",
    "usage": "object - Thống kê sử dụng token"
  }
}
```

**handler.ts:**
```typescript
export async function main({ ctx, message, model = 'gpt-4' }) {
  try {
    // Get user conversation history
    const history = await PubSubIO.request('conversation.getHistory', {
      userId: ctx.user.id,
      limit: 10
    });
    
    // Build messages array
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      ...history,
      { role: 'user', content: message }
    ];
    
    // Call AI service
    const response = await PubSubIO.request('ai.chat', {
      messages,
      model,
      max_tokens: 1000
    });
    
    // Save conversation
    await PubSubIO.request('conversation.save', {
      userId: ctx.user.id,
      messages: [
        { role: 'user', content: message },
        { role: 'assistant', content: response.content }
      ]
    });
    
    return {
      success: true,
      data: response.content,
      model: response.model,
      usage: response.usage
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message,
      fallback: "I'm sorry, I'm having trouble processing your request right now."
    };
  }
}
```

### 3. Workflow Plugin

**manifest.json:**
```json
{
  "name": "task-workflow", 
  "description": "Automated task workflow management",
  "input": {
    "workflow": "object - Workflow definition với steps",
    "data": "any - Dữ liệu đầu vào cho workflow"
  },
  "output": {
    "success": "boolean - Workflow thành công hay không",
    "data": "object - Kết quả workflow với logs chi tiết"
  }
}
```

**handler.ts:**
```typescript
// Default export pattern
export default async function({ ctx, workflow, data }) {
  const results = [];
  
  for (const step of workflow.steps) {
    try {
      // Execute each step via server
      const stepResult = await PubSubIO.request(`workflow.${step.type}`, {
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        config: step.config,
        input: data
      });
      
      results.push({
        step: step.name,
        success: true,
        result: stepResult,
        timestamp: Date.now()
      });
      
      // Update data for next step
      data = stepResult.output || data;
      
    } catch (error) {
      results.push({
        step: step.name,
        success: false,
        error: error.message,
        timestamp: Date.now()
      });
      
      // Stop on error unless continue_on_error is true
      if (!step.continue_on_error) {
        break;
      }
    }
  }
  
  // Log workflow completion
  await PubSubIO.request('workflow.logCompletion', {
    workflowId: workflow.id,
    userId: ctx.user.id,
    results,
    duration: Date.now() - workflow.startTime
  });
  
  return {
    success: results.every(r => r.success),
    data: {
      workflow_id: workflow.id,
      steps_completed: results.length,
      steps_successful: results.filter(r => r.success).length,
      final_data: data,
      execution_log: results
    }
  };
}
```

## Development Workflow

### 1. Create Plugin
```bash
leanez create my-single-plugin
cd my-single-plugin
```

### 2. Edit handler.ts
```typescript
export async function main({ ctx, input }) {
  // Your business logic
  return { success: true, data: processedInput };
}
```

### 3. Test Locally
```bash
leanez start

# Test single method
curl -X POST http://localhost:8080/execute \
  -H "Content-Type: application/json" \
  -d '{"input": {"data": "test"}}'
```

### 4. Deploy
```bash
leanez deploy
```

## Best Practices

### 1. Keep Entry Point Simple
```typescript
// ✅ Good - single responsibility
export async function main({ ctx, text }) {
  const result = await processText(text);
  await logActivity(ctx.user.id, 'text_processed');
  return { success: true, data: result };
}

// ❌ Avoid - complex branching
export async function main({ ctx, action, data }) {
  if (action === 'process') {
    // Complex logic
  } else if (action === 'analyze') {
    // More complex logic
  }
  // Too many responsibilities
}
```

### 2. Use Server Handlers
```typescript
// ✅ Delegate to server
const user = await PubSubIO.request('user.getById', { id: userId });
const file = await PubSubIO.request('file.upload', { data: fileData });

// ❌ Don't reimplement server logic
const user = await queryDatabaseDirectly(userId);
```

### 3. Error Handling
```typescript
export async function main({ ctx, data }) {
  try {
    const result = await PubSubIO.request('server.process', data);
    return { success: true, data: result };
  } catch (error) {
    // Log error but don't throw
    await PubSubIO.request('log.error', {
      plugin: 'my-plugin',
      error: error.message,
      userId: ctx.user?.id
    }).catch(() => {}); // Don't fail if logging fails
    
    return {
      success: false,
      error: 'PROCESSING_FAILED',
      message: 'Unable to process request',
      fallback: defaultResult
    };
  }
}
```

## Migration từ Multi-Method

### Before (Multi-method):
```json
{
  "functions": [
    { "name": "processText", "trigger_type": ["api"] },
    { "name": "analyzeText", "trigger_type": ["api"] },
    { "name": "saveResult", "trigger_type": ["api"] }
  ]
}
```

```typescript
export async function processText(data) { ... }
export async function analyzeText(data) { ... }
export async function saveResult(data) { ... }
```

### After (Single method):
```json
{
  "entry_point": "main",
  "description": "Text processing and analysis"
}
```

```typescript
export async function main({ ctx, action, data }) {
  switch (action) {
    case 'process':
      return await processText(data);
    case 'analyze':
      return await analyzeText(data);
    case 'save':
      return await saveResult(data);
    default:
      return { error: 'Unknown action' };
  }
}

// Private helper functions
async function processText(data) { ... }
async function analyzeText(data) { ... }
async function saveResult(data) { ... }
```

Single method pattern đơn giản hơn nhiều cho cả development và deployment! 🚀 