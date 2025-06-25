# 🚀 LeanEZ Plugin SDK

[![npm version](https://badge.fury.io/js/%40leanez%2Fsdk.svg)](https://badge.fury.io/js/%40leanez%2Fsdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

LeanEZ Plugin SDK cho phép developers xây dựng AI-powered plugins với JavaScript/TypeScript một cách nhanh chóng và dễ dàng.

## ✨ Tính năng chính

- 🤖 **AI Integration** - Tích hợp sẵn LLM và AI capabilities
- 📊 **Multi-Database Support** - MongoDB, Redis với APIs đơn giản
- ⚡ **Background Processing** - Queue system với Bull.js
- 🔄 **Real-time Communication** - PubSub messaging
- 🛠️ **Type-safe** - Full TypeScript support
- 🚀 **CLI Tools** - Tạo, test, và deploy plugins dễ dàng

## 🚀 Quick Start

### Cài đặt
```bash
npm install @leanez/sdk
```

### Tạo plugin Hello World
```bash
# Tạo plugin đơn giản
leanez create hello-world

# Di chuyển vào thư mục plugin
cd examples/hello-world

# Start plugin server
leanez start

# Deploy plugin
leanez deploy
```

## 🛠️ **CLI Commands**

### `leanez create` - Tạo plugin mới

| Option | Mô tả | Mặc định | Ví dụ |
|--------|-------|----------|-------|
| `--json <config>` | Tạo từ JSON config (AI mode) | - | `leanez create --json '{"name":"hello","stacks":["AI_LLM"]}'` |
| `--stdin` | Đọc config từ stdin | - | `echo '{"name":"test"}' \| leanez create --stdin` |
| `--output-dir <dir>` | Thư mục output | `examples` | `leanez create --output-dir plugins` |
| `--silent` | Mode im lặng | - | `leanez create --silent` |
| `--json-output` | Output JSON format | - | `leanez create --json-output` |

**Ví dụ sử dụng:**
```bash
# Interactive mode (khuyến nghị)
leanez create

# Từ JSON string
leanez create --json '{"name":"my-plugin","stacks":["AI_LLM","REDIS_CACHE"]}'

# Từ file JSON
leanez create --json config.json
```

### `leanez validate` - Validate cấu hình plugin

| Option | Mô tả | Ví dụ |
|--------|-------|-------|
| `--json <config>` | JSON config cần validate | `leanez validate --json config.json` |
| `--stdin` | Đọc từ stdin | `cat manifest.json \| leanez validate --stdin` |
| `--json-output` | Output JSON format | `leanez validate --json config.json --json-output` |

**Ví dụ sử dụng:**
```bash
# Validate file
leanez validate --json manifest.json

# Validate từ stdin
cat manifest.json | leanez validate --stdin

# Output JSON format cho scripting
leanez validate --json manifest.json --json-output
```

### `leanez list-stacks` - Liệt kê available stacks

| Option | Mô tả | Ví dụ |
|--------|-------|-------|
| `--json` | Output JSON format | `leanez list-stacks --json` |

**Ví dụ sử dụng:**
```bash
# Hiển thị danh sách stacks
leanez list-stacks

# Output JSON format
leanez list-stacks --json
```

### `leanez start` - Start plugin server

**Không có options**

```bash
# Start server trong thư mục plugin
leanez start
```

### `leanez deploy` - Deploy plugin lên server

**Không có options**

```bash
# Deploy plugin hiện tại
leanez deploy
```

### `leanez login` - Login và lấy API key

| Option | Mô tả | Ví dụ |
|--------|-------|-------|
| `-k, --api-key <key>` | Set API key trực tiếp | `leanez login --api-key YOUR_API_KEY` |

**Ví dụ sử dụng:**
```bash
# Login interactive với email/password
leanez login

# Set API key trực tiếp
leanez login --api-key YOUR_API_KEY
```

## 💡 **Hello World Example**

### Tạo plugin Hello World đơn giản

**Bước 1: Tạo plugin**
```bash
leanez create hello-world
cd examples/hello-world
```

**Bước 2: Code được tạo tự động**

**manifest.json:**
```json
{
  "name": "hello-world",
  "version": "1.0.0",
  "description": "Simple hello world plugin",
  "functions": [
    {
      "name": "main",
      "triggers": ["manual", "api", "chat"],
      "description": "Say hello to user",
      "inputs": [
        {
          "field": "name",
          "required": false,
          "description": "Name to greet",
          "type": "string",
          "default": "World"
        }
      ],
      "outputs": [
        {
          "field": "success",
          "description": "Operation success status",
          "type": "boolean"
        },
        {
          "field": "message",
          "description": "Hello message",
          "type": "string"
        }
      ]
    }
  ]
}
```

**handler.js:**
```javascript
import { LLMIO } from '@leanez/sdk';

// Main function - AI sẽ gọi để chạy plugin
export async function main(input) {
  try {
    const { name = "World" } = input;
    
    // Sử dụng AI để tạo message personalized
    const greeting = await LLMIO.prompt(
      `Create a friendly, creative greeting for someone named "${name}". Keep it under 50 words.`
    );
    
    return {
      success: true,
      message: greeting || `Hello, ${name}! Welcome to LeanEZ!`
    };
  } catch (error) {
    return {
      success: false,
      message: `Error: ${error.message}`
    };
  }
}
```

**Bước 3: Test và Deploy**
```bash
# Validate config
leanez validate --json manifest.json

# Start server (để test local)
leanez start

# Deploy lên production
leanez deploy
```

**Bước 4: Cách AI sử dụng:**
```javascript
// AI sẽ gọi plugin như này:
const result = await plugin.main({ name: "Alice" });
// Output: { success: true, message: "Hello Alice! Hope you're having a wonderful day!" }
```

## 📋 **Manifest File**

Manifest file (`manifest.json`) định nghĩa cấu hình và metadata của plugin.

### 🤖 Function Roles trong AI System

- **`main` Function**: Entry point mặc định - AI gọi tự động khi sử dụng plugin
- **Tool Functions**: AI gọi theo nhu cầu cụ thể (như function calls trong OpenAI)
- **Event Functions**: Được trigger bởi system events hoặc `next_trigger`

**AI Workflow:**
1. AI gọi `main()` để khởi động plugin
2. Nếu cần, AI gọi các tool functions cụ thể (`createTask`, `searchData`, etc.)
3. Plugin có thể chain functions với `next_trigger`

### Available Stacks (cho CLI create)
| Stack | Description | Dependencies |
|-------|-------------|--------------|
| `AI_LLM` | Large Language Models | `@leanez/sdk` |
| `REDIS_CACHE` | In-memory caching | `redis` |
| `MONGODB` | NoSQL database | `mongoose` |
| `BACKGROUND_JOBS` | Queue system | `bull`, `redis` |
| `REALTIME_COMMUNICATION` | Real-time messaging | `redis` |

**Lưu ý**: Stacks chỉ dùng trong CLI để generate code và dependencies. Manifest.json KHÔNG chứa stacks.

📋 **Chi tiết về Manifest**: Xem [MANIFEST.md](docs/MANIFEST.md) để hiểu đầy đủ về cấu trúc, properties và examples.

📚 **Chi tiết và ví dụ nâng cao**: Xem [EXAMPLES.md](docs/EXAMPLES.md)

## 🛠️ Services Overview

### 🤖 LLMIO - AI Integration
```javascript
// Text generation
const response = await LLMIO.prompt("Your prompt", options);

// Embeddings
const embedding = await LLMIO.getEmbedding("text to embed");

// Configuration
LLMIO.configure({ model: "gpt-4", temperature: 0.5 });
```

### 🗄️ MongoIO - Database Operations
```javascript
// Define model
const User = MongoIO.model('User', new MongoIO.Schema({
  name: String,
  email: String,
  createdAt: { type: Date, default: Date.now }
}));

// CRUD operations
const user = new User({ name: 'John', email: 'john@example.com' });
await user.save();

const users = await User.find({ name: 'John' });
```

### ⚡ RedisIO - Caching
```javascript
// Set data với TTL
await RedisIO.update('key', { data: 'value' }, { EX: 3600 });

// Get data với default
const data = await RedisIO.get('key', { default: 'fallback' });

// Delete
await RedisIO.delete('key');
```

### 🔄 BullIO - Background Jobs
```javascript
// Emit background job
const result = await BullIO.emit({
  name: 'process-data',
  data: { userId: 123 },
  handler: async (data) => {
    // Process logic here
    return { processed: true };
  },
  delay: 5000 // 5 seconds delay
});
```

### 📡 PubSubIO - Real-time Communication
```javascript
// Publish message
await PubSubIO.publish('channel', { message: 'Hello' });

// Subscribe to channel
await PubSubIO.subscribe('channel', (data) => {
  console.log('Received:', data);
});

// Unsubscribe
await PubSubIO.unsubscribe('channel');
```

### 👤 ContextIO - User & Workspace Context
```javascript
// Get current user
const user = await ContextIO.getCurrentUser();

// Get current workspace
const workspace = await ContextIO.getCurrentWorkspace();

// Get user projects
const projects = await ContextIO.getProjects();
```

## 📚 Tài liệu chi tiết

- 📋 **[Manifest Documentation](./docs/MANIFEST.md)** - Chi tiết về cấu hình manifest
- 🤖 **[LLMIO Documentation](./docs/LLMIO.md)** - AI integration guide
- 🗄️ **[MongoIO Documentation](./docs/MongoIO.md)** - Database operations
- ⚡ **[RedisIO Documentation](./docs/RedisIO.md)** - Caching strategies
- 🔄 **[BullIO Documentation](./docs/BullIO.md)** - Background processing
- 📡 **[PubSubIO Documentation](./docs/PubSubIO.md)** - Real-time messaging
- 📖 **[Ví dụ chi tiết](./docs/EXAMPLES.md)** - Các use cases thực tế

## 🚀 Workflow Development

### 1. Planning
- Xác định use case và features cần thiết
- Chọn stacks phù hợp
- Thiết kế input/output schema

### 2. Setup
```bash
leanez create my-plugin
cd my-plugin
```

### 3. Development
- Code logic trong `handler.js`
- Mô tả plugins trong `manifest.json`
- Start server với `leanez start`
- Validate config với `leanez validate`

### 4. Deployment
```bash
leanez validate
leanez deploy
```

## 📊 Best Practices

### ✅ Do's
- Sử dụng TypeScript cho type safety
- Validate input data trước khi xử lý
- Handle errors gracefully
- Cache kết quả để tối ưu performance
- Sử dụng background jobs cho tasks nặng

### ❌ Don'ts
- Không block main thread với heavy computations
- Không hard-code sensitive data
- Không ignore error handling
- Không forget cleanup resources

## 🤝 Contributing

Chúng tôi hoan nghênh contributions! Vui lòng xem [CONTRIBUTING.md](./CONTRIBUTING.md) để biết thêm chi tiết.

## 📝 License

MIT © [LeanEZ Team](https://leanez.app) 