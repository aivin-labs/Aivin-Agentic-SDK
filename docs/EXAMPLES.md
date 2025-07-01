# 💡 LeanEZ SDK - Ví dụ chi tiết

Tài liệu này chứa các ví dụ thực tế để phát triển plugins với LeanEZ SDK.

## 📋 Danh sách ví dụ

1. [Text Summarizer Plugin](#1-text-summarizer-plugin) - Tóm tắt văn bản với AI
2. [Simple Todo Manager](#2-simple-todo-manager) - Quản lý tasks cơ bản
3. [Weather Notification](#3-weather-notification) - Thông báo thời tiết real-time
4. [Background Email Sender](#4-background-email-sender) - Gửi email nền
5. [Smart Search với Embeddings](#5-smart-search-với-embeddings) - Tìm kiếm thông minh
6. [Work Reminder](#6-work-reminder---plugin-nhắc-nhở-công-việc-thông-minh) - Nhắc nhở công việc tự động

---

## 1. Text Summarizer Plugin

**Mô tả**: Plugin đơn giản sử dụng AI để tóm tắt văn bản thành 3 câu chính.

**Stacks sử dụng**: `AI_LLM`

```javascript
import { LLMIO, ContextIO } from '@leanez/sdk';

export async function textSummarizer({ ctx, text }) {
  const user = ctx.user;
  
  // Tóm tắt văn bản bằng AI
  const summary = await LLMIO.prompt(
    `Hãy tóm tắt văn bản sau thành 3 câu chính:\n\n${text}`,
    { 
      temperature: 0.3,
      maxTokens: 150,
      lang: 'vi'
    }
  );
  
  return {
    success: true,
    original_length: text.length,
    summary,
    user: user?.name
  };
}
```

**Manifest.json**:
```json
{
  "name": "text-summarizer",
  "version": "1.0.0",
  "description": "AI text summarization plugin",
  "author": "LeanEZ Team",
  "email": "support@leanez.app",
  "agent_specialized": ["content", "writing", "*"],
  "agent_designated": [],
  "functions": [
    {
      "name": "textSummarizer",
      "trigger_type": ["manual", "api", "chat"],
      "description": "Tóm tắt văn bản thành 3 câu chính",
      "inputs": [
        {
          "field": "text",
          "required": true,
          "description": "Văn bản cần tóm tắt",
          "type": "string"
        }
      ],
      "outputs": [
        {
          "field": "success",
          "description": "Trạng thái thành công",
          "type": "boolean"
        },
        {
          "field": "summary",
          "description": "Văn bản đã tóm tắt",
          "type": "string"
        },
        {
          "field": "original_length",
          "description": "Độ dài văn bản gốc",
          "type": "number"
        }
      ]
    }
  ]
}
```

**Cách sử dụng**:
```bash
leanez create text-summarizer --json manifest.json
```

---

## 2. Simple Todo Manager

**Mô tả**: Quản lý tasks cơ bản với MongoDB, thêm và liệt kê công việc.

**Stacks sử dụng**: `MONGODB`

```javascript
import { MongoIO, ContextIO } from '@leanez/sdk';

export async function todoManager({ ctx, action, task }) {
  const user = ctx.user;
  
  // Tạo Todo model
  const Todo = MongoIO.model('Todo', new MongoIO.Schema({
    userId: String,
    task: String,
    completed: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
  }));
  
  if (action === 'add') {
    // Thêm task mới
    const todo = new Todo({
      userId: user.id,
      task: task
    });
    await todo.save();
    
    return {
      success: true,
      message: `Đã thêm task: ${task}`,
      todoId: todo._id
    };
  }
  
  if (action === 'list') {
    // Lấy danh sách tasks
    const todos = await Todo.find({ userId: user.id }).sort({ createdAt: -1 });
    
    return {
      success: true,
      total: todos.length,
      todos: todos.map(t => ({
        id: t._id,
        task: t.task,
        completed: t.completed
      }))
    };
  }
  
  return { success: false, message: 'Action không hợp lệ' };
}
```

**Manifest.json**:
```json
{
  "name": "todo-manager",
  "version": "1.0.0",
  "description": "Quản lý tasks cơ bản",
  "author": "LeanEZ Team",
  "email": "support@leanez.app",
  "agent_specialized": ["productivity", "task-management", "*"],
  "agent_designated": ["productivity-agent"],
  "functions": [
    {
      "name": "todoManager",
      "trigger_type": ["manual", "api", "chat"],
      "description": "Thêm và liệt kê công việc",
      "inputs": [
        {
          "field": "action",
          "required": true,
          "description": "Hành động: 'add' hoặc 'list'",
          "type": "string"
        },
        {
          "field": "task",
          "required": false,
          "description": "Nội dung task (chỉ cần khi action=add)",
          "type": "string"
        }
      ],
      "outputs": [
        {
          "field": "success",
          "description": "Trạng thái thành công",
          "type": "boolean"
        },
        {
          "field": "message",
          "description": "Thông báo kết quả",
          "type": "string"
        },
        {
          "field": "todos",
          "description": "Danh sách todos (chỉ khi action=list)",
          "type": "array"
        },
        {
          "field": "todoId",
          "description": "ID của todo vừa tạo (chỉ khi action=add)",
          "type": "string"
        }
      ]
    }
  ]
}
```

---

## 3. Weather Notification

**Mô tả**: Cache thông tin thời tiết và gửi notifications real-time.

**Stacks sử dụng**: `REDIS_CACHE`, `REALTIME_COMMUNICATION`

```javascript
import { PubSubIO, RedisIO, ContextIO } from '@leanez/sdk';

export async function weatherNotifier({ ctx, city, temperature, condition, humidity }) {
  const user = ctx.user;
  
  // Lưu thông tin thời tiết vào cache
  await RedisIO.update(`weather:${city}`, {
    temperature,
    condition,
    humidity,
    timestamp: Date.now()
  }, { EX: 3600 }); // Cache 1 giờ
  
  // Gửi thông báo real-time
  await PubSubIO.publish('weather.update', {
    city,
    temperature,
    condition,
    user: user?.name,
    timestamp: Date.now()
  });
  
  return {
    success: true,
    message: `Đã cập nhật thời tiết ${city}: ${temperature}°C, ${condition}`,
    cached: true
  };
}
```

**Manifest.json**:
```json
{
  "name": "weather-notifier",
  "version": "1.0.0",
  "description": "Cache thông tin thời tiết và gửi notifications real-time",
  "author": "Weather Team",
  "email": "weather@leanez.app",
  "agent_specialized": ["weather", "notifications", "*"],
  "agent_designated": [],
  "functions": [
    {
      "name": "weatherNotifier",
      "trigger_type": ["manual", "api", "webhook"],
      "description": "Cập nhật và thông báo thời tiết",
      "inputs": [
        {
          "field": "city",
          "required": true,
          "description": "Tên thành phố",
          "type": "string"
        },
        {
          "field": "temperature",
          "required": true,
          "description": "Nhiệt độ (°C)",
          "type": "number"
        },
        {
          "field": "condition",
          "required": true,
          "description": "Tình trạng thời tiết",
          "type": "string"
        },
        {
          "field": "humidity",
          "required": false,
          "description": "Độ ẩm (%)",
          "type": "number"
        }
      ],
      "outputs": [
        {
          "field": "success",
          "description": "Trạng thái thành công",
          "type": "boolean"
        },
        {
          "field": "message",
          "description": "Thông báo kết quả",
          "type": "string"
        },
        {
          "field": "cached",
          "description": "Đã cache thành công",
          "type": "boolean"
        }
      ]
    }
  ]
}
```

---

## 4. Background Email Sender

**Mô tả**: Gửi email trong background sử dụng queue system.

**Stacks sử dụng**: `BACKGROUND_JOBS`, `REDIS_CACHE`

```javascript
import { BullIO, ContextIO } from '@leanez/sdk';

export async function emailSender({ ctx, email, subject, message }) {
  const user = ctx.user;
  
  // Gửi email trong background
  const result = await BullIO.emit({
    name: 'send-email',
    data: {
      to: email,
      subject,
      message,
      from: user?.email
    },
    handler: async (emailData) => {
      // Giả lập gửi email
      console.log(`Sending email to ${emailData.to}`);
      console.log(`Subject: ${emailData.subject}`);
      console.log(`Message: ${emailData.message}`);
      
      // Simulate email sending delay
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      return {
        sent: true,
        timestamp: new Date().toISOString(),
        messageId: `msg_${Date.now()}`
      };
    }
  });
  
  return {
    success: true,
    message: 'Email đã được gửi trong background',
    emailResult: result
  };
}
```

**Manifest.json**:
```json
{
  "name": "email-sender",
  "version": "1.0.0",
  "description": "Gửi email trong background sử dụng queue system",
  "author": "Communication Team",
  "email": "comm@leanez.app", 
  "agent_specialized": ["communication", "email", "*"],
  "agent_designated": ["email-agent"],
  "functions": [
    {
      "name": "emailSender",
      "trigger_type": ["manual", "api", "chat"],
      "description": "Gửi email bất đồng bộ",
      "inputs": [
        {
          "field": "email",
          "required": true,
          "description": "Email người nhận",
          "type": "string"
        },
        {
          "field": "subject",
          "required": true,
          "description": "Tiêu đề email",
          "type": "string"
        },
        {
          "field": "message",
          "required": true,
          "description": "Nội dung email",
          "type": "string"
        }
      ],
      "outputs": [
        {
          "field": "success",
          "description": "Trạng thái thành công",
          "type": "boolean"
        },
        {
          "field": "message",
          "description": "Thông báo kết quả",
          "type": "string"
        },
        {
          "field": "emailResult",
          "description": "Kết quả gửi email từ background job",
          "type": "object"
        }
      ]
    }
  ]
}
```

---

## 5. Smart Search với Embeddings

**Mô tả**: Tìm kiếm thông minh sử dụng AI embeddings và cache Redis.

**Stacks sử dụng**: `AI_LLM`, `REDIS_CACHE`

```javascript
import { LLMIO, RedisIO } from '@leanez/sdk';

export async function smartSearch({ ctx, query }) {
  const searchQuery = query;
  
  // Tạo embedding cho search query
  const queryEmbedding = await LLMIO.getEmbedding(searchQuery);
  
  // Cache embedding (tối ưu hóa)
  await RedisIO.update(`embedding:${searchQuery}`, queryEmbedding, { EX: 86400 });
  
  // Giả lập tìm kiếm với documents có sẵn
  const documents = [
    "Hướng dẫn sử dụng LeanEZ SDK cho developers",
    "Cách tạo AI plugin với JavaScript",
    "MongoDB integration trong LeanEZ",
    "Redis caching strategies"
  ];
  
  // Tạo embeddings cho documents
  const docEmbeddings = await Promise.all(
    documents.map(doc => LLMIO.getEmbedding(doc))
  );
  
  // Tính similarity (đơn giản hóa)
  const results = documents.map((doc, index) => ({
    document: doc,
    similarity: Math.random() // Thay bằng cosine similarity thực
  })).sort((a, b) => b.similarity - a.similarity);
  
  return {
    success: true,
    query: searchQuery,
    results: results.slice(0, 3), // Top 3 results
    embeddingSize: queryEmbedding.length
  };
}
```

**Manifest.json**:
```json
{
  "name": "smart-search",
  "version": "1.0.0",
  "description": "Tìm kiếm thông minh sử dụng AI embeddings và cache Redis",
  "author": "AI Search Team",
  "email": "search@leanez.app",
  "agent_specialized": ["search", "ai", "knowledge", "*"],
  "agent_designated": ["search-agent"],
  "functions": [
    {
      "name": "smartSearch",
      "trigger_type": ["manual", "api", "chat"],
      "description": "Tìm kiếm semantic với AI embeddings",
      "inputs": [
        {
          "field": "query",
          "required": true,
          "description": "Từ khóa tìm kiếm",
          "type": "string"
        }
      ],
      "outputs": [
        {
          "field": "success",
          "description": "Trạng thái thành công",
          "type": "boolean"
        },
        {
          "field": "query",
          "description": "Query đã xử lý",
          "type": "string"
        },
        {
          "field": "results",
          "description": "Kết quả tìm kiếm",
          "type": "array"
        },
        {
          "field": "embeddingSize",
          "description": "Kích thước vector embedding",
          "type": "number"
        }
      ]
    }
  ]
}
```

---

## 6. Work Reminder - Plugin nhắc nhở công việc thông minh

**Mô tả**: Plugin toàn diện để quản lý và nhắc nhở công việc tự động, gửi thông báo cho nhiều người trong workspace.

**Stacks sử dụng**: `AI_LLM`, `MONGODB`, `BACKGROUND_JOBS`, `REALTIME_COMMUNICATION`, `REDIS_CACHE`

```javascript
import { LLMIO, MongoIO, BullIO, PubSubIO, ContextIO } from '@leanez/sdk';

export async function workReminder({ ctx, action, title, assignedTo, dueDate, priority, reminderTime, taskId }) {
  const user = ctx.user;
  const workspace = ctx.workspace;
  
  // Tạo Task model
  const Task = MongoIO.model('Task', new MongoIO.Schema({
    workspaceId: String,
    title: String,
    description: String,
    assignedTo: [String], // Array user IDs
    dueDate: Date,
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    reminderTime: Date,
    isCompleted: { type: Boolean, default: false },
    createdBy: String,
    createdAt: { type: Date, default: Date.now }
  }));
  
  if (action === 'create') {
    // Tạo task mới với AI-generated smart reminders
    const smartDescription = await LLMIO.prompt(
      `Tạo mô tả chi tiết và đề xuất thời gian nhắc nhở phù hợp cho task: "${title}". 
       Ưu tiên: ${priority}. Deadline: ${dueDate}`,
      { 
        temperature: 0.4,
        maxTokens: 200,
        lang: 'vi'
      }
    );
    
    // Lưu task vào database
    const task = new Task({
      workspaceId: workspace?.id,
      title,
      description: smartDescription,
      assignedTo: assignedTo || [user?.id],
      dueDate: new Date(dueDate),
      priority: priority || 'medium',
      reminderTime: new Date(reminderTime || Date.now() + 24 * 60 * 60 * 1000), // Default 1 day
      createdBy: user?.id
    });
    
    await task.save();
    
    // Lên lịch gửi reminder tự động
    await BullIO.emit({
      name: 'schedule-reminder',
      data: {
        taskId: task._id,
        workspaceId: workspace?.id,
        reminderTime: task.reminderTime
      },
      delay: task.reminderTime.getTime() - Date.now(), // Delay đến thời gian nhắc nhở
      handler: async (reminderData) => {
        // Lấy thông tin task
        const taskToRemind = await Task.findById(reminderData.taskId);
        if (!taskToRemind || taskToRemind.isCompleted) return;
        
        // Tạo tin nhắn nhắc nhở thông minh
        const reminderMessage = await LLMIO.prompt(
          `Tạo tin nhắn nhắc nhở lịch sự và thúc đẩy cho task: "${taskToRemind.title}". 
           Ưu tiên: ${taskToRemind.priority}. Deadline: ${taskToRemind.dueDate.toLocaleDateString('vi-VN')}`,
          { temperature: 0.6, maxTokens: 150, lang: 'vi' }
        );
        
        // Gửi thông báo cho tất cả người được assign
        for (const userId of taskToRemind.assignedTo) {
          await PubSubIO.publish(`user:${userId}:notifications`, {
            type: 'task_reminder',
            taskId: taskToRemind._id,
            title: taskToRemind.title,
            message: reminderMessage,
            priority: taskToRemind.priority,
            dueDate: taskToRemind.dueDate,
            workspaceName: workspace?.name,
            timestamp: Date.now()
          });
        }
        
        // Gửi thông báo workspace-wide
        await PubSubIO.publish(`workspace:${reminderData.workspaceId}:announcements`, {
          type: 'task_reminder',
          taskTitle: taskToRemind.title,
          assignedCount: taskToRemind.assignedTo.length,
          priority: taskToRemind.priority,
          message: `⏰ Nhắc nhở: "${taskToRemind.title}" sắp đến hạn!`,
          timestamp: Date.now()
        });
        
        return {
          reminderSent: true,
          notifiedUsers: taskToRemind.assignedTo.length,
          taskId: taskToRemind._id
        };
      }
    });
    
    // Thông báo tạo task thành công
    await PubSubIO.publish(`workspace:${workspace?.id}:announcements`, {
      type: 'task_created',
      taskTitle: task.title,
      createdBy: user?.name,
      assignedTo: assignedTo?.length || 1,
      dueDate: task.dueDate,
      message: `📝 Task mới: "${task.title}" đã được tạo bởi ${user?.name}`,
      timestamp: Date.now()
    });
    
    return {
      success: true,
      message: `Task "${title}" đã được tạo và lên lịch nhắc nhở`,
      taskId: task._id,
      reminderScheduled: task.reminderTime,
      assignedUsers: task.assignedTo.length,
      smartDescription
    };
  }
  
  if (action === 'list') {
    // Lấy danh sách tasks trong workspace
    const tasks = await Task.find({ 
      workspaceId: workspace?.id,
      isCompleted: false 
    }).sort({ dueDate: 1 });
    
    return {
      success: true,
      workspace: workspace?.name,
      totalTasks: tasks.length,
      tasks: tasks.map(t => ({
        id: t._id,
        title: t.title,
        priority: t.priority,
        dueDate: t.dueDate,
        assignedTo: t.assignedTo.length,
        daysLeft: Math.ceil((t.dueDate - new Date()) / (1000 * 60 * 60 * 24))
      }))
    };
  }
  
  if (action === 'complete') {
    // Đánh dấu task hoàn thành
    const task = await Task.findByIdAndUpdate(
      taskId,
      { isCompleted: true },
      { new: true }
    );
    
    if (task) {
      // Thông báo hoàn thành task
      await PubSubIO.publish(`workspace:${workspace?.id}:announcements`, {
        type: 'task_completed',
        taskTitle: task.title,
        completedBy: user?.name,
        message: `✅ Task "${task.title}" đã được hoàn thành bởi ${user?.name}`,
        timestamp: Date.now()
      });
    }
    
    return {
      success: true,
      message: `Task "${task?.title}" đã được đánh dấu hoàn thành`,
      taskId: taskId
    };
  }
  
  return { success: false, message: 'Action không hợp lệ' };
}
```