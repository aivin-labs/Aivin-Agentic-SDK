# 🔌 LeanEZ Plugin Development Guide

Hướng dẫn phát triển plugins cho LeanEZ sử dụng SDK. Tạo plugins mạnh mẽ với AI, background processing và real-time messaging.

## 📦 Quick Start

### Installation

```bash
npm install @leanez/sdk
# hoặc
yarn add @leanez/sdk
```

### Environment Setup

| Biến môi trường | Bắt buộc | Mặc định | Mô tả |
|-----------------|----------|----------|-------|
| `REDIS_URL` | ✅ | - | URL kết nối Redis |
| `MONGODB_URI` | ✅ | - | URI kết nối MongoDB |
| `OPENAI_API_KEY` | ❌ | - | API key cho AI features |
| `NODE_ENV` | ❌ | `development` | Môi trường chạy |

### Basic Plugin Template

```typescript
import { Context, BullIO, PubSubIO, AI } from '@leanez/sdk';

export async function myFirstPlugin() {
  // Lấy thông tin user hiện tại
  const user = await Context.getCurrentUser();
  if (!user) throw new Error('No active user');
  
  // Xử lý background với AI
  const result = await BullIO.emit({
    name: 'my-plugin-processor',
    data: { userId: user.id, task: 'analyze-data' },
    handler: async (data) => {
      const analysis = await AI.generateText({
        prompt: `Analyze user data for ${data.userId}`,
        model: 'gpt-4'
      });
      return { analysis, processedAt: Date.now() };
    }
  });
  
  // Thông báo hoàn thành
  await PubSubIO.publish('plugin-completed', {
    userId: user.id,
    pluginName: 'my-first-plugin',
    result
  });
  
  return result;
}
```

---

## 🎯 Plugin Types & Examples

### AI Chat Assistant Plugin

**Mục đích:** Tạo AI assistant để hỗ trợ người dùng trong workspace.

#### Core Features

| Feature | Implementation | Mô tả |
|---------|----------------|-------|
| Chat Interface | PubSubIO | Real-time messaging |
| AI Processing | AI Service + BullIO | Background AI processing |
| Context Awareness | Context Service | Hiểu workspace context |
| Memory | MongoDB | Lưu conversation history |

#### Implementation

```typescript
import { Context, BullIO, PubSubIO, AI } from '@leanez/sdk';

interface ChatMessage {
  id: string;
  userId: string;
  message: string;
  timestamp: number;
  type: 'user' | 'assistant';
}

interface AIResponse {
  response: string;
  confidence: number;
  tokensUsed: number;
}

class AIChatAssistant {
  private assistantId: string;
  
  constructor(assistantId: string) {
    this.assistantId = assistantId;
  }
  
  async start() {
    // Lắng nghe tin nhắn từ users
    await PubSubIO.subscribe(`chat-${this.assistantId}`, async (message: ChatMessage) => {
      if (message.type === 'user') {
        await this.processUserMessage(message);
      }
    });
    
    console.log(`AI Assistant ${this.assistantId} started`);
  }
  
  private async processUserMessage(message: ChatMessage) {
    // Xử lý AI trong background
    const aiResponse = await BullIO.emit<ChatMessage, AIResponse>({
      name: 'ai-chat-processor',
      threadId: `user-${message.userId}`,
      data: message,
      handler: async (userMessage) => {
        // Lấy context của user
        const user = await Context.getCurrentUser();
        const workspace = await Context.getCurrentWorkspace();
        
        // Tạo context-aware prompt
        const contextPrompt = `
          User: ${user?.name} (${user?.email})
          Workspace: ${workspace?.name}
          Current task: ${(await Context.getCurrentTask())?.title || 'None'}
          
          User message: ${userMessage.message}
          
          Respond as a helpful workspace assistant.
        `;
        
        const response = await AI.generateText({
          prompt: contextPrompt,
          model: 'gpt-4',
          maxTokens: 500
        });
        
        return {
          response,
          confidence: 0.95,
          tokensUsed: 300
        };
      },
      jobOpts: {
        attempts: 3,
        timeout: 30000
      }
    });
    
    // Gửi response về user
    const responseMessage: ChatMessage = {
      id: generateId(),
      userId: this.assistantId,
      message: aiResponse.response,
      timestamp: Date.now(),
      type: 'assistant'
    };
    
    await PubSubIO.publish(`chat-${this.assistantId}`, responseMessage);
    
    // Lưu conversation history
    await this.saveConversation(message, responseMessage);
  }
  
  private async saveConversation(userMessage: ChatMessage, assistantMessage: ChatMessage) {
    // Lưu vào database để maintain context
    console.log('Conversation saved:', { userMessage, assistantMessage });
  }
}

// Usage
export async function startAIChatAssistant() {
  const assistant = new AIChatAssistant('workspace-ai-assistant');
  await assistant.start();
  return assistant;
}
```

---

### Task Management Plugin

**Mục đích:** Tự động hóa task management và workflow.

#### Core Features

| Feature | Implementation | Mô tả |
|---------|----------------|-------|
| Auto Assignment | Context + BullIO | Tự động assign tasks |
| Progress Tracking | PubSubIO | Real-time progress updates |
| Deadline Monitoring | BullIO scheduled jobs | Kiểm tra deadlines |
| Notifications | PubSubIO | Thông báo real-time |

#### Implementation

```typescript
interface Task {
  id: string;
  title: string;
  description: string;
  assignee?: string;
  status: 'pending' | 'in-progress' | 'completed' | 'overdue';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  deadline: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface TaskAnalysis {
  suggestedAssignee: string;
  estimatedHours: number;
  priority: string;
  tags: string[];
}

class TaskManagerPlugin {
  async createTask(taskData: Partial<Task>): Promise<Task> {
    // Phân tích task với AI
    const analysis = await BullIO.emit<Partial<Task>, TaskAnalysis>({
      name: 'task-analyzer',
      data: taskData,
      handler: async (data) => {
        const workspace = await Context.getCurrentWorkspace();
        
        const analysisPrompt = `
          Workspace: ${workspace?.name}
          Task: ${data.title}
          Description: ${data.description}
          
          Analyze this task and provide:
          1. Suggested assignee (based on expertise)
          2. Estimated hours to complete
          3. Priority level (low/medium/high/urgent)
          4. Relevant tags
        `;
        
        const result = await AI.generateText({
          prompt: analysisPrompt,
          model: 'gpt-4'
        });
        
        // Parse AI response (simplified)
        return {
          suggestedAssignee: 'team-lead',
          estimatedHours: 8,
          priority: 'medium',
          tags: ['development', 'feature']
        };
      }
    });
    
    // Tạo task với AI suggestions
    const newTask: Task = {
      id: generateId(),
      title: taskData.title!,
      description: taskData.description!,
      assignee: analysis.suggestedAssignee,
      status: 'pending',
      priority: analysis.priority as Task['priority'],
      deadline: taskData.deadline!,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    // Lưu task
    await this.saveTask(newTask);
    
    // Thông báo task mới
    await PubSubIO.publish('task-created', {
      task: newTask,
      analysis,
      timestamp: Date.now()
    });
    
    // Setup deadline monitoring
    await this.scheduleDeadlineCheck(newTask);
    
    return newTask;
  }
  
  async updateTaskStatus(taskId: string, status: Task['status']) {
    const task = await this.getTask(taskId);
    if (!task) throw new Error('Task not found');
    
    task.status = status;
    task.updatedAt = new Date();
    
    await this.saveTask(task);
    
    // Real-time update
    await PubSubIO.publish('task-updated', {
      taskId,
      status,
      timestamp: Date.now()
    });
    
    // Nếu completed, trigger analysis
    if (status === 'completed') {
      await this.analyzeTaskCompletion(task);
    }
  }
  
  private async scheduleDeadlineCheck(task: Task) {
    // Schedule job để check deadline
    await BullIO.emit({
      name: 'deadline-checker',
      data: { taskId: task.id },
      handler: async (data) => {
        const currentTask = await this.getTask(data.taskId);
        if (!currentTask || currentTask.status === 'completed') return;
        
        const now = new Date();
        const deadline = new Date(currentTask.deadline);
        
        if (now > deadline && currentTask.status !== 'overdue') {
          await this.updateTaskStatus(currentTask.id, 'overdue');
          
          // Send overdue notification
          await PubSubIO.publish('task-overdue', {
            task: currentTask,
            overdueBy: now.getTime() - deadline.getTime()
          });
        }
      },
      jobOpts: {
        delay: task.deadline.getTime() - Date.now(),
        attempts: 1
      }
    });
  }
  
  private async analyzeTaskCompletion(task: Task) {
    // Phân tích completion để cải thiện estimates
    const completionTime = task.updatedAt.getTime() - task.createdAt.getTime();
    
    await BullIO.emit({
      name: 'completion-analyzer',
      data: { task, completionTime },
      handler: async (data) => {
        const analysis = await AI.generateText({
          prompt: `
            Task completed: ${data.task.title}
            Estimated priority: ${data.task.priority}
            Actual completion time: ${data.completionTime / (1000 * 60 * 60)} hours
            
            Analyze completion patterns for better future estimates.
          `,
          model: 'gpt-3.5-turbo'
        });
        
        // Store insights for future task estimates
        console.log('Task completion analysis:', analysis);
        return analysis;
      }
    });
  }
  
  private async saveTask(task: Task) {
    // Save to database
    console.log('Task saved:', task);
  }
  
  private async getTask(taskId: string): Promise<Task | null> {
    // Get from database
    return null;
  }
}

// Usage
export async function setupTaskManager() {
  const taskManager = new TaskManagerPlugin();
  
  // Lắng nghe task creation requests
  await PubSubIO.reply('task.create', async (data) => {
    return await taskManager.createTask(data);
  });
  
  // Lắng nghe status updates
  await PubSubIO.reply('task.update-status', async (data) => {
    return await taskManager.updateTaskStatus(data.taskId, data.status);
  });
  
  return taskManager;
}
```

---

### Document Processing Plugin

**Mục đích:** Xử lý và phân tích documents tự động.

#### Core Features

| Feature | Implementation | Mô tả |
|---------|----------------|-------|
| File Upload | BullIO | Background file processing |
| Text Extraction | AI Service | Extract text từ files |
| Content Analysis | AI + BullIO | Phân tích nội dung |
| Search Indexing | Background jobs | Tạo search index |

#### Implementation

```typescript
interface Document {
  id: string;
  filename: string;
  fileType: string;
  size: number;
  uploadedBy: string;
  uploadedAt: Date;
  processedAt?: Date;
  status: 'uploaded' | 'processing' | 'completed' | 'failed';
  content?: string;
  summary?: string;
  tags?: string[];
  searchKeywords?: string[];
}

interface ProcessingResult {
  content: string;
  summary: string;
  tags: string[];
  keywords: string[];
  confidence: number;
}

class DocumentProcessor {
  async processDocument(fileUrl: string, metadata: Partial<Document>): Promise<Document> {
    const user = await Context.getCurrentUser();
    if (!user) throw new Error('No active user');
    
    // Tạo document record
    const document: Document = {
      id: generateId(),
      filename: metadata.filename!,
      fileType: metadata.fileType!,
      size: metadata.size!,
      uploadedBy: user.id,
      uploadedAt: new Date(),
      status: 'uploaded'
    };
    
    // Save initial document
    await this.saveDocument(document);
    
    // Process trong background
    const processingResult = await BullIO.emit<{document: Document, fileUrl: string}, ProcessingResult>({
      name: 'document-processor',
      threadId: `user-${user.id}`,
      data: { document, fileUrl },
      handler: async (data, job) => {
        const { document, fileUrl } = data;
        
        // Update status
        document.status = 'processing';
        await this.saveDocument(document);
        await job?.progress(10);
        
        // Extract text based on file type
        let extractedText: string;
        
        switch (document.fileType) {
          case 'pdf':
            extractedText = await this.extractPDFText(fileUrl);
            break;
          case 'docx':
            extractedText = await this.extractWordText(fileUrl);
            break;
          case 'txt':
            extractedText = await this.extractPlainText(fileUrl);
            break;
          default:
            throw new Error(`Unsupported file type: ${document.fileType}`);
        }
        
        await job?.progress(40);
        
        // Analyze content với AI
        const analysis = await AI.generateText({
          prompt: `
            Analyze this document content and provide:
            1. A concise summary (max 200 words)
            2. Key tags/categories (max 10)
            3. Important keywords for search (max 20)
            
            Content: ${extractedText.substring(0, 4000)}
          `,
          model: 'gpt-4',
          maxTokens: 800
        });
        
        await job?.progress(80);
        
        // Parse AI response (simplified)
        const summary = this.extractSummary(analysis);
        const tags = this.extractTags(analysis);
        const keywords = this.extractKeywords(analysis);
        
        await job?.progress(100);
        
        return {
          content: extractedText,
          summary,
          tags,
          keywords,
          confidence: 0.9
        };
      },
      jobOpts: {
        attempts: 3,
        timeout: 300000, // 5 minutes
        backoff: { type: 'exponential', delay: 5000 }
      }
    });
    
    // Update document với processing results
    document.content = processingResult.content;
    document.summary = processingResult.summary;
    document.tags = processingResult.tags;
    document.searchKeywords = processingResult.keywords;
    document.processedAt = new Date();
    document.status = 'completed';
    
    await this.saveDocument(document);
    
    // Notify completion
    await PubSubIO.publish('document-processed', {
      documentId: document.id,
      userId: user.id,
      processingResult,
      timestamp: Date.now()
    });
    
    // Index for search
    await this.indexDocument(document);
    
    return document;
  }
  
  async searchDocuments(query: string, userId: string): Promise<Document[]> {
    // Search với AI-enhanced matching
    const searchResult = await BullIO.emit({
      name: 'document-search',
      data: { query, userId },
      handler: async (data) => {
        // Get user's documents
        const userDocs = await this.getUserDocuments(data.userId);
        
        // AI-powered semantic search
        const searchPrompt = `
          Search query: ${data.query}
          
          Find the most relevant documents from this list based on content, tags, and keywords.
          Return document IDs in order of relevance.
        `;
        
        // Simplified: return filtered docs
        return userDocs.filter(doc => 
          doc.content?.toLowerCase().includes(data.query.toLowerCase()) ||
          doc.tags?.some(tag => tag.toLowerCase().includes(data.query.toLowerCase()))
        );
      }
    });
    
    return searchResult;
  }
  
  private async extractPDFText(fileUrl: string): Promise<string> {
    // PDF text extraction logic
    return 'Extracted PDF text...';
  }
  
  private async extractWordText(fileUrl: string): Promise<string> {
    // Word document text extraction logic
    return 'Extracted Word text...';
  }
  
  private async extractPlainText(fileUrl: string): Promise<string> {
    // Plain text file reading
    return 'Plain text content...';
  }
  
  private extractSummary(aiResponse: string): string {
    // Parse summary from AI response
    return 'Document summary...';
  }
  
  private extractTags(aiResponse: string): string[] {
    // Parse tags from AI response
    return ['document', 'analysis'];
  }
  
  private extractKeywords(aiResponse: string): string[] {
    // Parse keywords from AI response
    return ['keyword1', 'keyword2'];
  }
  
  private async saveDocument(document: Document) {
    // Save to database
    console.log('Document saved:', document);
  }
  
  private async getUserDocuments(userId: string): Promise<Document[]> {
    // Get user's documents from database
    return [];
  }
  
  private async indexDocument(document: Document) {
    // Index document for search
    console.log('Document indexed:', document.id);
  }
}

// Usage
export async function setupDocumentProcessor() {
  const processor = new DocumentProcessor();
  
  // Handle document upload
  await PubSubIO.reply('document.process', async (data) => {
    return await processor.processDocument(data.fileUrl, data.metadata);
  });
  
  // Handle search requests
  await PubSubIO.reply('document.search', async (data) => {
    return await processor.searchDocuments(data.query, data.userId);
  });
  
  return processor;
}
```

---

## 🏗️ Plugin Architecture Patterns

### Event-Driven Plugin

**Khi nào sử dụng:** Khi plugin cần respond to events trong hệ thống

| Component | Purpose | Implementation |
|-----------|---------|----------------|
| Event Listeners | Listen to system events | PubSubIO.subscribe |
| Event Processors | Process events | BullIO.emit |
| Event Publishers | Emit new events | PubSubIO.publish |

```typescript
class EventDrivenPlugin {
  async start() {
    // Listen to workspace events
    await PubSubIO.subscribe('workspace.member-added', async (data) => {
      await this.handleNewMember(data);
    });
    
    await PubSubIO.subscribe('task.completed', async (data) => {
      await this.handleTaskCompletion(data);
    });
  }
  
  private async handleNewMember(data: any) {
    // Welcome new member
    await BullIO.emit({
      name: 'welcome-processor',
      data: { memberId: data.memberId },
      handler: async (memberData) => {
        // Send welcome message, setup defaults, etc.
        return { welcomed: true };
      }
    });
  }
  
  private async handleTaskCompletion(data: any) {
    // Analyze completion, update metrics, etc.
  }
}
```

### Scheduled Plugin

**Khi nào sử dụng:** Khi plugin cần chạy theo lịch định kỳ

| Component | Purpose | Implementation |
|-----------|---------|----------------|
| Scheduler | Run jobs on schedule | BullIO.emit with repeat |
| Job Processor | Process scheduled jobs | BullIO handler |
| Status Monitor | Monitor job status | BullIO.getRunningJobs |

```typescript
class ScheduledPlugin {
  async start() {
    // Daily report generation
    await BullIO.emit({
      name: 'daily-report-generator',
      handler: async () => {
        const workspace = await Context.getCurrentWorkspace();
        // Generate daily report
        return { reportGenerated: true, timestamp: Date.now() };
      },
      jobOpts: {
        repeat: { cron: '0 8 * * *' }, // 8 AM daily
        removeOnComplete: 7 // Keep 7 days
      }
    });
    
    // Weekly cleanup
    await BullIO.emit({
      name: 'weekly-cleanup',
      handler: async () => {
        // Cleanup old data, optimize database, etc.
        return { cleanupCompleted: true };
      },
      jobOpts: {
        repeat: { cron: '0 2 * * 0' }, // 2 AM every Sunday
        removeOnComplete: 4 // Keep 4 weeks
      }
    });
  }
}
```

### API Service Plugin

**Khi nào sử dụng:** Khi plugin expose API endpoints cho external systems

| Component | Purpose | Implementation |
|-----------|---------|----------------|
| Request Handlers | Handle API requests | PubSubIO.reply |
| Business Logic | Process requests | BullIO.emit |
| Response Formatters | Format responses | Standard functions |

```typescript
class APIServicePlugin {
  async start() {
    // Handle user data requests
    await PubSubIO.reply('api.user.get', async (request) => {
      const { userId, fields } = request;
      
      return await BullIO.emit({
        name: 'user-data-processor',
        data: { userId, fields },
        handler: async (data) => {
          const user = await this.getUserData(data.userId);
          
          // Filter fields if specified
          if (data.fields) {
            return this.filterUserFields(user, data.fields);
          }
          
          return user;
        }
      });
    });
    
    // Handle data updates
    await PubSubIO.reply('api.user.update', async (request) => {
      const { userId, updates } = request;
      
      return await BullIO.emit({
        name: 'user-update-processor',
        data: { userId, updates },
        handler: async (data) => {
          const updatedUser = await this.updateUser(data.userId, data.updates);
          
          // Notify other systems
          await PubSubIO.publish('user.updated', {
            userId: data.userId,
            changes: data.updates
          });
          
          return updatedUser;
        }
      });
    });
  }
  
  private async getUserData(userId: string) {
    // Get user data
    return {};
  }
  
  private filterUserFields(user: any, fields: string[]) {
    // Filter user fields
    return {};
  }
  
  private async updateUser(userId: string, updates: any) {
    // Update user
    return {};
  }
}
```

---

## 🧪 Testing Plugins

### Unit Testing

#### Test Setup

| Tool | Purpose | Configuration |
|------|---------|---------------|
| Jest | Test framework | `jest.config.js` |
| Mock Services | Mock SDK services | Custom mocks |
| Test Database | Isolated testing | MongoDB Memory Server |

```typescript
// jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts']
};

// tests/setup.ts
import { jest } from '@jest/globals';

// Mock SDK services
jest.mock('@leanez/sdk', () => ({
  Context: {
    getCurrentUser: jest.fn(),
    getCurrentWorkspace: jest.fn(),
    getCurrentTask: jest.fn()
  },
  BullIO: {
    emit: jest.fn(),
    submit: jest.fn()
  },
  PubSubIO: {
    publish: jest.fn(),
    subscribe: jest.fn(),
    request: jest.fn(),
    reply: jest.fn()
  },
  AI: {
    generateText: jest.fn()
  }
}));
```

#### Test Examples

```typescript
// tests/ai-chat-assistant.test.ts
import { AIChatAssistant } from '../src/ai-chat-assistant';
import { Context, BullIO, PubSubIO, AI } from '@leanez/sdk';

describe('AIChatAssistant', () => {
  let assistant: AIChatAssistant;
  
  beforeEach(() => {
    assistant = new AIChatAssistant('test-assistant');
    jest.clearAllMocks();
  });
  
  test('should process user message and respond', async () => {
    // Mock dependencies
    (Context.getCurrentUser as jest.Mock).mockResolvedValue({
      id: 'user123',
      name: 'Test User',
      email: 'test@example.com'
    });
    
    (BullIO.emit as jest.Mock).mockResolvedValue({
      response: 'Hello! How can I help you?',
      confidence: 0.95,
      tokensUsed: 50
    });
    
    // Mock message
    const userMessage = {
      id: 'msg1',
      userId: 'user123',
      message: 'Hello',
      timestamp: Date.now(),
      type: 'user' as const
    };
    
    // Process message
    await assistant['processUserMessage'](userMessage);
    
    // Verify AI processing was called
    expect(BullIO.emit).toHaveBeenCalledWith({
      name: 'ai-chat-processor',
      threadId: 'user-user123',
      data: userMessage,
      handler: expect.any(Function),
      jobOpts: {
        attempts: 3,
        timeout: 30000
      }
    });
    
    // Verify response was published
    expect(PubSubIO.publish).toHaveBeenCalledWith(
      'chat-test-assistant',
      expect.objectContaining({
        message: 'Hello! How can I help you?',
        type: 'assistant'
      })
    );
  });
});
```

### Integration Testing

#### Test Server Setup

```typescript
// tests/integration/test-server.ts
import { MongoMemoryServer } from 'mongodb-memory-server';
import Redis from 'ioredis';

class TestServer {
  private mongoServer: MongoMemoryServer;
  private redisServer: Redis;
  
  async start() {
    // Start MongoDB Memory Server
    this.mongoServer = await MongoMemoryServer.create();
    const mongoUri = this.mongoServer.getUri();
    
    // Start Redis (assuming local Redis for testing)
    this.redisServer = new Redis({
      host: 'localhost',
      port: 6379,
      db: 15 // Use separate DB for testing
    });
    
    // Set environment variables
    process.env.MONGODB_URI = mongoUri;
    process.env.REDIS_URL = 'redis://localhost:6379/15';
    process.env.NODE_ENV = 'test';
    
    console.log('Test server started');
  }
  
  async stop() {
    await this.mongoServer?.stop();
    await this.redisServer?.quit();
    console.log('Test server stopped');
  }
  
  async cleanup() {
    // Clear test data
    await this.redisServer?.flushdb();
    console.log('Test data cleaned');
  }
}

export const testServer = new TestServer();
```

#### Integration Test Example

```typescript
// tests/integration/task-manager.test.ts
import { TaskManagerPlugin } from '../../src/task-manager';
import { testServer } from './test-server';

describe('TaskManagerPlugin Integration', () => {
  let taskManager: TaskManagerPlugin;
  
  beforeAll(async () => {
    await testServer.start();
  });
  
  afterAll(async () => {
    await testServer.stop();
  });
  
  beforeEach(async () => {
    await testServer.cleanup();
    taskManager = new TaskManagerPlugin();
  });
  
  test('should create and process task end-to-end', async () => {
    const taskData = {
      title: 'Test Task',
      description: 'Integration test task',
      deadline: new Date(Date.now() + 86400000) // 1 day from now
    };
    
    // Create task
    const task = await taskManager.createTask(taskData);
    
    expect(task).toMatchObject({
      title: 'Test Task',
      description: 'Integration test task',
      status: 'pending'
    });
    
    expect(task.id).toBeDefined();
    expect(task.assignee).toBeDefined();
    
    // Update task status
    await taskManager.updateTaskStatus(task.id, 'completed');
    
    // Verify task was updated
    const updatedTask = await taskManager['getTask'](task.id);
    expect(updatedTask?.status).toBe('completed');
  });
});
```

---

## 🚀 Plugin Deployment

### Package Structure

```
my-plugin/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── plugin.ts
│   └── types.ts
├── dist/
├── tests/
└── README.md
```

### Package Configuration

#### package.json

```json
{
  "name": "@mycompany/leanez-my-plugin",
  "version": "1.0.0",
  "description": "My awesome LeanEZ plugin",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "dev": "ts-node src/index.ts",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "@leanez/sdk": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^18.0.0",
    "typescript": "^4.8.0",
    "jest": "^29.0.0",
    "ts-jest": "^29.0.0",
    "ts-node": "^10.9.0"
  },
  "peerDependencies": {
    "@leanez/sdk": "^1.0.0"
  },
  "keywords": [
    "leanez",
    "plugin",
    "productivity"
  ]
}
```

#### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

### Plugin Registration

#### Plugin Manifest

```typescript
// src/index.ts
import { PluginManifest } from '@leanez/sdk/types';
import { MyPlugin } from './plugin';

export const manifest: PluginManifest = {
  id: 'my-awesome-plugin',
  name: 'My Awesome Plugin',
  version: '1.0.0',
  description: 'An awesome plugin that does amazing things',
  author: 'Your Name',
  permissions: [
    'context.read',
    'context.write',
    'ai.generate',
    'background.process',
    'pubsub.publish',
    'pubsub.subscribe'
  ],
  dependencies: {
    '@leanez/sdk': '^1.0.0'
  },
  configuration: {
    apiKey: {
      type: 'string',
      required: false,
      description: 'Optional API key for external service'
    },
    enableFeatureX: {
      type: 'boolean',
      required: false,
      default: true,
      description: 'Enable experimental feature X'
    }
  }
};

export { MyPlugin };
export default MyPlugin;
```

---

## 🔍 Debugging & Monitoring

### Logging Strategy

| Log Level | When to Use | Example |
|-----------|-------------|---------|
| `error` | Errors, exceptions | Failed API calls, validation errors |
| `warn` | Warnings, deprecations | Performance issues, deprecated usage |
| `info` | General information | Plugin started, major operations |
| `debug` | Detailed debugging | Function calls, data transformations |

```typescript
import { createLogger } from '@leanez/sdk/logger';

const logger = createLogger('my-plugin');

class MyPlugin {
  async start() {
    logger.info('Plugin starting...', { version: '1.0.0' });
    
    try {
      await this.initialize();
      logger.info('Plugin initialized successfully');
    } catch (error) {
      logger.error('Plugin initialization failed', { error: error.message });
      throw error;
    }
  }
  
  private async processData(data: any) {
    logger.debug('Processing data', { dataSize: JSON.stringify(data).length });
    
    try {
      const result = await this.heavyProcessing(data);
      logger.info('Data processed successfully', { resultSize: result.length });
      return result;
    } catch (error) {
      logger.error('Data processing failed', { 
        error: error.message, 
        data: JSON.stringify(data).substring(0, 100) 
      });
      throw error;
    }
  }
}
```

### Health Checks

```typescript
class PluginHealthMonitor {
  private healthChecks: Map<string, () => Promise<boolean>> = new Map();
  
  registerHealthCheck(name: string, check: () => Promise<boolean>) {
    this.healthChecks.set(name, check);
  }
  
  async runHealthChecks(): Promise<{ [key: string]: boolean }> {
    const results: { [key: string]: boolean } = {};
    
    for (const [name, check] of this.healthChecks) {
      try {
        results[name] = await check();
      } catch (error) {
        logger.error(`Health check failed: ${name}`, { error: error.message });
        results[name] = false;
      }
    }
    
    return results;
  }
  
  async startPeriodicHealthCheck(intervalMs: number = 60000) {
    setInterval(async () => {
      const health = await this.runHealthChecks();
      const failedChecks = Object.entries(health)
        .filter(([, status]) => !status)
        .map(([name]) => name);
      
      if (failedChecks.length > 0) {
        logger.warn('Health checks failed', { failedChecks });
        
        // Notify via PubSub
        await PubSubIO.publish('plugin.health.warning', {
          pluginId: 'my-plugin',
          failedChecks,
          timestamp: Date.now()
        });
      }
    }, intervalMs);
  }
}

// Usage
const healthMonitor = new PluginHealthMonitor();

healthMonitor.registerHealthCheck('database', async () => {
  // Check database connectivity
  return true;
});

healthMonitor.registerHealthCheck('external-api', async () => {
  // Check external API availability
  return true;
});

await healthMonitor.startPeriodicHealthCheck();
```

---

## 🏭 Production Best Practices

### Error Handling

#### Robust Error Handling Pattern

```typescript
class RobustPlugin {
  async safeExecute<T>(
    operation: () => Promise<T>,
    operationName: string,
    fallback?: T
  ): Promise<T | undefined> {
    try {
      logger.debug(`Starting operation: ${operationName}`);
      const result = await operation();
      logger.debug(`Operation completed: ${operationName}`);
      return result;
    } catch (error) {
      logger.error(`Operation failed: ${operationName}`, {
        error: error.message,
        stack: error.stack
      });
      
      // Report error to monitoring
      await this.reportError(operationName, error);
      
      // Return fallback if provided
      if (fallback !== undefined) {
        logger.info(`Using fallback for: ${operationName}`);
        return fallback;
      }
      
      // Re-throw if no fallback
      throw error;
    }
  }
  
  private async reportError(operation: string, error: Error) {
    try {
      await PubSubIO.publish('plugin.error', {
        pluginId: 'my-plugin',
        operation,
        error: {
          message: error.message,
          stack: error.stack,
          timestamp: Date.now()
        }
      });
    } catch (reportError) {
      // Don't let error reporting break the main flow
      logger.error('Failed to report error', { reportError: reportError.message });
    }
  }
}
```

### Performance Monitoring

#### Performance Metrics Collection

```typescript
class PerformanceMonitor {
  private metrics: Map<string, number[]> = new Map();
  
  async measureAsync<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const startTime = Date.now();
    
    try {
      const result = await operation();
      const duration = Date.now() - startTime;
      this.recordMetric(name, duration);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.recordMetric(`${name}.error`, duration);
      throw error;
    }
  }
  
  private recordMetric(name: string, value: number) {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }
    
    const values = this.metrics.get(name)!;
    values.push(value);
    
    // Keep only last 100 measurements
    if (values.length > 100) {
      values.shift();
    }
  }
  
  getMetricStats(name: string) {
    const values = this.metrics.get(name) || [];
    if (values.length === 0) return null;
    
    const sorted = [...values].sort((a, b) => a - b);
    return {
      count: values.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)]
    };
  }
  
  async reportMetrics() {
    const report: { [key: string]: any } = {};
    
    for (const [name] of this.metrics) {
      report[name] = this.getMetricStats(name);
    }
    
    await PubSubIO.publish('plugin.metrics', {
      pluginId: 'my-plugin',
      metrics: report,
      timestamp: Date.now()
    });
  }
}

// Usage
const perfMonitor = new PerformanceMonitor();

const result = await perfMonitor.measureAsync('ai.generateText', async () => {
  return await AI.generateText({
    prompt: 'Generate summary...',
    model: 'gpt-4'
  });
});
```

### Resource Management

```typescript
class ResourceManager {
  private resources: Map<string, any> = new Map();
  private cleanupHandlers: (() => Promise<void>)[] = [];
  
  async acquireResource<T>(
    name: string,
    factory: () => Promise<T>,
    cleanup?: (resource: T) => Promise<void>
  ): Promise<T> {
    if (this.resources.has(name)) {
      return this.resources.get(name);
    }
    
    logger.debug(`Acquiring resource: ${name}`);
    const resource = await factory();
    this.resources.set(name, resource);
    
    if (cleanup) {
      this.cleanupHandlers.push(() => cleanup(resource));
    }
    
    return resource;
  }
  
  async cleanup() {
    logger.info('Cleaning up resources...');
    
    for (const handler of this.cleanupHandlers) {
      try {
        await handler();
      } catch (error) {
        logger.error('Resource cleanup failed', { error: error.message });
      }
    }
    
    this.resources.clear();
    this.cleanupHandlers.length = 0;
    
    logger.info('Resource cleanup completed');
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  await resourceManager.cleanup();
  process.exit(0);
});
```

---

**🔌 Với hướng dẫn này, bạn đã sẵn sàng tạo ra những plugins mạnh mẽ cho LeanEZ!** 