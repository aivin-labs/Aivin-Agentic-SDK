# 🗄️ RedisIO - Redis Connection Manager

**RedisIO** là Redis connection manager giúp cung cấp truy cập đến Redis với các helper methods tiện ích cho LeanEZ plugins.

**Lưu ý**: RedisIO chỉ khả dụng nếu bạn đã chọn **Redis Cache** stack khi tạo plugin.

## 🚀 Tính năng chính

| Tính năng | Mô tả |
|-----------|-------|
| **Helper Methods** | Các methods tiện ích cho Redis operations |
| **Data Sanitization** | Tự động làm sạch dữ liệu trước khi lưu |
| **JSON Support** | Tự động serialization/deserialization |
| **Pub/Sub Messaging** | Real-time communication giữa các components |
| **TypeScript Support** | Full type safety và intellisense |

## 🏃 Quick Start

```typescript
// Import SDK - Auto-connect Redis
import { RedisIO } from '@leanez/sdk';

// Lưu và lấy user profile
const userId = '12345';
await RedisIO.update(`user:${userId}:profile`, {
  name: 'John Doe',
  email: 'john@example.com',
  preferences: {
    theme: 'dark',
    notifications: true
  }
});

const profile = await RedisIO.get(`user:${userId}:profile`);
console.log('User profile:', profile);
```

### Pub/Sub messaging
```javascript
// Subscribe tới channel
await RedisIO.subscribe('notifications', (message) => {
  console.log('Received:', message);
});

// Publish message
await RedisIO.publish('notifications', JSON.stringify({
  type: 'user_login',
  userId: 123
}));
```

## 📖 API Reference

### Connection Management

#### `RedisIO.getConfig()`
Lấy cấu hình hiện tại

##### Return Value
| Type | Description |
|------|-------------|
| `RedisClientOptions` | Cấu hình Redis hiện tại |

##### Example
```javascript
const config = RedisIO.getConfig();
console.log(config);
```

---

#### `RedisIO.getClient()`
Lấy Redis client để thực hiện advanced operations

##### Return Value
| Type | Description |
|------|-------------|
| `RedisClientType` | Native Redis client instance |

##### Example
```javascript
const client = RedisIO.getClient();

// Hash operations
await client.hSet('user:123', 'name', 'John Doe');
const name = await client.hGet('user:123', 'name');
```

---

### Basic Operations

#### `RedisIO.has(key)`
Kiểm tra key có tồn tại không

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `string` | ✅ | - | Redis key cần kiểm tra |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<number>` | 1 nếu key tồn tại, 0 nếu không |

##### Example
```javascript
const exists = await RedisIO.has('user:123');
console.log(exists); // 1 hoặc 0
```

---

#### `RedisIO.get(key, initData?)`
Lấy data từ Redis với hỗ trợ initData

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `string` | ✅ | - | Redis key cần lấy |
| `initData` | `T` | ❌ | `undefined` | Dữ liệu khởi tạo nếu key không tồn tại |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<T \| null>` | Giá trị được deserialize, `initData` nếu key không tồn tại |

##### Example
```javascript
// Lấy data thông thường
const userData = await RedisIO.get('user:123');

// Lấy data với fallback
const config = await RedisIO.get('app:config', { theme: 'dark', lang: 'en' });
```

---

#### `RedisIO.update(key, data, opts?)`
Cập nhật dữ liệu vào Redis với data sanitization

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `string` | ✅ | - | Redis key để lưu trữ |
| `data` | `any` | ✅ | - | Dữ liệu cần lưu (tự động sanitize và serialize) |
| `opts` | `SetOptions` | ❌ | `undefined` | Redis SET options (EX, PX, NX, XX, etc.) |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<string \| null>` | 'OK' nếu thành công |

##### Example
```javascript
// Lưu object với auto-sanitization
await RedisIO.update('user:123', {
  name: 'John',
  email: 'john@example.com',
  emptyField: '', // Sẽ bị loại bỏ
  nullField: null // Sẽ bị loại bỏ
});

// Lưu với TTL
await RedisIO.update('temp:data', { value: 'temp' }, { EX: 3600 });
```

---

#### `RedisIO.delete(key)`
Xóa key khỏi Redis

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `string` | ✅ | - | Redis key cần xóa |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<number>` | Số key được xóa (0 hoặc 1) |

##### Example
```javascript
const deleted = await RedisIO.delete('user:123');
console.log(deleted); // 1 nếu key được xóa, 0 nếu key không tồn tại
```

---

### Pub/Sub Operations

#### `RedisIO.publish(channel, message)`
Publish message tới channel

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channel` | `string` | ✅ | - | Tên channel |
| `message` | `string` | ✅ | - | Message cần gửi (cần serialize trước) |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<number>` | Số subscribers nhận được message |

##### Example
```javascript
const subscriberCount = await RedisIO.publish('notifications', JSON.stringify({
  type: 'user_login',
  userId: 123,
  timestamp: Date.now()
}));
console.log(`Message sent to ${subscriberCount} subscribers`);
```

---

#### `RedisIO.subscribe(channel, callback)`
Subscribe tới channel

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channel` | `string` | ✅ | - | Tên channel |
| `callback` | `(message: string) => void` | ✅ | - | Function xử lý message nhận được |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<void>` | Promise hoàn thành khi subscribe thành công |

##### Example
```javascript
await RedisIO.subscribe('notifications', (message) => {
  const data = JSON.parse(message);
  console.log('Received:', data);
  // Xử lý notification
});
```

---

#### `RedisIO.unsubscribe(channel)`
Unsubscribe khỏi channel

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channel` | `string` | ✅ | - | Tên channel cần unsubscribe |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<void>` | Promise hoàn thành khi unsubscribe thành công |

##### Example
```javascript
await RedisIO.unsubscribe('notifications');
console.log('Unsubscribed from notifications channel');
```

---

## 💡 Ví dụ thực tế

### User Session Manager
```javascript
import { RedisIO } from '@leanez/sdk';

// Tạo session
async function createUserSession(userId, sessionData) {
  const sessionId = `session:${userId}:${Date.now()}`;
  
  // Lưu session với TTL 24h
  await RedisIO.update(sessionId, {
    userId,
    loginTime: new Date(),
    ipAddress: sessionData.ip,
    userAgent: sessionData.userAgent
  }, { EX: 86400 });
  
  return sessionId;
}

// Lấy session
async function getUserSession(sessionId) {
  const session = await RedisIO.get(sessionId);
  return session;
}

// Xóa session
async function deleteUserSession(sessionId) {
  await RedisIO.delete(sessionId);
}
```

### Caching System với Data Sanitization
```javascript
import { RedisIO } from '@leanez/sdk';

async function getCachedUserProfile(userId) {
  const cacheKey = `user:profile:${userId}`;
  
  // Thử lấy từ cache trước
  let profile = await RedisIO.get(cacheKey);
  
  if (!profile) {
    // Cache miss - fetch từ database
    console.log('Cache miss, fetching from DB...');
    profile = await fetchUserFromDatabase(userId);
    
    // Lưu vào cache với auto-sanitization
    // Các field null/empty sẽ tự động bị loại bỏ
    await RedisIO.update(cacheKey, profile, { EX: 1800 }); // 30 minutes
  } else {
    console.log('Cache hit!');
  }
  
  return profile;
}
```

### Real-time Notification System
```javascript
import { RedisIO } from '@leanez/sdk';

// Notification sender
export async function sendNotification(userId, notification) {
  const channel = `user:${userId}:notifications`;
  
  // Store notification history
  const notificationId = `notification:${Date.now()}`;
  await RedisIO.update(notificationId, {
    userId,
    type: notification.type,
    title: notification.title,
    content: notification.content,
    timestamp: new Date(),
    read: false
  }, { EX: 7 * 24 * 3600 }); // 7 days
  
  // Broadcast to subscribers
  const message = JSON.stringify({
    id: notificationId,
    ...notification
  });
  
  const subscriberCount = await RedisIO.publish(channel, message);
  console.log(`Notification sent to ${subscriberCount} subscribers`);
}

// Notification listener
export async function listenForNotifications(userId, callback) {
  const channel = `user:${userId}:notifications`;
  
  await RedisIO.subscribe(channel, (message) => {
    try {
      const notification = JSON.parse(message);
      callback(notification);
    } catch (error) {
      console.error('Failed to parse notification:', error);
    }
  });
}
```

## 🔧 Advanced Redis Operations

### Hash Operations
```javascript
const client = RedisIO.getClient();

// Store user profile as hash
await client.hSet('user:123', {
  name: 'John Doe',
  email: 'john@example.com',
  age: 30,
  city: 'Hanoi'
});

// Get specific field
const userName = await client.hGet('user:123', 'name');
console.log(userName); // 'John Doe'

// Get all fields
const userProfile = await client.hGetAll('user:123');
console.log(userProfile);
// { name: 'John Doe', email: 'john@example.com', age: '30', city: 'Hanoi' }

// Increment numeric field
await client.hIncrBy('user:123', 'login_count', 1);
```

### List Operations (Task Queue)
```javascript
const client = RedisIO.getClient();

// Task queue với lists
await client.lPush('tasks:pending', 'task1', 'task2', 'task3');

// Process tasks (FIFO)
const task = await client.rPop('tasks:pending');
console.log(task); // 'task1'

// Get queue length
const queueLength = await client.lLen('tasks:pending');

// Blocking pop (wait for new items)
const newTask = await client.brPop('tasks:pending', 30); // 30 seconds timeout
```

### Set Operations (Tags/Categories)
```javascript
const client = RedisIO.getClient();

// User tags/interests
await client.sAdd('user:123:interests', 'nodejs', 'react', 'vue', 'docker');

// Check membership
const hasReact = await client.sIsMember('user:123:interests', 'react');
console.log(hasReact); // true

// Get all interests
const interests = await client.sMembers('user:123:interests');
console.log(interests); // ['nodejs', 'react', 'vue', 'docker']

// Common interests between users
await client.sAdd('user:456:interests', 'nodejs', 'python', 'docker');
const common = await client.sInter('user:123:interests', 'user:456:interests');
console.log(common); // ['nodejs', 'docker']
```

### Sorted Sets (Leaderboards)
```javascript
const client = RedisIO.getClient();

// Gaming leaderboard
await client.zAdd('leaderboard:game1', [
  { score: 1000, value: 'player1' },
  { score: 1500, value: 'player2' },
  { score: 800, value: 'player3' },
  { score: 2000, value: 'player4' }
]);

// Get top players
const topPlayers = await client.zRevRange('leaderboard:game1', 0, 2, {
  WITHSCORES: true 
});
console.log(topPlayers);
// [{ value: 'player4', score: 2000 }, { value: 'player2', score: 1500 }, ...]

// Get player rank
const rank = await client.zRevRank('leaderboard:game1', 'player1');
console.log(`Player1 rank: ${rank + 1}`); // Redis ranks are 0-based
```

## 🎯 Best Practices

| Practice | Description | Example |
|----------|-------------|---------|
| **Key Naming** | Sử dụng consistent naming convention | `user:123:profile`, `session:abc:data` |
| **Data Sanitization** | Để RedisIO tự động làm sạch data | `await RedisIO.update(key, dirtyData)` |
| **TTL Management** | Luôn set TTL cho temporary data | `RedisIO.update(key, data, { EX: 3600 })` |
| **Error Handling** | Wrap Redis operations trong try-catch | `try { await RedisIO.get(key) } catch(e) {}` |
| **Connection Reuse** | Sử dụng getClient() cho advanced ops | `const client = RedisIO.getClient()` |

### Data Sanitization Features
```javascript
// ✅ RedisIO tự động làm sạch data
const dirtyData = {
  name: 'John',
  email: 'john@example.com',
  emptyString: '',        // Sẽ bị loại bỏ
  nullValue: null,        // Sẽ bị loại bỏ
  undefinedValue: undefined, // Sẽ bị loại bỏ
  emptyObject: {},        // Sẽ bị loại bỏ
  emptyArray: [],         // Sẽ bị loại bỏ
  validArray: [1, 2, 3],  // Được giữ lại
  nestedObject: {
    valid: 'data',
    empty: ''             // Sẽ bị loại bỏ trong nested object
  }
};

await RedisIO.update('user:123', dirtyData);
// Chỉ lưu: { name: 'John', email: 'john@example.com', validArray: [1,2,3], nestedObject: { valid: 'data' } }
```

### Performance Optimization
```javascript
// ✅ Good: Batch operations với native client
const client = RedisIO.getClient();
const pipeline = client.multi();
pipeline.set('key1', 'value1');
pipeline.set('key2', 'value2');
pipeline.incr('counter');
await pipeline.exec();

// ✅ Good: Sử dụng appropriate data structures
// Thay vì multiple keys cho user profile
await RedisIO.update('user:123:name', 'John');
await RedisIO.update('user:123:email', 'john@example.com');

// Sử dụng hash operations
await client.hSet('user:123', {
  name: 'John',
  email: 'john@example.com'
});
```

## 🌍 Environment Variables

Khi chọn Redis Cache stack, các biến môi trường sau sẽ được tự động cấu hình:

| Variable | Description | Example |
|----------|-------------|---------|
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `REDIS_HOST` | Redis host | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `REDIS_PASSWORD` | Redis password (nếu có) | `your_redis_password` |
| `REDIS_DB` | Redis database number | `0` |
| `REDIS_USER` | Redis username (nếu có) | `your_redis_user` |

### `RedisIO.set(key, value, ttl?): Promise<void>`

Lưu data vào Redis với optional TTL.

**Tham số:**
- `key` (string): Redis key
- `value` (any): Giá trị cần lưu
- `ttl` (number, optional): Time to live in seconds

```typescript
// Lưu user data vĩnh viễn
await RedisIO.set('user:123', { name: 'John', email: 'john@example.com' });

// Lưu session với TTL 1 giờ
await RedisIO.set('session:abc', { userId: 123, token: 'xyz' }, 3600);
```

### Example: Cache management cho e-commerce
```typescript
import { RedisIO } from '@leanez/sdk';

class ProductCache {
  private static CACHE_TTL = 3600; // 1 hour

  static async getProduct(productId: string) {
    const cacheKey = `product:${productId}`;
    
    // Check cache trước
    const cached = await RedisIO.get(cacheKey);
    if (cached) {
      console.log('✅ Cache hit');
      return cached;
    }
    
    // Fetch từ database
    console.log('💾 Cache miss - fetching from DB');
    const product = await this.fetchFromDatabase(productId);
    
    // Cache kết quả với TTL
    await RedisIO.set(cacheKey, product, this.CACHE_TTL);
    
    return product;
  }
  
  static async invalidateProduct(productId: string) {
    await RedisIO.delete(`product:${productId}`);
  }
  
  static async updateProduct(productId: string, updates: any) {
    // Update database
    await this.updateInDatabase(productId, updates);
    
    // Update cache
    const cacheKey = `product:${productId}`;
    const current = await RedisIO.get(cacheKey);
    if (current) {
      await RedisIO.update(cacheKey, { ...current, ...updates });
    }
  }
  
  private static async fetchFromDatabase(productId: string) {
    // Simulate DB query
    return {
      id: productId,
      name: 'Sample Product',
      price: 99.99,
      stock: 10
    };
  }
  
  private static async updateInDatabase(productId: string, updates: any) {
    // Update in database
  }
}
``` 