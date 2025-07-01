# 📋 Manifest File Documentation

Manifest file (`manifest.json`) là file mô tả chính của plugin. Dựa vào file này các AI Agent trên LeanEZ có thể sử dụng và triển khai tự động hóa một cách tự động.
File này sẽ định nghĩa cách sử dụng, metadata, functions và input/output schema.

## 🏗️ Cấu trúc tổng quan

```json
{
  "name": "plugin-name",
  "version": "1.0.0",
  "description": "Plugin description",
  "author": "Author Name",
  "email": "author@example.com",
  "agent_specialized": ["*"],
  "agent_designated": [],
  "functions": [
    {
      "name": "functionName",
      "trigger_type": ["manual", "api", "chat"],
      "description": "Function description",
      "inputs": [...],
      "outputs": [...],
      "exceptions": [...],
      "next_trigger": "pluginName:functionName"
    }
  ]
}
```

## 📊 Plugin Metadata Properties

| Property | Type | Required | Description | Example |
|----------|------|----------|-------------|---------|
| `name` | `string` | ✅ | Tên plugin (unique identifier) | `"text-summarizer"` |
| `version` | `string` | ✅ | Phiên bản plugin (semantic versioning) | `"1.0.0"` |
| `description` | `string` | ✅ | Mô tả ngắn gọn về plugin | `"Summarize text using AI"` |
| `author` | `string` | ❌ | Tên tác giả hoặc tổ chức | `"LeanEZ Team"` |
| `email` | `string` | ❌ | Email để gửi/nhận thông báo về plugin | `"support@leanez.app"` |
| `agent_specialized` | `string[]` | ❌ | Danh sách agents được chuyên biệt hóa | `["*"]` hoặc `["sales", "support"]` |
| `agent_designated` | `string[]` | ❌ | Danh sách agents được chỉ định cụ thể | `["agent-1", "agent-2"]` |
| `functions` | `PluginFunction[]` | ✅ | Danh sách các functions của plugin | `[{...}]` |

## 🔧 PluginFunction Properties

| Property | Type | Required | Description | Example |
|----------|------|----------|-------------|---------|
| `name` | `string` | ✅ | Tên function (phải match với export trong handler) | `"main"`, `"processData"` |
| `trigger_type` | `string[]` | ✅ | Các trigger types được hỗ trợ | `["manual", "api", "chat"]` |
| `description` | `string` | ✅ | Mô tả chức năng của function | `"Process user input"` |
| `inputs` | `PluginInput[]` | ❌ | Danh sách input fields | `[{...}]` |
| `outputs` | `PluginOutput[]` | ❌ | Schema định nghĩa output structure | `[{...}]` |
| `exceptions` | `PluginException[]` | ❌ | Định nghĩa error handling và fallback | `[{...}]` |
| `next_trigger` | `string` | ❌ | Function tiếp theo được trigger | `"pluginName:functionName"` |

### 🤖 Function Roles trong AI System

#### **Main Function** - Entry Point mặc định
- **Tên**: Luôn là `"main"`
- **Vai trò**: Được AI gọi tự động khi sử dụng plugin
- **Trigger**: Chủ yếu `["chat", "api", "manual"]`
- **Mục đích**: Xử lý logic chính của plugin

#### **Tool Functions** - AI Tool Calls
- **Tên**: Tùy chỉnh (vd: `"searchData"`, `"createUser"`, `"sendEmail"`)
- **Vai trò**: AI gọi khi cần thực hiện tác vụ cụ thể
- **Trigger**: Thường có `["api", "chat"]`
- **Mục đích**: Cung cấp specialized capabilities cho AI

**Workflow AI sử dụng plugin:**
1. AI gọi `main()` để khởi động plugin
2. Nếu cần, AI gọi các tool functions cụ thể
3. Plugin có thể chain functions với `next_trigger`

## 🚀 Function Input Format

**Tất cả functions nhận input dưới dạng object với structure sau:**

```typescript
// Function signature trong handler.ts
export async function todoManager({
  ctx,        // MessageContextDTO - context từ LeanEZ
  title,      // Args từ manifest inputs
  priority,   // Args từ manifest inputs
  ...args     // Tất cả args khác từ manifest
}) {
  // Function implementation
}
```

**Trong đó:**
- `ctx: MessageContextDTO` - Context thông tin từ LeanEZ system
- `...args` - Các arguments được định nghĩa trong manifest `inputs`

**Ví dụ manifest inputs:**
```json
{
  "name": "todoManager",
  "trigger_type": ["chat", "api"],
  "inputs": [
    {
      "field": "title",
      "required": true,
      "description": "Task title",
      "type": "string"
    },
    {
      "field": "priority", 
      "required": false,
      "description": "Task priority",
      "type": "string",
      "default": "medium"
    }
  ]
}
```

**Function implementation:**
```typescript
export async function todoManager({ ctx, title, priority = "medium" }) {
  // ctx.session - Session information
  // ctx.user - Current user
  // ctx.workspace - Current workspace
  // title, priority - từ manifest inputs
  
  return {
    success: true,
    data: { title, priority },
    message: "Task created successfully"
  };
}
```

## 📥 PluginInput Properties

| Property | Type | Required | Description | Example |
|----------|------|----------|-------------|---------|
| `field` | `string` | ✅ | Tên field trong input object | `"text"`, `"userId"` |
| `required` | `boolean` | ✅ | Field có bắt buộc hay không | `true`, `false` |
| `description` | `string` | ✅ | Mô tả ý nghĩa và cách sử dụng field | `"Text to be processed"` |
| `type` | `string` | ❌ | Kiểu dữ liệu của field | `"string"`, `"number"`, `"boolean"` |
| `default` | `any` | ❌ | Giá trị mặc định nếu không được cung cấp | `""`, `0`, `{}` |

## 📤 PluginOutput Properties

| Property | Type | Required | Description | Example |
|----------|------|----------|-------------|---------|
| `field` | `string` | ✅ | Tên field trong output object | `"result"`, `"message"`, `"success"` |
| `description` | `string` | ✅ | Mô tả ý nghĩa của output field | `"Processing result data"` |
| `type` | `string` | ❌ | Kiểu dữ liệu của field | `"string"`, `"number"`, `"boolean"`, `"object"`, `"array"` |
| `example` | `any` | ❌ | Ví dụ giá trị output | `"Hello World"`, `123`, `true` |

## ⚠️ PluginException Properties

| Property | Type | Required | Description | Example |
|----------|------|----------|-------------|---------|
| `code` | `string` | ✅ | Mã lỗi để identify exception | `"INVALID_INPUT"`, `"API_TIMEOUT"`, `"AUTH_FAILED"` |
| `message` | `string` | ✅ | Human-readable error message | `"Invalid input format provided"` |
| `description` | `string` | ✅ | Chi tiết về khi nào error xảy ra | `"Triggered when input validation fails"` |
| `fallback` | `string` | ❌ | Function được trigger khi error xảy ra | `"pluginName:handleError"`, `"error-handler:processException"` |
| `retry` | `boolean` | ❌ | Có thể retry operation hay không | `true`, `false` |

**Lưu ý về Fallback Function:**
- Fallback function sẽ nhận input với format: `{code, message, data}`
- `code`: Mã error code từ exception
- `message`: Error message từ exception  
- `data`: Dữ liệu gốc từ function call bị lỗi

## 🎯 Trigger Types

| Trigger | Description | Use Case |
|---------|-------------|----------|
| `manual` | Được gọi thủ công bởi user | Button clicks, form submissions |
| `schedule` | Được gọi theo lịch trình | Cron jobs, periodic tasks |
| `event` | Được gọi khi có event xảy ra | Data changes, webhooks |
| `webhook` | Được gọi từ external HTTP requests | API integrations |
| `api` | Được gọi từ API endpoints | Direct function calls |
| `chat` | Được gọi từ chat interface | Chatbot interactions |

## 🔤 Data Types

| Type | JavaScript Type | Description | Example |
|------|-----------------|-------------|---------|
| `string` | `string` | Text data | `"Hello World"` |
| `number` | `number` | Numeric data | `123`, `45.67` |
| `boolean` | `boolean` | True/false values | `true`, `false` |
| `object` | `object` | Complex objects | `{"key": "value"}` |
| `array` | `Array` | Lists of items | `[1, 2, 3]`, `["a", "b"]` |

## 📝 Examples

### Basic Plugin với Main Function
```json
{
  "name": "hello-world",
  "version": "1.0.0",
  "description": "Simple greeting plugin",
  "author": "Developer",
  "email": "dev@example.com",
  "agent_specialized": ["*"],
  "agent_designated": [],
  "functions": [
    {
      "name": "main",
      "trigger_type": ["manual", "api", "chat"],
      "description": "Say hello to user - Entry point cho AI",
      "inputs": [
        {
          "field": "name",
          "required": true,
          "description": "User's name",
          "type": "string"
        }
      ],
      "outputs": [
        {
          "field": "message",
          "description": "Generated greeting message",
          "type": "string",
          "example": "Hello, John!"
        },
        {
          "field": "success",
          "description": "Operation success status",
          "type": "boolean",
          "example": true
        }
      ],
      "exceptions": [
        {
          "code": "EMPTY_NAME",
          "message": "Name cannot be empty or undefined",
          "description": "Triggered when name input is missing or empty string",
          "fallback": "hello-world:handleEmptyName",
          "retry": false
        },
        {
          "code": "INVALID_NAME_FORMAT",
          "message": "Name contains invalid characters",
          "description": "Triggered when name contains special characters or numbers",
          "fallback": "hello-world:handleInvalidFormat",
          "retry": true
        }
      ]
    },
    {
      "name": "handleEmptyName",
      "trigger_type": ["event"],
      "description": "Handle empty name error case",
      "inputs": [
        {
          "field": "code",
          "required": true,
          "description": "Error code",
          "type": "string"
        },
        {
          "field": "message",
          "required": true,
          "description": "Error message",
          "type": "string"
        },
        {
          "field": "data",
          "required": true,
          "description": "Original function input data",
          "type": "object"
        }
      ],
      "outputs": [
        {
          "field": "success",
          "description": "Error handling success status",
          "type": "boolean",
          "example": false
        },
        {
          "field": "message",
          "description": "Fallback greeting message",
          "type": "string",
          "example": "Hello, Anonymous!"
        },
        {
          "field": "error",
          "description": "Error code for client handling",
          "type": "string",
          "example": "EMPTY_NAME"
        }
      ]
    },
    {
      "name": "handleInvalidFormat",
      "trigger_type": ["event"],
      "description": "Handle invalid name format error case",
      "inputs": [
        {
          "field": "code",
          "required": true,
          "description": "Error code",
          "type": "string"
        },
        {
          "field": "message",
          "required": true,
          "description": "Error message",
          "type": "string"
        },
        {
          "field": "data",
          "required": true,
          "description": "Original function input data",
          "type": "object"
        }
      ],
      "outputs": [
        {
          "field": "success",
          "description": "Error handling success status",
          "type": "boolean",
          "example": false
        },
        {
          "field": "message",
          "description": "Error guidance message",
          "type": "string",
          "example": "Please provide a valid name without special characters"
        },
        {
          "field": "error",
          "description": "Error code for client handling",
          "type": "string",
          "example": "INVALID_NAME_FORMAT"
        }
      ]
    }
  ]
}
```

### Advanced Plugin với Main + Tool Functions
```json
{
  "name": "task-manager",
  "version": "2.1.0",
  "description": "Advanced task management plugin",
  "author": "LeanEZ Team",
  "agent_specialized": ["productivity", "workflow"],
  "functions": [
    {
      "name": "main",
      "trigger_type": ["chat", "api", "manual"],
      "description": "Main entry point - AI sử dụng để khởi động plugin",
      "inputs": [
        {
          "field": "action",
          "required": true,
          "description": "Action to perform: 'list', 'create', 'update', 'delete'",
          "type": "string"
        },
        {
          "field": "data",
          "required": false,
          "description": "Action data payload",
          "type": "object",
          "default": {}
        }
      ],
      "outputs": [
        {
          "field": "success",
          "description": "Operation success status",
          "type": "boolean",
          "example": true
        },
        {
          "field": "result",
          "description": "Action result data",
          "type": "object",
          "example": {"taskId": "123", "title": "New Task"}
        },
        {
          "field": "message",
          "description": "Human-readable response message",
          "type": "string",
          "example": "Task created successfully"
        }
      ],
      "exceptions": [
        {
          "code": "UNKNOWN_ACTION",
          "message": "Action not supported by this plugin",
          "description": "Triggered when action is not in supported list",
          "fallback": "task-manager:handleUnknownAction",
          "retry": true
        },
        {
          "code": "DATABASE_ERROR",
          "message": "Failed to connect to database",
          "description": "Triggered when MongoDB connection fails",
          "fallback": "task-manager:handleDatabaseError",
          "retry": true
        }
      ]
    },
    {
      "name": "createTask",
      "trigger_type": ["api", "chat"],
      "description": "Tool function - AI gọi để tạo task cụ thể",
      "inputs": [
        {
          "field": "title",
          "required": true,
          "description": "Task title",
          "type": "string"
        },
        {
          "field": "description",
          "required": false,
          "description": "Task description",
          "type": "string",
          "default": ""
        },
        {
          "field": "priority",
          "required": false,
          "description": "Task priority level",
          "type": "number",
          "default": 1
        },
        {
          "field": "assignees",
          "required": false,
          "description": "List of user IDs to assign",
          "type": "array",
          "default": []
        }
      ],
      "outputs": [
        {
          "field": "success",
          "description": "Task creation success status",
          "type": "boolean",
          "example": true
        },
        {
          "field": "taskId",
          "description": "ID of the created task",
          "type": "string",
          "example": "task_123456"
        },
        {
          "field": "task",
          "description": "Complete task object",
          "type": "object",
          "example": {"_id": "task_123456", "title": "New Task", "status": "pending"}
        },
        {
          "field": "message",
          "description": "Creation status message",
          "type": "string",
          "example": "Task 'New Task' created successfully"
        }
      ],
      "exceptions": [
        {
          "code": "TITLE_TOO_LONG",
          "message": "Task title exceeds maximum length",
          "description": "Triggered when title is longer than 200 characters",
          "fallback": "task-manager:handleTitleTooLong",
          "retry": true
        },
        {
          "code": "INVALID_ASSIGNEE",
          "message": "One or more assignees not found",
          "description": "Triggered when assignee ID doesn't exist in workspace",
          "fallback": "task-manager:handleInvalidAssignee",
          "retry": true
        },
        {
          "code": "QUOTA_EXCEEDED",
          "message": "Maximum number of tasks reached",
          "description": "Triggered when workspace task limit is exceeded",
          "fallback": "task-manager:handleQuotaExceeded",
          "retry": false
        }
      ],
      "next_trigger": "task-manager:sendNotification"
    },
    {
      "name": "searchTasks",
      "trigger_type": ["api", "chat"],
      "description": "Tool function - AI gọi để tìm kiếm tasks",
      "inputs": [
        {
          "field": "query",
          "required": true,
          "description": "Search query string",
          "type": "string"
        },
        {
          "field": "filters",
          "required": false,
          "description": "Search filters (status, priority, assignee)",
          "type": "object",
          "default": {}
        }
      ],
      "outputs": [
        {
          "field": "tasks",
          "description": "Array of matching tasks",
          "type": "array",
          "example": [{"_id": "123", "title": "Task 1"}, {"_id": "456", "title": "Task 2"}]
        },
        {
          "field": "total",
          "description": "Total number of matching tasks",
          "type": "number",
          "example": 15
        },
        {
          "field": "success",
          "description": "Search operation success status",
          "type": "boolean",
          "example": true
        }
      ],
      "exceptions": [
        {
          "code": "QUERY_TOO_SHORT",
          "message": "Search query must be at least 2 characters",
          "description": "Triggered when query length is less than 2 characters",
          "fallback": "task-manager:handleShortQuery",
          "retry": true
        },
        {
          "code": "SEARCH_TIMEOUT",
          "message": "Search operation timed out",
          "description": "Triggered when search takes longer than 30 seconds",
          "fallback": "task-manager:handleSearchTimeout",
          "retry": true
        }
      ]
    },
    {
      "name": "sendNotification",
      "trigger_type": ["event"],
      "description": "Internal function - Được trigger sau khi tạo task",
      "inputs": [
        {
          "field": "taskId",
          "required": true,
          "description": "ID of the created task",
          "type": "string"
        }
      ],
      "outputs": [
        {
          "field": "notificationSent",
          "description": "Whether notification was sent successfully",
          "type": "boolean",
          "example": true
        },
        {
          "field": "recipients",
          "description": "Number of users who received notification",
          "type": "number",
          "example": 3
        }
      ],
      "exceptions": [
        {
          "code": "TASK_NOT_FOUND",
          "message": "Task ID does not exist",
          "description": "Triggered when taskId is not found in database",
          "fallback": "task-manager:handleTaskNotFound",
          "retry": false
        },
        {
          "code": "NOTIFICATION_SERVICE_DOWN",
          "message": "Unable to send notifications",
          "description": "Triggered when PubSub service is unavailable",
          "fallback": "task-manager:handleNotificationFailure",
          "retry": true
        }
      ]
    }
  ]
}
```

## ✅ Best Practices

### Naming Conventions
- **Plugin names**: lowercase, hyphen-separated (`task-manager`, `email-sender`)
- **Function names**: camelCase (`createTask`, `sendEmail`, `processData`)
- **Field names**: camelCase (`userId`, `taskTitle`, `maxResults`)

### Versioning
- Sử dụng [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`
- `1.0.0` → Initial release
- `1.0.1` → Bug fixes
- `1.1.0` → New features (backward compatible)
- `2.0.0` → Breaking changes

### Input Design
- **Tên fields rõ ràng**: `userName` thay vì `n`
- **Descriptions chi tiết**: Giải thích rõ ràng mục đích và format
- **Default values hợp lý**: Cung cấp defaults cho optional fields
- **Type consistency**: Luôn specify type cho clarity

### Output Design
- **Meaningful data**: Include các thông tin cần thiết cho client
- **Clear field names**: Sử dụng tên fields rõ ràng và consistent
- **Appropriate types**: Specify đúng data types cho từng field

### Function Design cho AI Integration

#### **Main Function Best Practices**
- **Đơn giản và linh hoạt**: Nhận action parameter để route đến logic phù hợp
- **Comprehensive outputs**: Trả về đầy đủ thông tin để AI hiểu kết quả
- **Error handling**: Luôn có fallback và error messages rõ ràng
- **Documentation**: Description phải giải thích rõ AI nên sử dụng khi nào

```javascript
// ✅ Good main function
export async function main(input) {
  const { action, data = {} } = input;
  
  switch (action) {
    case 'create':
      return await createTask(data);
    case 'search':
      return await searchTasks(data);
    default:
      return {
        success: false,
        message: `Unknown action: ${action}. Available: create, search, list, update, delete`,
        availableActions: ['create', 'search', 'list', 'update', 'delete']
      };
  }
}
```

#### **Tool Function Best Practices**
- **Single responsibility**: Mỗi function làm 1 việc cụ thể
- **Descriptive names**: Tên function phải rõ ràng về chức năng
- **Minimal inputs**: Chỉ yêu cầu parameters thực sự cần thiết
- **Structured outputs**: Format consistent để AI dễ parse

```javascript
// ✅ Good tool function
export async function createTask(input) {
  const { title, description = '', priority = 1, assignees = [] } = input;
  
  try {
    const task = await TaskModel.create({
      title,
      description,
      priority,
      assignees,
      createdAt: new Date()
    });
    
    return {
      success: true,
      taskId: task._id,
      task: task.toObject(),
      message: `Task "${title}" created successfully`
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      message: 'Failed to create task'
    };
  }
}
```

#### **Exception Handling Best Practices**
- **Specific error codes**: Sử dụng codes rõ ràng và consistent
- **Helpful fallback functions**: Tạo dedicated functions để xử lý từng loại error
- **Function naming**: Fallback functions nên có prefix `handle` (vd: `handleInvalidInput`)
- **Retry logic**: Chỉ cho phép retry với errors có thể recover

```javascript
// ✅ Good exception handling với fallback function
export async function processData(input) {
  try {
    // Validate input
    if (!input.data || typeof input.data !== 'string') {
      throw new Error('INVALID_INPUT');
    }
    
    if (input.data.length > 10000) {
      throw new Error('DATA_TOO_LARGE');
    }
    
    // Process data
    const result = await processLargeData(input.data);
    
    return {
      success: true,
      result: result,
      message: 'Data processed successfully'
    };
    
  } catch (error) {
    // Let the system trigger fallback function
    throw error;
  }
}

// Fallback function để xử lý INVALID_INPUT error
export async function handleInvalidInput(input) {
  const { code, message, data } = input;
  
  // Log error cho monitoring
  console.error(`Error ${code}: ${message}`, data);
  
  // Return fallback response
  return {
    success: false,
    result: null,
    message: 'Please provide valid string data',
    error: code,
    originalData: data
  };
}

// Fallback function để xử lý DATA_TOO_LARGE error
export async function handleDataTooLarge(input) {
  const { code, message, data } = input;
  
  return {
    success: false,
    result: null,
    message: 'Data must be less than 10,000 characters',
    error: code,
    dataLength: data.data?.length || 0,
    maxLength: 10000
  };
}
```

#### **Fallback Function Guidelines**

| Pattern | Description | Example |
|---------|-------------|---------|
| **Validation Errors** | Trả về guidance message cho user | `handleInvalidEmail`, `handleMissingField` |
| **System Errors** | Log error và trả về generic message | `handleDatabaseError`, `handleApiTimeout` |
| **Business Logic Errors** | Trả về specific business context | `handleQuotaExceeded`, `handleInsufficientPermission` |
| **Retry Scenarios** | Include retry instructions | `handleRateLimit`, `handleTemporaryFailure` |

## 🚫 Common Mistakes

| ❌ Sai | ✅ Đúng | Giải thích |
|---------|---------|------------|
| `"name": "My Plugin"` | `"name": "my-plugin"` | Plugin names phải lowercase, hyphen-separated |
| `"field": "data"` không có description | `"field": "data", "description": "Input data to process"` | Luôn cung cấp description rõ ràng |
| `"required": "true"` | `"required": true` | Required field phải là boolean, không phải string |
| Không specify triggers | `"trigger_type": ["manual", "api"]` | Luôn define triggers cho function |
| `"outputs": "string"` | `"outputs": {"result": "string"}` | Outputs phải là object hoặc null |

## 🔗 Related Documentation

- **[Plugin Development Guide](../README.md)** - Hướng dẫn tổng quan
- **[Examples](./EXAMPLES.md)** - Các ví dụ thực tế
- **[CLI Commands](../README.md#cli-commands)** - Lệnh CLI để tạo và deploy
- **[Services Overview](../README.md#services-overview)** - Các services có sẵn 
