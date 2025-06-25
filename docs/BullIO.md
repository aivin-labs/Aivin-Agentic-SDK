# ⚡ BullIO - Queue Management & Background Processing

BullIO cung cấp hệ thống queue mạnh mẽ để xử lý background jobs và heavy processing trong Plugins, hỗ trợ multi-server.

## 📖 Quick Start

```typescript
import { BullIO } from '@leanez/sdk';

// Tạo background jobs và xử lý bất đồng bộ dưới nền (có thể trên nhiều server theo cơ chế message queue)
const result = await BullIO.emit({
  name: 'email-sender',
  data: { to: 'user@example.com', subject: 'Welcome!' },
  handler: async (data) => {
    await sendEmail(data.to, data.subject);
    return { sent: true, timestamp: Date.now() };
  }
});

console.log(result); // { sent: true, timestamp: 1234567890 }
```

---

## 🔧 API Reference

### `BullIO.emit<T, R>(params): Promise<R>`

**Mục đích:** Tạo queue và đăng ký tự động handler có thể tái sử dụng.

#### Tham số đầu vào (EmitParams)

| Tham số | Kiểu dữ liệu | Bắt buộc | Mặc định | Mô tả |
|---------|--------------|----------|----------|-------|
| `name` | `string` | ✅ | - | Tên queue duy nhất |
| `data` | `T` | ❌ | `undefined` | Dữ liệu đầu vào cho handler |
| `handler` | `JobHandler<T>` | ✅ | - | Function xử lý job |
| `threadId` | `string` | ❌ | `undefined` | ID để quản lý jobs theo nhóm |
| `temp` | `boolean` | ❌ | `false` | Queue tạm thời (tự xóa sau khi xong) |
| `concurrency` | `number` | ❌ | `1` | Số jobs chạy đồng thời |
| `jobOpts` | `JobOptions` | ❌ | `{}` | Tùy chọn job (retry, timeout, etc.) |
| `queueOpts` | `QueueOptions` | ❌ | `{}` | Tùy chọn queue |

#### Kiểu dữ liệu handler

```typescript
type JobHandler<T> = (jobData: T, job?: Bull.Job<T>) => any | Promise<any>
```

| Tham số | Kiểu | Mô tả |
|---------|------|-------|
| `jobData` | `T` | Dữ liệu được truyền từ `data` parameter |
| `job` | `Bull.Job<T>?` | Bull job object (có thể dùng để update progress) |

#### Giá trị trả về

| Kiểu | Mô tả |
|------|-------|
| `Promise<R>` | Kết quả từ handler function |

#### Ví dụ sử dụng

**Ví dụ: Email processing**
```typescript
interface EmailData {
  to: string;
  subject: string;
  body: string;
}

interface EmailResult {
  success: boolean;
  messageId: string;
  sentAt: string;
}

const emailResult = await BullIO.emit<EmailData, EmailResult>({
  name: 'email-processor',
  data: { 
    to: 'john@example.com', 
    subject: 'Order Confirmation',
    body: 'Your order #123 has been confirmed'
  },
  handler: async (emailData) => {
    const sent = await sendEmail(emailData);
    return { 
      success: true, 
      messageId: sent.messageId,
      sentAt: new Date().toISOString()
    };
  }
});
```
---

### `BullIO.submit<T>(params): Promise<Bull.Job<T>>`

**Mục đích:** Gửi job vào queue đã tồn tại (phải tạo queue bằng `newInstance` trước).

#### Tham số đầu vào (SubmitParams)

| Tham số | Kiểu dữ liệu | Bắt buộc | Mặc định | Mô tả |
|---------|--------------|----------|----------|-------|
| `name` | `string` | ✅ | - | Tên queue đã tồn tại |
| `data` | `T` | ✅ | - | Dữ liệu job |
| `options` | `JobOptions` | ❌ | `{}` | Tùy chọn job |

#### Giá trị trả về

| Kiểu | Mô tả |
|------|-------|
| `Promise<Bull.Job<T>>` | Bull job object với ID và metadata |

#### Ví dụ sử dụng

```typescript
// 1. Tạo queue trước
await BullIO.newInstance({
  name: 'image-resizer',
  handler: (job) => {
    const { imageUrl, width, height } = job.data;
    return resizeImage(imageUrl, width, height);
  },
  concurrency: 3
});

// 2. Submit job vào queue
interface ImageResizeData {
  imageUrl: string;
  width: number;
  height: number;
}

const job = await BullIO.submit<ImageResizeData>({
  name: 'image-resizer',
  data: {
    imageUrl: 'https://example.com/image.jpg',
    width: 800,
    height: 600
  },
  options: {
    priority: 1,
    attempts: 3,
    delay: 5000 // Delay 5 seconds
  }
});

console.log(`Job submitted with ID: ${job.id}`);

// 3. Lắng nghe job completion
job.finished().then(result => {
  console.log('Resize completed:', result);
});
```

---

### `BullIO.newInstance<T>(params): Promise<Bull.Queue<T>>`

**Mục đích:** Tạo queue processor để xử lý jobs liên tục. Queue sẽ chạy background và xử lý jobs khi có.

#### Tham số đầu vào (NewInstanceParams)

| Tham số | Kiểu dữ liệu | Bắt buộc | Mặc định | Mô tả |
|---------|--------------|----------|----------|-------|
| `name` | `string` | ✅ | - | Tên queue duy nhất |
| `handler` | `(job: Bull.Job<T>) => any` | ✅ | - | Handler xử lý job |
| `concurrency` | `number` | ❌ | `1` | Số jobs chạy đồng thời |
| `queueOpts` | `QueueOptions` | ❌ | `{}` | Tùy chọn queue |

#### Giá trị trả về

| Kiểu | Mô tả |
|------|-------|
| `Promise<Bull.Queue<T>>` | Bull Queue instance |

#### Ví dụ sử dụng

```typescript
interface VideoProcessData {
  videoUrl: string;
  format: 'mp4' | 'webm' | 'avi';
  quality: 'low' | 'medium' | 'high';
}

const videoQueue = await BullIO.newInstance<VideoProcessData>({
  name: 'video-processor',
  handler: async (job) => {
    const { videoUrl, format, quality } = job.data;
    
    // Update progress
    await job.progress(10);
    const localPath = await downloadVideo(videoUrl);
    
    await job.progress(50);
    const processed = await convertVideo(localPath, format, quality);
    
    await job.progress(90);
    const uploadedUrl = await uploadVideo(processed.path);
    
    await job.progress(100);
    return {
      processedUrl: uploadedUrl,
      duration: processed.duration,
      fileSize: processed.size
    };
  },
  concurrency: 2,
  queueOpts: {
    defaultJobOptions: {
      removeOnComplete: 5,
      removeOnFail: 10,
      attempts: 3
    }
  }
});
```

---

### `BullIO.listen<T>(params): Promise<Bull.Queue<T>>`

**Mục đích:** Tạo queue và lắng nghe jobs (tương tự `newInstance` nhưng đơn giản hơn).

#### Tham số đầu vào (ListenParams)

| Tham số | Kiểu dữ liệu | Bắt buộc | Mặc định | Mô tả |
|---------|--------------|----------|----------|-------|
| `name` | `string` | ✅ | - | Tên queue |
| `handler` | `JobHandler<T>` | ✅ | - | Handler xử lý |
| `concurrency` | `number` | ❌ | `1` | Số jobs chạy đồng thời |

#### Giá trị trả về

| Kiểu | Mô tả |
|------|-------|
| `Promise<Bull.Queue<T>>` | Bull Queue instance |

#### Ví dụ sử dụng

```typescript
interface LogData {
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
  userId?: string;
}

const logQueue = await BullIO.listen<LogData>({
  name: 'log-processor',
  handler: async (logData, job) => {
    // Save to database
    await saveLogToDatabase(logData);
    
    // Send to external logging service
    if (logData.level === 'error') {
      await sendToErrorTracking(logData);
    }
    
    if (job) await job.progress(100);
    
    return { saved: true, logId: generateLogId() };
  },
  concurrency: 5
});
```

---

### `BullIO.cancelRunningJobs(threadId): Promise<void>`

**Mục đích:** Hủy tất cả jobs đang chạy trong một thread cụ thể.

#### Tham số đầu vào

| Tham số | Kiểu dữ liệu | Bắt buộc | Mô tả |
|---------|--------------|----------|-------|
| `threadId` | `string` | ✅ | ID của thread cần hủy jobs |

#### Giá trị trả về

| Kiểu | Mô tả |
|------|-------|
| `Promise<void>` | Không trả về giá trị |

#### Ví dụ sử dụng

```typescript
class UserSessionManager {
  private userId: string;
  
  constructor(userId: string) {
    this.userId = userId;
  }
  
  async startTask(taskData: any) {
    return await BullIO.emit({
      name: 'user-task',
      threadId: this.userId,
      data: taskData,
      handler: async (data) => {
        await processUserTask(data);
        return { completed: true };
      }
    });
  }
  
  async logout() {
    // Cancel all running jobs for this user
    await BullIO.cancelRunningJobs(this.userId);
    console.log(`All jobs cancelled for user: ${this.userId}`);
  }
}
```

---

### `BullIO.getRunningJobs(threadId?): Promise<Bull.Job[]>`

**Mục đích:** Lấy danh sách jobs đang chạy. Có thể lọc theo threadId hoặc lấy tất cả.

#### Tham số đầu vào

| Tham số | Kiểu dữ liệu | Bắt buộc | Mặc định | Mô tả |
|---------|--------------|----------|----------|-------|
| `threadId` | `string` | ❌ | `undefined` | ID thread để lọc (nếu không có sẽ lấy tất cả) |

#### Giá trị trả về

| Kiểu | Mô tả |
|------|-------|
| `Promise<Bull.Job[]>` | Mảng các Bull Job objects đang chạy |

#### Ví dụ sử dụng

```typescript
// Lấy tất cả jobs đang chạy
const allJobs = await BullIO.getRunningJobs();
console.log(`Total running jobs: ${allJobs.length}`);

// Lấy jobs của user cụ thể
const userJobs = await BullIO.getRunningJobs('user-789');
console.log(`User has ${userJobs.length} running jobs`);

// Monitor và cancel jobs có progress thấp
for (const job of userJobs) {
  const progress = await job.progress();
  if (progress < 10) {
    await job.remove();
    console.log(`Cancelled job ${job.id} (low progress)`);
  }
}
```

---

### `BullIO.fastEmit(params): Promise<void>`

**Mục đích:** Gửi message nhanh qua Redis pub/sub (không persistence, không queue).

#### Tham số đầu vào (FastEmitParams)

| Tham số | Kiểu dữ liệu | Bắt buộc | Mô tả |
|---------|--------------|----------|-------|
| `channel` | `string` | ✅ | Tên channel |
| `data` | `any` | ✅ | Dữ liệu gửi |

#### Giá trị trả về

| Kiểu | Mô tả |
|------|-------|
| `Promise<void>` | Không trả về giá trị |

#### Ví dụ sử dụng

```typescript
// Real-time notifications
await BullIO.fastEmit({
  channel: 'user-notifications',
    data: {
    userId: 'user123',
    type: 'order_status',
    message: 'Your order #456 has been shipped',
    timestamp: Date.now(),
    metadata: {
      orderId: 456,
      trackingNumber: 'TN123456789'
    }
  }
});

// System events
await BullIO.fastEmit({
  channel: 'system-events',
  data: {
    event: 'user_login',
    userId: 'user789',
    ip: '192.168.1.100',
    timestamp: Date.now()
  }
});
```

---

### `BullIO.fastListen(channel, handler): Promise<void>`

**Mục đích:** Lắng nghe message nhanh từ Redis pub/sub channel.

#### Tham số đầu vào

| Tham số | Kiểu dữ liệu | Bắt buộc | Mô tả |
|---------|--------------|----------|-------|
| `channel` | `string` | ✅ | Tên channel cần lắng nghe |
| `handler` | `(data: any) => void \| Promise<void>` | ✅ | Function xử lý message |

#### Giá trị trả về

| Kiểu | Mô tả |
|------|-------|
| `Promise<void>` | Không trả về giá trị |

#### Ví dụ sử dụng

```typescript
interface NotificationMessage {
  userId: string;
  type: string;
  message: string;
  timestamp: number;
  metadata?: any;
}

// Listen for user notifications
await BullIO.fastListen('user-notifications', async (data: NotificationMessage) => {
  console.log(`New notification for user ${data.userId}:`, data.message);
  
  // Send to user's WebSocket
  const userSocket = getUserSocket(data.userId);
  if (userSocket?.connected) {
    userSocket.emit('notification', {
      type: data.type,
      message: data.message,
      timestamp: data.timestamp
    });
  }
  
  // Save for offline users
  if (!userSocket?.connected) {
    await saveNotificationForLater(data.userId, data);
  }
});
```

---

### `BullIO.getQueues(): Bull.Queue[]`

**Mục đích:** Lấy danh sách tất cả queues đang hoạt động.

#### Tham số đầu vào

| Tham số | Mô tả |
|---------|-------|
| Không có | Function này không cần tham số |

#### Giá trị trả về

| Kiểu | Mô tả |
|------|-------|
| `Bull.Queue[]` | Mảng các Bull Queue instances |

#### Ví dụ sử dụng

```typescript
// Monitor all queues
  const queues = BullIO.getQueues();
console.log(`Active queues: ${queues.length}`);
  
  for (const queue of queues) {
    const waiting = await queue.getWaiting();
    const active = await queue.getActive();
    const failed = await queue.getFailed();
    
  console.log(`Queue: ${queue.name}`);
  console.log(`  - Waiting: ${waiting.length}`);
  console.log(`  - Active: ${active.length}`);
  console.log(`  - Failed: ${failed.length}`);
    
    // Alert if too many failed jobs
    if (failed.length > 10) {
    console.warn(`⚠️ Queue ${queue.name} has ${failed.length} failed jobs!`);
  }
}
```

---

## 📋 Type Definitions

### JobOptions

| Thuộc tính | Kiểu | Mặc định | Mô tả |
|------------|------|----------|-------|
| `attempts` | `number` | `2` | Số lần thử lại khi job thất bại |
| `backoff` | `BackoffOptions` | `undefined` | Chiến lược retry (fixed/exponential) |
| `timeout` | `number` | `undefined` | Timeout cho job (milliseconds) |
| `priority` | `number` | `0` | Độ ưu tiên (1-10, cao hơn = ưu tiên hơn) |
| `delay` | `number` | `0` | Delay trước khi chạy job (milliseconds) |
| `repeat` | `RepeatOptions` | `undefined` | Lặp lại job theo lịch |
| `removeOnComplete` | `number` | `undefined` | Giữ bao nhiêu jobs hoàn thành |
| `removeOnFail` | `number` | `undefined` | Giữ bao nhiêu jobs thất bại |
| `jobId` | `string` | `undefined` | Custom job ID |

### BackoffOptions

| Thuộc tính | Kiểu | Mô tả |
|------------|------|-------|
| `type` | `'fixed' \| 'exponential'` | Loại backoff strategy |
| `delay` | `number` | Base delay (milliseconds) |

### RepeatOptions

| Thuộc tính | Kiểu | Mô tả |
|------------|------|-------|
| `cron` | `string` | Cron expression (ví dụ: '0 8 * * *') |
| `every` | `number` | Lặp mỗi X milliseconds |
| `limit` | `number` | Giới hạn số lần lặp |
| `endDate` | `Date` | Ngày kết thúc lặp |

### QueueOptions

| Thuộc tính | Kiểu | Mô tả |
|------------|------|-------|
| `defaultJobOptions` | `JobOptions` | Job options mặc định cho queue |
| `redis` | `RedisOptions` | Cấu hình Redis connection |
| `prefix` | `string` | Prefix cho Redis keys |
| `settings` | `object` | Cài đặt queue (stalledInterval, maxStalledCount) |

---

## 🎯 Practical Examples

### Example 1: E-commerce Order Processing

```typescript
interface Order {
  orderId: string;
  userId: string;
  items: Array<{ productId: string; quantity: number; price: number }>;
  total: number;
  paymentMethod: string;
}

interface OrderResult {
  orderId: string;
  status: 'completed' | 'failed';
  paymentId?: string;
  shippingId?: string;
  error?: string;
}

async function processOrder(order: Order): Promise<OrderResult> {
  return await BullIO.emit<Order, OrderResult>({
    name: 'order-processor',
    threadId: `user-${order.userId}`,
    data: order,
    handler: async (orderData, job) => {
      const { orderId, userId, items, total, paymentMethod } = orderData;
      
      try {
        // Step 1: Validate inventory (20% progress)
        await job?.progress(20);
        for (const item of items) {
          const available = await checkInventory(item.productId);
          if (available < item.quantity) {
            throw new Error(`Insufficient inventory for ${item.productId}`);
          }
        }
        
        // Step 2: Process payment (40% progress)  
        await job?.progress(40);
        const payment = await processPayment({
          amount: total,
          method: paymentMethod,
          orderId
        });
        
        // Step 3: Reserve inventory (60% progress)
        await job?.progress(60);
        for (const item of items) {
          await reserveInventory(item.productId, item.quantity);
        }
        
        // Step 4: Create shipping (80% progress)
        await job?.progress(80);
        const shipping = await createShippingLabel(orderId, userId);
        
        // Step 5: Send confirmation (100% progress)
        await job?.progress(100);
await BullIO.fastEmit({
          channel: 'order-updates',
          data: { userId, orderId, status: 'completed' }
        });
        
        return {
          orderId,
          status: 'completed',
          paymentId: payment.id,
          shippingId: shipping.id
        };
        
      } catch (error) {
        await rollbackOrder(orderId);
        await BullIO.fastEmit({
          channel: 'order-updates',
          data: { userId, orderId, status: 'failed', error: error.message }
        });
        
        return { orderId, status: 'failed', error: error.message };
      }
    },
    jobOpts: {
    attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      timeout: 120000 // 2 minutes
    }
  });
}
```

### Example 2: Scheduled Report Generation

```typescript
interface ReportConfig {
  reportType: 'sales' | 'inventory' | 'users';
  dateRange: { from: string; to: string };
  format: 'pdf' | 'excel' | 'csv';
  recipients: string[];
}

interface ReportResult {
  reportId: string;
  fileUrl: string;
  generatedAt: string;
  fileSize: number;
}

async function setupDailyReports() {
  await BullIO.emit<ReportConfig, ReportResult>({
    name: 'daily-sales-report',
    data: {
      reportType: 'sales',
      dateRange: { from: 'yesterday', to: 'yesterday' },
      format: 'pdf',
      recipients: ['manager@company.com', 'sales@company.com']
    },
    handler: async (config) => {
      const reportData = await generateReportData(config.reportType, config.dateRange);
      const file = await createReportFile(reportData, config.format);
      const fileUrl = await uploadReportFile(file);
      
      // Send to recipients
      for (const email of config.recipients) {
        await BullIO.emit({
          name: 'email-sender',
          data: {
            to: email,
            subject: `Daily ${config.reportType} Report`,
            body: `Report attached: ${fileUrl}`,
            attachments: [{ url: fileUrl }]
          },
          handler: async (emailData) => await sendEmail(emailData)
        });
      }
      
      return {
        reportId: generateId(),
        fileUrl,
        generatedAt: new Date().toISOString(),
        fileSize: file.size
      };
    },
    jobOpts: {
      repeat: { cron: '0 8 * * *' }, // 8:00 AM daily
      removeOnComplete: 30,
      attempts: 2
    }
  });
}
```

---

**⚡ BullIO.emit là function chính - tự động tạo queue, xử lý job và trả về kết quả ngay lập tức!** 