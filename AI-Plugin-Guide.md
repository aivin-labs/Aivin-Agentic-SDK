# 🚀 LeanEZ Plugin SDK - Hướng dẫn AI

## 📦 Packages Overview

| Package | Mô tả | Điều kiện sử dụng |
|---------|-------|-------------------|
| `LLMIO` | AI Chat, Embeddings, Assistants | Luôn có sẵn |
| `RedisIO` | Redis Cache, Pub/Sub | Có Redis stack trong env |
| `MongoIO` | MongoDB Database | Có MongoDB stack trong env |
| `PubSubIO` | Message Queue, Events | Luôn có sẵn |
| `ContextIO` | LeanEZ Context (User, Workspace) | Luôn có sẵn |
| `BullIO` | Background Jobs, Queue Processing | Luôn có sẵn |

## 📄 Manifest Configuration

### `manifest.json`
**Mục đích:** Cấu hình thông tin plugin và các hàm có thể gọi

**Các field chính:**
```json
{
  "name": "plugin-name",                // Tên plugin (unique identifier)
  "version": "1.0.0",                   // Version (tự động tăng khi deploy)
  "description": "Mô tả ngắn gọn",      // Mô tả chức năng plugin
  "author": "Tên tác giả",              // Thông tin tác giả  
  "email": "email@example.com",         // Email liên hệ
  "agent_specialized": ["*"],           // Agents được chuyên biệt hóa
  "agent_designated": [],               // Agents được chỉ định cụ thể
  "functions": [...]                    // Danh sách functions (xem bên dưới)
}
```

**Functions format:**
```json
{
  "name": "functionName",               // Tên function trong handler.ts
  "triggers": ["manual", "api", "chat"], // Các trigger types
  "description": "Mô tả chức năng",     // Giải thích function làm gì
  "inputs": [...],                      // Input parameters
  "outputs": [...],                     // Output structure
  "exceptions": [...],                  // Error handling (optional)
  "next_trigger": "plugin:function"     // Function tiếp theo (optional)
}
```

**Input/Output format:**
```json
{
  "field": "paramName",                 // Tên field
  "required": true,                     // Bắt buộc hay không
  "description": "Mô tả parameter",     // Giải thích ý nghĩa
  "type": "string",                     // Kiểu dữ liệu
  "default": "defaultValue"             // Giá trị mặc định (optional)
}
```

**Lưu ý:**
- `name`: Plugin name làm unique identifier
- `version`: Auto-increment sau deploy (1.0.0 → 1.0.1)  
- `functions`: Phải match với exports trong handler.ts
- `triggers`: Định nghĩa cách gọi function (manual, api, chat, schedule, event, webhook)
- `agent_specialized`: ["*"] = tất cả agents, hoặc list cụ thể ["sales", "support"]

## 📋 LLMIO Functions

### `LLMIO.prompt(message, options?)`
**Mục đích:** Gửi prompt tới AI và nhận response

**Đầu vào:**
- `message` (string): Nội dung prompt
- `options?` (object, optional):
  - `model?` (string): Model AI
    - OpenAI: "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo", "o1-preview", "o1-mini"
    - Anthropic: "claude-3-5-sonnet-20241022", "claude-3-opus-20240229", "claude-3-sonnet-20240229", "claude-3-haiku-20240307"
    - Gemini: "gemini-1.5-pro", "gemini-1.5-flash", "gemini-pro", "gemini-pro-vision"
  - `temperature?` (number): Độ sáng tạo 0-1 (0 = deterministic, 1 = creative)
  - `maxTokens?` (number): Giới hạn tokens (max output length)
  - `ttl?` (number): Cache TTL (seconds) - cache response để tránh gọi lại
  - `lang?` (string): Ngôn ngữ response
    - 'vi' = Tiếng Việt, 'en' = English, 'ja' = Japanese, 'ko' = Korean
  - `emoji?` (boolean): Bao gồm emoji trong response
  - `style?` (string): Style response
    - 'normal' = Bình thường, 'casual' = Thân thiện, 'formal' = Trang trọng, 'technical' = Kỹ thuật
  - `provider?` (string): AI provider
    - 'openai' = OpenAI (GPT models), 'anthropic' = Anthropic (Claude), 'gemini' = Gemini (Google models)
  - `seed?` (number): Random seed cho reproducible outputs
  - `schema?` (object): JSON Schema cho structured output
    - **Cấu trúc Schema:** Định nghĩa format JSON mà AI sẽ trả về
    - **Kiểu dữ liệu cơ bản:** string, number, boolean, array, object
    - **Mô tả field:** Sử dụng format `field_name: "type - description"`
    - **Nested objects:** Hỗ trợ object lồng nhau và arrays phức tạp
    - **Required fields:** Tự động validate theo cấu trúc định nghĩa
    - **Ứng dụng:** Data extraction, form generation, API responses, structured analysis
  - `reference?` (string): Reference string cho context
  - `audio?` (MediaItem): Audio input cho multimodal models
  - `video?` (MediaItem): Video input cho multimodal models
  - `images?` (MediaItem[]): Mảng hình ảnh cho vision models
  - `files?` (MediaItem[]): Mảng files đính kèm (PDF, docs, etc.)
  - `role?` (string): Role của user trong conversation
  - `context?` (any): Additional context data
  - `format?` (any): Output format specifications
  - `filter?` (string[]): Content filters to apply
  - `check?` (string): Validation checks to perform
  - `instructions?` (string): System instructions cho AI
  - `threadId?` (string): Thread ID cho conversation context

**Đầu ra:** `Promise<string>` - Response từ AI (hoặc JSON string nếu có schema)

**Schema Structure Examples:**
```javascript
// Basic schema - User information
schema: {
  name: "string - Full name of user",
  age: "number - Age in years", 
  email: "string - Email address"
}

// Complex nested schema - Investment analysis
schema: {
  analysis: {
    risk_level: "string - Investment risk (low/medium/high)",
    recommendations: [{
      action: "string - Action to take (buy/sell/hold)",
      reason: "string - Reasoning behind recommendation"
    }]
  },
  financial_data: {
    current_price: "number - Current stock price",
    target_price: "number - Predicted target price"
  }
}
```

### `LLMIO.getEmbedding(text, options?)`
**Mục đích:** Tạo vector embeddings từ text

**Đầu vào:**
- `text` (string): Text cần tạo embedding
- `options?` (object, optional):
  - `model?` (string): Embedding model
    - OpenAI: "text-embedding-3-large", "text-embedding-3-small", "text-embedding-ada-002"
    - Gemini: "text-embedding-004", "embedding-001"
    - Cohere: "embed-english-v3.0", "embed-multilingual-v3.0"
  - `provider?` (string): AI provider
    - 'openai' = OpenAI embeddings, 'gemini' = Gemini embeddings, 'cohere' = Cohere embeddings

**Đầu ra:** `Promise<number[]>` - Vector embeddings (mảng số float)

```javascript
// Ví dụ cơ bản với model mới nhất
const embedding = await LLMIO.getEmbedding("Hello world", {
  model: "text-embedding-3-large"  // Model mới nhất từ OpenAI
});
console.log(embedding); // [0.1, -0.2, 0.3, ...] (3072 dimensions)

// Ví dụ với Gemini embedding mới
const embedding = await LLMIO.getEmbedding("Text tiếng Việt", {
  model: "text-embedding-004",     // Gemini model mới nhất
  provider: "gemini"               // Sửa từ "google" thành "gemini"
});

// Ví dụ semantic search với model cao cấp
const query = "tìm kiếm sản phẩm công nghệ";
const queryEmbedding = await LLMIO.getEmbedding(query, {
  model: "text-embedding-3-large",  // Độ chính xác cao nhất
  provider: "openai"
});
const productEmbeddings = await Promise.all([
  LLMIO.getEmbedding("iPhone 15 Pro Max với camera 48MP"),
  LLMIO.getEmbedding("MacBook Air M3 siêu mỏng nhẹ"),
  LLMIO.getEmbedding("AirPods Pro 2 chống ồn thông minh")
]);
```

### `LLMIO.newAssistantThread()`
**Mục đích:** Tạo thread conversation mới cho AI Assistant

**Đầu vào:** Không có

**Đầu ra:** `Promise<string>` - Thread ID

```javascript
const threadId = await LLMIO.newAssistantThread();
```

### `LLMIO.getAssistantThread(threadId)`
**Mục đích:** Lấy thông tin thread conversation

**Đầu vào:**
- `threadId` (string): ID của thread

**Đầu ra:** `Promise<Thread>` - Object thread với messages

```javascript
const thread = await LLMIO.getAssistantThread(threadId);
console.log(thread.messages); // Lịch sử conversation
```

### `LLMIO.promptAssistant(threadId, model, message, options?)`
**Mục đích:** Chat với AI Assistant trong thread

**Đầu vào:**
- `threadId` (string): ID thread
- `model` (string): AI model
- `message` (string): Tin nhắn
- `options?` (object, optional): Các tùy chọn prompt

**Đầu ra:** `Promise<string>` - Response từ AI

```javascript
const response = await LLMIO.promptAssistant(
  threadId,
  "gpt-4",
  "Tiếp tục cuộc trò chuyện"
);
```

### `LLMIO.calculateTokens(params)`
**Mục đích:** Tính số tokens và cost

**Đầu vào:**
- `params` (object):
  - `inputText?` (string): Text để tính
  - `model` (string): AI model
  - `messages?` (array, optional): Mảng messages cho conversation

**Đầu ra:** `Promise<{tokens: number, cost: number}>` - Thông tin tokens và cost

```javascript
const info = await LLMIO.calculateTokens({
  inputText: "Hello world",
  model: "gpt-4"
});
console.log(info); // {tokens: 2, cost: 0.00004}
```

## 📋 RedisIO Functions

### `RedisIO.get(key, initData?)`
**Mục đích:** Lấy dữ liệu từ Redis với hỗ trợ initData

**Đầu vào:**
- `key` (string): Redis key
- `initData?` (any, optional): Dữ liệu mặc định nếu key không tồn tại

**Đầu ra:** `Promise<any>` - Dữ liệu được deserialize, hoặc initData nếu key không tồn tại

```javascript
const userData = await RedisIO.get("user:123", {name: "Guest"});
```

### `RedisIO.update(key, data, opts?)`
**Mục đích:** Lưu dữ liệu vào Redis (tự động sanitize và serialize)

**Đầu vào:**
- `key` (string): Redis key
- `data` (any): Dữ liệu cần lưu (tự động sanitize các field null/empty)
- `opts?` (object, optional): Redis SET options (EX, PX, NX, XX)

**Đầu ra:** `Promise<string|null>` - "OK" nếu thành công

```javascript
await RedisIO.update("user:123", {name: "John", age: 30}, {EX: 3600});
```

### `RedisIO.set(key, value, ttl?)`
**Mục đích:** Lưu data vào Redis với optional TTL

**Đầu vào:**
- `key` (string): Redis key
- `value` (any): Giá trị cần lưu
- `ttl?` (number, optional): Time to live in seconds

**Đầu ra:** `Promise<void>`

```javascript
// Lưu vĩnh viễn
await RedisIO.set('user:123', { name: 'John', email: 'john@example.com' });

// Lưu với TTL 1 giờ
await RedisIO.set('session:abc', { userId: 123, token: 'xyz' }, 3600);
```

### `RedisIO.has(key)`
**Mục đích:** Kiểm tra key có tồn tại

**Đầu vào:**
- `key` (string): Redis key

**Đầu ra:** `Promise<number>` - 1 nếu tồn tại, 0 nếu không

```javascript
const exists = await RedisIO.has("user:123");
```

### `RedisIO.delete(key)`
**Mục đích:** Xóa key khỏi Redis

**Đầu vào:**
- `key` (string): Redis key

**Đầu ra:** `Promise<number>` - Số key đã xóa

```javascript
await RedisIO.delete("user:123");
```

### `RedisIO.publish(channel, message)`
**Mục đích:** Publish message tới channel

**Đầu vào:**
- `channel` (string): Tên channel
- `message` (string): Message (phải serialize trước)

**Đầu ra:** `Promise<number>` - Số subscribers nhận được

```javascript
await RedisIO.publish("notifications", JSON.stringify({type: "alert"}));
```

### `RedisIO.subscribe(channel, callback)`
**Mục đích:** Subscribe tới channel

**Đầu vào:**
- `channel` (string): Tên channel
- `callback` (function): Function xử lý message `(message: string) => void`

**Đầu ra:** `Promise<void>`

```javascript
await RedisIO.subscribe("notifications", (message) => {
  console.log("Received:", JSON.parse(message));
});
```

### `RedisIO.unsubscribe(channel)`
**Mục đích:** Unsubscribe khỏi channel

**Đầu vào:**
- `channel` (string): Tên channel cần unsubscribe

**Đầu ra:** `Promise<void>`

```javascript
await RedisIO.unsubscribe("notifications");
```

### `RedisIO.getConfig()`
**Mục đích:** Lấy cấu hình Redis hiện tại

**Đầu vào:** Không có

**Đầu ra:** `RedisClientOptions` - Cấu hình Redis hiện tại

```javascript
const config = RedisIO.getConfig();
console.log(config);
```

### `RedisIO.getClient()`
**Mục đích:** Lấy native Redis client để thực hiện advanced operations

**Đầu vào:** Không có

**Đầu ra:** `RedisClientType` - Native Redis client instance

```javascript
const client = RedisIO.getClient();

// Hash operations
await client.hSet('user:123', 'name', 'John Doe');
const name = await client.hGet('user:123', 'name');

// List operations
await client.lPush('tasks:pending', 'task1', 'task2');
const task = await client.rPop('tasks:pending');

// Set operations
await client.sAdd('user:123:interests', 'nodejs', 'react', 'vue');
const interests = await client.sMembers('user:123:interests');
```

## 📋 MongoIO Functions

### `MongoIO.Schema`
**Mục đích:** Mongoose Schema constructor để tạo schema cho collection

**Đầu vào:**
- `definition` (object): Schema definition object
- `options?` (object, optional): Schema options

**Đầu ra:** `Schema` - Mongoose Schema instance

```javascript
const userSchema = new MongoIO.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  age: { type: Number, min: 0 },
  createdAt: { type: Date, default: Date.now }
});
```

### `MongoIO.model(name, schema)`
**Mục đích:** Tạo Mongoose model từ schema

**Đầu vào:**
- `name` (string): Tên model
- `schema` (Schema): Mongoose schema

**Đầu ra:** `Model` - Mongoose model để thao tác với collection

```javascript
const User = MongoIO.model('User', userSchema);

// Sử dụng native Mongoose API
const newUser = new User({
  name: 'John Doe',
  email: 'john@example.com',
  age: 30
});
await newUser.save();

// Tìm kiếm
const users = await User.find({ age: { $gte: 18 } });
const user = await User.findOne({ email: 'john@example.com' });

// Cập nhật
await User.updateOne(
  { email: 'john@example.com' },
  { $set: { age: 31 } }
);

// Xóa
await User.deleteOne({ email: 'john@example.com' });
```

### `MongoIO.isReady()`
**Mục đích:** Kiểm tra trạng thái kết nối MongoDB

**Đầu vào:** Không có

**Đầu ra:** `boolean` - true nếu kết nối đã sẵn sàng

```javascript
if (MongoIO.isReady()) {
  console.log('MongoDB connection is ready!');
} else {
  console.log('MongoDB connection not ready yet...');
}
```

### `MongoIO.healthCheck()`
**Mục đích:** Kiểm tra sức khỏe kết nối MongoDB

**Đầu vào:** Không có

**Đầu ra:** `Promise<HealthStatus>` - Thông tin sức khỏe kết nối

```javascript
const health = await MongoIO.healthCheck();
console.log(health);
// Output: { status: 'connected', latency: 15, dbName: 'myapp' }
```

### `MongoIO.disconnect()`
**Mục đích:** Đóng kết nối MongoDB

**Đầu vào:** Không có

**Đầu ra:** `Promise<void>` - Promise hoàn thành khi đóng kết nối

```javascript
await MongoIO.disconnect();
console.log('MongoDB connection closed');
```

### **Sử dụng với Native Mongoose API:**

```javascript
// Schema với middleware và methods
const productSchema = new MongoIO.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  category: { type: String, required: true },
  inStock: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// Pre-save middleware
productSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Instance method
productSchema.methods.toggleStock = function() {
  this.inStock = !this.inStock;
  return this.save();
};

// Static method
productSchema.statics.findByCategory = function(category) {
  return this.find({ category, inStock: true });
};

const Product = MongoIO.model('Product', productSchema);

// Sử dụng
const product = new Product({
  name: 'iPhone 15',
  price: 999.99,
  category: 'electronics'
});

await product.save();
await product.toggleStock();

const electronics = await Product.findByCategory('electronics');

// Aggregation pipeline
const analytics = await Product.aggregate([
  { $match: { inStock: true } },
  { $group: { _id: '$category', total: { $sum: 1 } } },
  { $sort: { total: -1 } }
]);
```

## 📋 BullIO Functions

### `BullIO.emit<T, R>(params)`
**Mục đích:** Tạo queue và đăng ký tự động handler có thể tái sử dụng

**Đầu vào:**
- `params` (object):
  - `name` (string): Tên queue duy nhất
  - `data?` (T): Dữ liệu đầu vào cho handler
  - `handler` (function): Function xử lý job `(jobData: T, job?: Bull.Job<T>) => any | Promise<any>`
  - `threadId?` (string): ID để quản lý jobs theo nhóm
  - `temp?` (boolean): Queue tạm thời (tự xóa sau khi xong), mặc định false
  - `concurrency?` (number): Số jobs chạy đồng thời, mặc định 1
  - `jobOpts?` (object): Tùy chọn job (retry, timeout, etc.)
  - `queueOpts?` (object): Tùy chọn queue

**Đầu ra:** `Promise<R>` - Kết quả từ handler function

```javascript
const result = await BullIO.emit({
  name: 'email-sender',
  data: { to: 'user@example.com', subject: 'Welcome!' },
  handler: async (data) => {
    await sendEmail(data.to, data.subject);
    return { sent: true, timestamp: Date.now() };
  }
});
```

### `BullIO.submit<T>(params)`
**Mục đích:** Gửi job vào queue đã tồn tại (phải tạo queue bằng newInstance trước)

**Đầu vào:**
- `params` (object):
  - `name` (string): Tên queue đã tồn tại
  - `data` (T): Dữ liệu job
  - `options?` (object): Tùy chọn job

**Đầu ra:** `Promise<Bull.Job<T>>` - Bull job object với ID và metadata

```javascript
const job = await BullIO.submit({
  name: 'image-resizer',
  data: { imageUrl: 'https://example.com/image.jpg', width: 800, height: 600 },
  options: { priority: 1, attempts: 3, delay: 5000 }
});
```

### `BullIO.newInstance<T>(params)`
**Mục đích:** Tạo queue processor để xử lý jobs liên tục

**Đầu vào:**
- `params` (object):
  - `name` (string): Tên queue duy nhất
  - `handler` (function): Handler xử lý job `(job: Bull.Job<T>) => any`
  - `concurrency?` (number): Số jobs chạy đồng thời, mặc định 1
  - `queueOpts?` (object): Tùy chọn queue

**Đầu ra:** `Promise<Bull.Queue<T>>` - Bull Queue instance

```javascript
const videoQueue = await BullIO.newInstance({
  name: 'video-processor',
  handler: async (job) => {
    const { videoUrl, format, quality } = job.data;
    await job.progress(50);
    return { processedUrl: 'https://cdn.example.com/video.mp4' };
  },
  concurrency: 2
});
```

### `BullIO.listen<T>(params)`
**Mục đích:** Tạo queue và lắng nghe jobs (đơn giản hơn newInstance)

**Đầu vào:**
- `params` (object):
  - `name` (string): Tên queue
  - `handler` (function): Handler xử lý `(jobData: T, job?: Bull.Job<T>) => any`
  - `concurrency?` (number): Số jobs chạy đồng thời, mặc định 1

**Đầu ra:** `Promise<Bull.Queue<T>>` - Bull Queue instance

```javascript
const logQueue = await BullIO.listen({
  name: 'log-processor',
  handler: async (logData, job) => {
    await saveLogToDatabase(logData);
    return { saved: true, logId: generateLogId() };
  },
  concurrency: 5
});
```

### `BullIO.cancelRunningJobs(threadId)`
**Mục đích:** Hủy tất cả jobs đang chạy trong một thread cụ thể

**Đầu vào:**
- `threadId` (string): ID của thread cần hủy jobs

**Đầu ra:** `Promise<void>`

```javascript
await BullIO.cancelRunningJobs('user-123');
```

### `BullIO.getRunningJobs(threadId?)`
**Mục đích:** Lấy danh sách jobs đang chạy, có thể lọc theo threadId

**Đầu vào:**
- `threadId?` (string, optional): ID thread để lọc (nếu không có sẽ lấy tất cả)

**Đầu ra:** `Promise<Bull.Job[]>` - Mảng các Bull Job objects đang chạy

```javascript
const allJobs = await BullIO.getRunningJobs();
const userJobs = await BullIO.getRunningJobs('user-789');
```

### `BullIO.fastEmit(params)`
**Mục đích:** Gửi message nhanh qua Redis pub/sub (không persistence, không queue)

**Đầu vào:**
- `params` (object):
  - `channel` (string): Tên channel
  - `data` (any): Dữ liệu gửi

**Đầu ra:** `Promise<void>`

```javascript
await BullIO.fastEmit({
  channel: 'user-notifications',
  data: {
    userId: 'user123',
    type: 'order_status',
    message: 'Your order #456 has been shipped'
  }
});
```

### `BullIO.fastListen(channel, handler)`
**Mục đích:** Lắng nghe message nhanh từ Redis pub/sub channel

**Đầu vào:**
- `channel` (string): Tên channel cần lắng nghe
- `handler` (function): Function xử lý message `(data: any) => void | Promise<void>`

**Đầu ra:** `Promise<void>`

```javascript
await BullIO.fastListen('user-notifications', async (data) => {
  console.log(`New notification for user ${data.userId}:`, data.message);
  await sendToUserSocket(data.userId, data);
});
```

### `BullIO.getQueues()`
**Mục đích:** Lấy danh sách tất cả queues đang hoạt động

**Đầu vào:** Không có

**Đầu ra:** `Bull.Queue[]` - Mảng các Bull Queue instances

```javascript
const queues = BullIO.getQueues();
for (const queue of queues) {
  const waiting = await queue.getWaiting();
  console.log(`Queue ${queue.name}: ${waiting.length} waiting jobs`);
}
```

## 📋 PubSubIO Functions

### `PubSubIO.publish(channel, data)`
**Mục đích:** Gửi message tới một channel. Tất cả subscribers sẽ nhận được message

**Đầu vào:**
- `channel` (string): Tên channel để publish
- `data` (any): Dữ liệu gửi đi

**Đầu ra:** `Promise<void>`

```javascript
// Task status updates
await PubSubIO.publish('task-status', {
  taskId: 'task-456',
  status: 'in-progress',
  assignee: 'user123',
  updatedAt: new Date().toISOString()
});

// User activity tracking
await PubSubIO.publish('user-activity', {
  userId: 'user789',
  action: 'login',
  timestamp: Date.now(),
  ip: '192.168.1.100'
});
```

### `PubSubIO.subscribe(channel, handler)`
**Mục đích:** Lắng nghe messages từ một channel. Handler sẽ được gọi mỗi khi có message mới

**Đầu vào:**
- `channel` (string): Tên channel để subscribe
- `handler` (function): Function xử lý message `(data: any) => void | Promise<void>`

**Đầu ra:** `Promise<void>`

```javascript
// Real-time task updates
await PubSubIO.subscribe('task-updates', async (data) => {
  console.log(`Task ${data.taskId} status: ${data.status}`);
  
  // Update UI
  await updateTaskInUI(data.taskId, data.status);
  
  // Send notification if completed
  if (data.status === 'completed') {
    await sendCompletionNotification(data.assignee);
  }
});

// User presence tracking
await PubSubIO.subscribe('user-presence', async (data) => {
  console.log(`User ${data.userId} is now ${data.status}`);
  await updateUserPresence(data.userId, data.status);
});
```

### `PubSubIO.request<T>(channel, data)`
**Mục đích:** Gửi request và chờ response. Sử dụng cho request/response pattern

**Đầu vào:**
- `channel` (string): Tên channel để gửi request
- `data` (any): Dữ liệu request

**Đầu ra:** `Promise<T>` - Response data từ handler

```javascript
// Get user information
const userInfo = await PubSubIO.request('get-user', {
  userId: 'user123',
  includeProfile: true
});
console.log(`User: ${userInfo.name} (${userInfo.email})`);

// Get task details
const taskDetails = await PubSubIO.request('get-task', {
  taskId: 'task-456',
  includeComments: true
});

// Validate data
const validation = await PubSubIO.request('validate-data', {
  data: { name: 'John', age: 25 },
  schema: 'user-schema'
});
```

### `PubSubIO.reply(channel, handler)`
**Mục đích:** Xử lý requests từ một channel. Handler phải return response data

**Đầu vào:**
- `channel` (string): Tên channel để xử lý requests
- `handler` (function): Function xử lý request và return response `(data: any) => any | Promise<any>`

**Đầu ra:** `Promise<void>`

```javascript
// Handle user info requests
await PubSubIO.reply('get-user', async (request) => {
  const user = await getUserFromDatabase(request.userId);
  
  if (!user) {
    throw new Error(`User ${request.userId} not found`);
  }
  
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    profile: request.includeProfile ? user.profile : undefined
  };
});

// Handle data validation
await PubSubIO.reply('validate-data', async (request) => {
  try {
    const schema = await getValidationSchema(request.schema);
    const errors = validateAgainstSchema(request.data, schema);
    
    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  } catch (error) {
    return {
      valid: false,
      errors: [`Validation error: ${error.message}`]
    };
  }
});
```

### `PubSubIO.unsubscribe(channel)`
**Mục đích:** Hủy subscription từ một channel

**Đầu vào:**
- `channel` (string): Tên channel để hủy subscription

**Đầu ra:** `Promise<void>`

```javascript
// Component cleanup
class ComponentManager {
  private subscriptions = ['task-updates', 'user-activity', 'system-alerts'];
  
  async cleanup() {
    for (const channel of this.subscriptions) {
      await PubSubIO.unsubscribe(channel);
      console.log(`Unsubscribed from ${channel}`);
    }
  }
}
```

### `PubSubIO.getActiveChannels()`
**Mục đích:** Lấy danh sách các channels đang active

**Đầu vào:** Không có

**Đầu ra:** `string[]` - Mảng tên các channels đang hoạt động

```javascript
// Monitor active channels
const activeChannels = PubSubIO.getActiveChannels();
console.log('Active channels:', activeChannels);

// Health check
if (activeChannels.includes('system-health')) {
  console.log('✅ System health monitoring is active');
} else {
  console.warn('⚠️ System health monitoring is not active');
}
```

## 📋 ContextIO Functions

### `ContextIO.getCurrentUser()`
**Mục đích:** Lấy thông tin người dùng hiện tại

**Đầu vào:** Không có

**Đầu ra:** `Promise<User>` - Thông tin user hiện tại

```javascript
const user = await ContextIO.getCurrentUser();
console.log(user); // {id: 'user123', name: 'John Doe', email: 'john@example.com'}
```

### `ContextIO.getCurrentWorkspace()`
**Mục đích:** Lấy thông tin workspace hiện tại

**Đầu vào:** Không có

**Đầu ra:** `Promise<Workspace>` - Thông tin workspace hiện tại

```javascript
const workspace = await ContextIO.getCurrentWorkspace();
console.log(workspace); // {id: 'ws123', name: 'My Workspace', settings: {...}}
```

### `ContextIO.getCurrentSession()`
**Mục đích:** Lấy thông tin session hiện tại

**Đầu vào:** Không có

**Đầu ra:** `Promise<Session>` - Thông tin session hiện tại

```javascript
const session = await ContextIO.getCurrentSession();
console.log(session); // {id: 'session123', startTime: '2024-01-01T00:00:00Z', active: true}
```

### `ContextIO.getAgents()`
**Mục đích:** Lấy danh sách agents

**Đầu vào:** Không có

**Đầu ra:** `Promise<Agent[]>` - Danh sách các agents

```javascript
const agents = await ContextIO.getAgents();
console.log(agents); // [{id: 'agent1', name: 'Assistant', type: 'chat'}]
```

### `ContextIO.getFileShares()`
**Mục đích:** Lấy danh sách file shares

**Đầu vào:** Không có

**Đầu ra:** `Promise<FileShare[]>` - Danh sách file shares

```javascript
const fileShares = await ContextIO.getFileShares();
console.log(fileShares); // [{id: 'share1', fileName: 'document.pdf', permissions: 'read'}]
```

### `ContextIO.getProjects()`
**Mục đích:** Lấy danh sách projects

**Đầu vào:** Không có

**Đầu ra:** `Promise<Project[]>` - Danh sách projects

```javascript
const projects = await ContextIO.getProjects();
console.log(projects); // [{id: 'proj1', name: 'My Project', status: 'active'}]
```

## 🔧 Error Handling

### Try-Catch Pattern
```javascript
export async function myFunction(params) {
  try {
    const result = await LLMIO.prompt("Hello AI");
    return { success: true, data: result };
  } catch (error) {
    console.error("AI request failed", error.message);
    return { success: false, error: error.message };
  }
}
```

### Validation Example
```javascript
export async function processUserData(userData) {
  if (!userData.email) {
    throw new Error("Email is required");
  }
  
  try {
    // Process data
    const result = await MongoIO.insertOne("users", userData);
    await PubSubIO.publish("user-events", {
      type: "user_created",
      userId: result.insertedId
    });
    
    return { success: true, userId: result.insertedId };
  } catch (error) {
    console.error("Failed to process user data", {
      error: error.message,
      userData
    });
    throw error;
  }
}
```