# PubSubIO Documentation

Hệ thống Pub/Sub cho LeanEZ Plugin SDK, sử dụng Redis làm message broker.

## ✨ **Tính năng chính**

- **Event Publishing**: Publish messages đến channels
- **Event Subscription**: Subscribe và lắng nghe messages
- **Request-Response Pattern**: Gửi request và nhận response async
- **Error Handling**: Xử lý lỗi toàn diện

## 🚀 **Quick Start**

### **Sử dụng đơn giản - Chỉ cần import!**

```typescript
// Import SDK - Tự động khởi tạo tất cả services
import { PubSubIO, RedisIO } from '@leanez/sdk';

// SDK đã sẵn sàng sử dụng ngay lập tức!
async function example() {
  // Publish message
  await PubSubIO.publish('user.registered', {
    userId: '12345',
    email: 'user@example.com'
  });

  // Subscribe to events
  await PubSubIO.subscribe('user.updated', (data) => {
    console.log('User updated:', data);
  });

  // Request-response pattern
  const result = await PubSubIO.request('user.get', { userId: '12345' });
  console.log('User data:', result);
}

example().catch(console.error);
```

### **Environment Variables (Auto-detect)**

SDK tự động detect cấu hình từ environment variables:

```bash
# Local Redis (cho caching, jobs, etc.)
REDIS_URL=redis://localhost:6379

# Backend Redis (cho communication với LeanEZ)
BACKEND_REDIS_URL=redis://api.leanez.app
BACKEND_REDIS_PASSWORD=your-password

# Hoặc riêng biệt
BACKEND_REDIS_HOST=api.leanez.app
BACKEND_REDIS_PORT=6379
BACKEND_REDIS_PASSWORD=your-password

# LeanEZ Backend URL (tự động detect)
# Development: http://localhost:3000 (auto)
# Production: https://api.leanez.app (auto)
# Custom: LEANEZ_BASE_URL=your-custom-url
```

### **Manual Configuration (Advanced)**

Chỉ khi cần cấu hình tùy chỉnh cho Redis connections:

```typescript
// Nếu cần override default Redis connections
// Chỉ cần set environment variables trước khi import:

// Option 1: Set via process.env
process.env.BACKEND_REDIS_HOST = 'custom.redis.server';
process.env.BACKEND_REDIS_PASSWORD = 'custom-password';

// Option 2: Use .env file
// BACKEND_REDIS_HOST=custom.redis.server
// BACKEND_REDIS_PASSWORD=custom-password

// Sau đó import và sử dụng ngay
import { PubSubIO, RedisIO } from '@leanez/sdk';
await PubSubIO.publish('test', 'Hello World');
```

## 🎯 **API Reference**

### `PubSubIO.publish(channel, data): Promise<void>`

**Mục đích:** Gửi message tới một channel. Tất cả subscribers sẽ nhận được message.

#### Tham số đầu vào

| Tham số | Kiểu dữ liệu | Bắt buộc | Mô tả |
|---------|--------------|----------|-------|
| `channel` | `string` | ✅ | Tên channel để publish |
| `data` | `any` | ✅ | Dữ liệu gửi đi |

#### Giá trị trả về

| Kiểu | Mô tả |
|------|-------|
| `Promise<void>` | Không trả về giá trị |

#### Ví dụ sử dụng

```typescript
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

// System notifications
await PubSubIO.publish('system-alerts', {
  level: 'warning',
  message: 'High memory usage detected',
  service: 'api-server',
  metrics: { memoryUsage: 85, cpuUsage: 60 }
});
```

---

### `PubSubIO.subscribe(channel, handler): Promise<void>`

**Mục đích:** Lắng nghe messages từ một channel. Handler sẽ được gọi mỗi khi có message mới.

#### Tham số đầu vào

| Tham số | Kiểu dữ liệu | Bắt buộc | Mô tả |
|---------|--------------|----------|-------|
| `channel` | `string` | ✅ | Tên channel để subscribe |
| `handler` | `(data: any) => void \| Promise<void>` | ✅ | Function xử lý message |

#### Giá trị trả về

| Kiểu | Mô tả |
|------|-------|
| `Promise<void>` | Không trả về giá trị |

#### Ví dụ sử dụng

```typescript
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
interface UserPresence {
  userId: string;
  status: 'online' | 'offline' | 'away';
  lastSeen: string;
}

await PubSubIO.subscribe('user-presence', async (data: UserPresence) => {
  console.log(`User ${data.userId} is now ${data.status}`);
  
  // Update presence indicator
  await updateUserPresence(data.userId, data.status);
  
  // Log activity
  await logUserActivity(data);
});

// System monitoring
await PubSubIO.subscribe('system-metrics', async (metrics) => {
  console.log('System metrics:', metrics);
  
  // Check for alerts
  if (metrics.memoryUsage > 90) {
    await triggerAlert('high-memory', metrics);
  }
  
  // Update dashboard
  await updateMetricsDashboard(metrics);
});
```

---

### `PubSubIO.request<T>(channel, data): Promise<T>`

**Mục đích:** Gửi request và chờ response. Sử dụng cho request/response pattern.

#### Tham số đầu vào

| Tham số | Kiểu dữ liệu | Bắt buộc | Mô tả |
|---------|--------------|----------|-------|
| `channel` | `string` | ✅ | Tên channel để gửi request |
| `data` | `any` | ✅ | Dữ liệu request |

#### Giá trị trả về

| Kiểu | Mô tả |
|------|-------|
| `Promise<T>` | Response data từ handler |

#### Ví dụ sử dụng

```typescript
// Get user information
interface UserRequest {
  userId: string;
  includeProfile?: boolean;
}

interface UserResponse {
  id: string;
  name: string;
  email: string;
  profile?: {
    avatar: string;
    bio: string;
  };
}

const userInfo = await PubSubIO.request<UserResponse>('get-user', {
  userId: 'user123',
  includeProfile: true
});

console.log(`User: ${userInfo.name} (${userInfo.email})`);

// Get task details
interface TaskRequest {
  taskId: string;
  includeComments?: boolean;
}

interface TaskResponse {
  id: string;
  title: string;
  status: string;
  assignee: string;
  comments?: Array<{ id: string; text: string; author: string }>;
}

const taskDetails = await PubSubIO.request<TaskResponse>('get-task', {
  taskId: 'task-456',
  includeComments: true
});

// Validate data
interface ValidationRequest {
  data: any;
  schema: string;
}

interface ValidationResponse {
  valid: boolean;
  errors?: string[];
}

const validation = await PubSubIO.request<ValidationResponse>('validate-data', {
  data: { name: 'John', age: 25 },
  schema: 'user-schema'
});

if (!validation.valid) {
  console.error('Validation errors:', validation.errors);
}
```

---

### `PubSubIO.reply(channel, handler): Promise<void>`

**Mục đích:** Xử lý requests từ một channel. Handler phải return response data.

#### Tham số đầu vào

| Tham số | Kiểu dữ liệu | Bắt buộc | Mô tả |
|---------|--------------|----------|-------|
| `channel` | `string` | ✅ | Tên channel để xử lý requests |
| `handler` | `(data: any) => any \| Promise<any>` | ✅ | Function xử lý request và return response |

#### Giá trị trả về

| Kiểu | Mô tả |
|------|-------|
| `Promise<void>` | Không trả về giá trị |

#### Ví dụ sử dụng

```typescript
// Handle user info requests
await PubSubIO.reply('get-user', async (request: UserRequest) => {
  const user = await getUserFromDatabase(request.userId);
  
  if (!user) {
    throw new Error(`User ${request.userId} not found`);
  }
  
  const response: UserResponse = {
    id: user.id,
    name: user.name,
    email: user.email
  };
  
  // Include profile if requested
  if (request.includeProfile) {
    response.profile = {
      avatar: user.avatar,
      bio: user.bio
    };
  }
  
  return response;
});

// Handle task details requests
await PubSubIO.reply('get-task', async (request: TaskRequest) => {
  const task = await getTaskFromDatabase(request.taskId);
  
  if (!task) {
    throw new Error(`Task ${request.taskId} not found`);
  }
  
  const response: TaskResponse = {
    id: task.id,
    title: task.title,
    status: task.status,
    assignee: task.assignee
  };
  
  // Include comments if requested
  if (request.includeComments) {
    response.comments = await getTaskComments(task.id);
  }
  
  return response;
});

// Handle data validation
await PubSubIO.reply('validate-data', async (request: ValidationRequest) => {
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

---

### `PubSubIO.unsubscribe(channel): Promise<void>`

**Mục đích:** Hủy subscription từ một channel.

#### Tham số đầu vào

| Tham số | Kiểu dữ liệu | Bắt buộc | Mô tả |
|---------|--------------|----------|-------|
| `channel` | `string` | ✅ | Tên channel để hủy subscription |

#### Giá trị trả về

| Kiểu | Mô tả |
|------|-------|
| `Promise<void>` | Không trả về giá trị |

#### Ví dụ sử dụng

```typescript
class ComponentManager {
  private subscriptions: string[] = [];
  
  async setupSubscriptions() {
    // Subscribe to multiple channels
    await PubSubIO.subscribe('task-updates', this.handleTaskUpdate.bind(this));
    this.subscriptions.push('task-updates');
    
    await PubSubIO.subscribe('user-activity', this.handleUserActivity.bind(this));
    this.subscriptions.push('user-activity');
    
    await PubSubIO.subscribe('system-alerts', this.handleSystemAlert.bind(this));
    this.subscriptions.push('system-alerts');
  }
  
  async cleanup() {
    // Unsubscribe from all channels
    for (const channel of this.subscriptions) {
      await PubSubIO.unsubscribe(channel);
      console.log(`Unsubscribed from ${channel}`);
    }
    
    this.subscriptions = [];
  }
  
  private async handleTaskUpdate(data: any) {
    console.log('Task update:', data);
  }
  
  private async handleUserActivity(data: any) {
    console.log('User activity:', data);
  }
  
  private async handleSystemAlert(data: any) {
    console.log('System alert:', data);
  }
}

// Usage
const manager = new ComponentManager();
await manager.setupSubscriptions();

// Later: cleanup when component unmounts
await manager.cleanup();
```

---

### `PubSubIO.getActiveChannels(): string[]`

**Mục đích:** Lấy danh sách các channels đang active.

#### Tham số đầu vào

| Tham số | Mô tả |
|---------|-------|
| Không có | Function này không cần tham số |

#### Giá trị trả về

| Kiểu | Mô tả |
|------|-------|
| `string[]` | Mảng tên các channels đang hoạt động |

#### Ví dụ sử dụng

```typescript
// Monitor active channels
const activeChannels = PubSubIO.getActiveChannels();
console.log('Active channels:', activeChannels);

// Health check
if (activeChannels.includes('system-health')) {
  console.log('✅ System health monitoring is active');
} else {
  console.warn('⚠️ System health monitoring is not active');
  await setupHealthMonitoring();
}

// Debug information
console.log(`Total active subscriptions: ${activeChannels.length}`);
activeChannels.forEach(channel => {
  console.log(`- ${channel}`);
});
```

---

## 📋 Message Patterns

### Publish/Subscribe Pattern

**Khi nào sử dụng:** Real-time updates, notifications, event broadcasting

| Scenario | Publisher | Subscribers | Mô tả |
|----------|-----------|-------------|-------|
| Task Updates | Task Service | UI Components, Notification Service | Cập nhật trạng thái task |
| User Activity | Auth Service | Analytics, Presence Tracker | Theo dõi hoạt động user |
| System Events | Various Services | Monitoring, Logging | Events hệ thống |

```typescript
// Publisher
await PubSubIO.publish('task-created', {
  taskId: 'task-789',
  title: 'New Feature Implementation',
  assignee: 'dev-team',
  priority: 'high'
});

// Multiple subscribers
await PubSubIO.subscribe('task-created', async (data) => {
  // Subscriber 1: Update UI
  await updateTaskBoard(data);
});

await PubSubIO.subscribe('task-created', async (data) => {
  // Subscriber 2: Send notification
  await notifyAssignee(data.assignee, data);
});

await PubSubIO.subscribe('task-created', async (data) => {
  // Subscriber 3: Log analytics
  await trackTaskCreation(data);
});
```

### Request/Response Pattern

**Khi nào sử dụng:** Data fetching, API calls, synchronous operations

| Scenario | Requester | Responder | Mô tả |
|----------|-----------|-----------|-------|
| User Info | Frontend | User Service | Lấy thông tin user |
| Data Validation | Form Component | Validation Service | Validate dữ liệu |
| File Processing | Upload Component | File Service | Xử lý file |

```typescript
// Responder
await PubSubIO.reply('process-file', async (request) => {
  const { fileId, operation } = request;
  
  switch (operation) {
    case 'resize':
      return await resizeImage(fileId, request.dimensions);
    case 'convert':
      return await convertFormat(fileId, request.format);
    case 'compress':
      return await compressFile(fileId, request.quality);
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
});

// Requester
const result = await PubSubIO.request('process-file', {
  fileId: 'file-123',
  operation: 'resize',
  dimensions: { width: 800, height: 600 }
});

console.log('File processed:', result);
```

---

## 🎯 Practical Examples

### Example 1: Real-time Chat System

```typescript
interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  username: string;
  message: string;
  timestamp: number;
}

interface UserTyping {
  roomId: string;
  userId: string;
  username: string;
  isTyping: boolean;
}

class ChatManager {
  private currentRoom: string;
  private currentUser: string;
  
  constructor(roomId: string, userId: string) {
    this.currentRoom = roomId;
    this.currentUser = userId;
  }
  
  async joinRoom() {
    // Subscribe to room messages
    await PubSubIO.subscribe(`chat-${this.currentRoom}`, async (message: ChatMessage) => {
      if (message.userId !== this.currentUser) {
        await this.displayMessage(message);
      }
    });
    
    // Subscribe to typing indicators
    await PubSubIO.subscribe(`typing-${this.currentRoom}`, async (data: UserTyping) => {
      if (data.userId !== this.currentUser) {
        await this.showTypingIndicator(data);
      }
    });
    
    // Announce join
    await PubSubIO.publish(`chat-${this.currentRoom}`, {
      id: generateId(),
      roomId: this.currentRoom,
      userId: this.currentUser,
      username: await this.getUsername(),
      message: 'joined the room',
      timestamp: Date.now()
    });
  }
  
  async sendMessage(text: string) {
    const message: ChatMessage = {
      id: generateId(),
      roomId: this.currentRoom,
      userId: this.currentUser,
      username: await this.getUsername(),
      message: text,
      timestamp: Date.now()
    };
    
    // Save to database
    await this.saveMessage(message);
    
    // Broadcast to room
    await PubSubIO.publish(`chat-${this.currentRoom}`, message);
  }
  
  async setTyping(isTyping: boolean) {
    await PubSubIO.publish(`typing-${this.currentRoom}`, {
      roomId: this.currentRoom,
      userId: this.currentUser,
      username: await this.getUsername(),
      isTyping
    });
  }
  
  private async displayMessage(message: ChatMessage) {
    console.log(`[${new Date(message.timestamp).toLocaleTimeString()}] ${message.username}: ${message.message}`);
  }
  
  private async showTypingIndicator(data: UserTyping) {
    if (data.isTyping) {
      console.log(`${data.username} is typing...`);
    }
  }
  
  private async getUsername(): Promise<string> {
    // Get username from context or database
    return 'User';
  }
  
  private async saveMessage(message: ChatMessage) {
    // Save to database
  }
}
```

### Example 2: Microservice Communication

```typescript
// User Service
class UserService {
  async start() {
    // Handle user info requests
    await PubSubIO.reply('user.get', async (request) => {
      const { userId, includeProfile } = request;
      const user = await this.getUserById(userId);
      
      if (!user) {
        throw new Error(`User ${userId} not found`);
      }
      
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        profile: includeProfile ? user.profile : undefined
      };
    });
    
    // Handle user updates
    await PubSubIO.reply('user.update', async (request) => {
      const { userId, updates } = request;
      const updatedUser = await this.updateUser(userId, updates);
      
      // Notify other services
      await PubSubIO.publish('user.updated', {
        userId: updatedUser.id,
        changes: updates,
        timestamp: Date.now()
      });
      
      return updatedUser;
    });
  }
  
  private async getUserById(userId: string) {
    // Database query
    return null;
  }
  
  private async updateUser(userId: string, updates: any) {
    // Update database
    return null;
  }
}

// Notification Service
class NotificationService {
  async start() {
    // Listen for user updates
    await PubSubIO.subscribe('user.updated', async (data) => {
      console.log(`User ${data.userId} updated:`, data.changes);
      
      // Send notification if email changed
      if (data.changes.email) {
        await this.sendEmailChangeNotification(data.userId, data.changes.email);
      }
    });
    
    // Handle notification requests
    await PubSubIO.reply('notification.send', async (request) => {
      const { userId, type, message, data } = request;
      
      switch (type) {
        case 'email':
          return await this.sendEmail(userId, message, data);
        case 'push':
          return await this.sendPushNotification(userId, message, data);
        case 'sms':
          return await this.sendSMS(userId, message);
        default:
          throw new Error(`Unknown notification type: ${type}`);
      }
    });
  }
  
  private async sendEmailChangeNotification(userId: string, newEmail: string) {
    // Send notification
  }
  
  private async sendEmail(userId: string, message: string, data: any) {
    // Send email
    return { sent: true, messageId: 'email-123' };
  }
  
  private async sendPushNotification(userId: string, message: string, data: any) {
    // Send push notification
    return { sent: true, messageId: 'push-456' };
  }
  
  private async sendSMS(userId: string, message: string) {
    // Send SMS
    return { sent: true, messageId: 'sms-789' };
  }
}

// Client usage
class ClientApp {
  async getUserInfo(userId: string) {
    return await PubSubIO.request('user.get', {
      userId,
      includeProfile: true
    });
  }
  
  async updateUser(userId: string, updates: any) {
    return await PubSubIO.request('user.update', {
      userId,
      updates
    });
  }
  
  async sendNotification(userId: string, type: string, message: string) {
    return await PubSubIO.request('notification.send', {
      userId,
      type,
      message
    });
  }
}
```

---

## 🔍 Monitoring & Debugging

### Kiểm tra Connection Status

```typescript
// Kiểm tra thông tin connections
const connectionInfo = PubSubIO.getConnectionInfo();
console.log('Connection Info:', connectionInfo);
// Output:
// {
//   localRedis: "redis://localhost:6379",
//   backendRedis: "Remote server",
//   useRemoteBackend: true
// }

// Kiểm tra số lượng request đang pending
const activeCount = PubSubIO.getActiveRequestsCount();
console.log(`Active requests: ${activeCount}`);

// Cleanup và log status
PubSubIO.cleanup();
// Output:
// [PubSubIO] Active requests: 2
// [PubSubIO] Local Redis: redis://localhost:6379
// [PubSubIO] Backend Redis: Remote server
```

### Docker Compose Setup

**docker-compose.yml** cho plugin development:

```yaml
version: '3.8'
services:
  redis-local:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes
    
  plugin-dev:
    build: .
    environment:
      # Auto-detection environment
      NODE_ENV: development
      
      # Local Redis (cho RedisIO storage)
      REDIS_URL: redis://redis-local:6379
      
      # Backend Redis (cho PubSubIO communication)  
      BACKEND_REDIS_HOST: api.leanez.app
      BACKEND_REDIS_PORT: 6379
      BACKEND_REDIS_PASSWORD: ${LEANEZ_REDIS_PASSWORD}
      
      # LeanEZ Backend (auto-detected based on NODE_ENV)
      # Development: http://localhost:3000 (auto)
      # Production: https://api.leanez.app (auto)
    depends_on:
      - redis-local

volumes:
  redis_data:
```

**Plugin service sẽ tự động:**
- Detect environment và connect đúng Redis instances
- Setup LeanEZ Backend URL based on NODE_ENV  
- Initialize tất cả services khi container starts

### Connection Testing

```typescript
async function testConnections() {
  try {
    // Test local Redis (storage) - No init needed, already auto-initialized
    await RedisIO.update('test:connection', { timestamp: Date.now() });
    const testData = await RedisIO.get('test:connection');
    console.log('✅ Local Redis OK:', testData);
    
    // Test backend Redis (communication) - No init needed, already auto-initialized
    await PubSubIO.publish('test:ping', { message: 'ping' });
    console.log('✅ Backend Redis publish OK');
    
    // Test request-response with timeout
    try {
      const response = await PubSubIO.request('test:echo', 
        { message: 'hello' }, 
        { timeout: 5000 }
      );
      console.log('✅ Backend Redis request-response OK:', response);
    } catch (error) {
      console.log('⚠️  Backend Redis request failed (expected if no handler)');
    }
    
  } catch (error) {
    console.error('❌ Connection test failed:', error);
  }
}

// Run connection test
await testConnections();
```

### Common Issues & Solutions

#### **❌ Backend Redis Connection Failed**
```
[SDK] ❌ Auto-initialization failed: Backend Redis connection failed
```

**Nguyên nhân:**
- Backend Redis server không accessible
- Wrong host/port/password configuration
- Network/firewall issues

**Giải pháp:**
```typescript
// Check environment variables được SDK auto-detect
console.log('Environment check:');
console.log('  NODE_ENV:', process.env.NODE_ENV);
console.log('  BACKEND_REDIS_HOST:', process.env.BACKEND_REDIS_HOST);
console.log('  BACKEND_REDIS_PORT:', process.env.BACKEND_REDIS_PORT);
console.log('  BACKEND_REDIS_PASSWORD:', process.env.BACKEND_REDIS_PASSWORD ? '[SET]' : '[NOT SET]');

// Test manual connection to verify config
import { createClient } from 'redis';
const testClient = createClient({
  socket: {
    host: process.env.BACKEND_REDIS_HOST || 'api.leanez.app',
    port: parseInt(process.env.BACKEND_REDIS_PORT || '6379')
  },
  password: process.env.BACKEND_REDIS_PASSWORD
});

await testClient.connect();
console.log('✅ Manual backend Redis connection OK');
await testClient.quit();
```

#### **❌ SDK Auto-Initialization Failed**
```
[SDK] ❌ Auto-initialization failed: Check your environment variables
```

**Nguyên nhân:**
- Environment variables không đúng format
- Redis services chưa ready
- Configuration conflicts

**Giải pháp:**
```typescript
// Check và set đúng environment variables
console.log('Environment check:');
console.log('  REDIS_URL:', process.env.REDIS_URL);
console.log('  BACKEND_REDIS_HOST:', process.env.BACKEND_REDIS_HOST);
console.log('  BACKEND_REDIS_PORT:', process.env.BACKEND_REDIS_PORT);

// Set missing environment variables
if (!process.env.REDIS_URL) {
  process.env.REDIS_URL = 'redis://localhost:6379';
}

if (!process.env.BACKEND_REDIS_HOST) {
  process.env.BACKEND_REDIS_HOST = 'api.leanez.app';
  process.env.BACKEND_REDIS_PORT = '6379';
}

// Import SDK sau khi setup environment
import { PubSubIO, RedisIO } from '@leanez/sdk';
await PubSubIO.publish('test', 'Hello World');
```

#### **❌ Environment Variables Not Loaded**
```