# 📊 LeanEZ SDK - Data Structures & Types

Tài liệu này mô tả các cấu trúc dữ liệu và types được sử dụng trong LeanEZ SDK.

## 🔗 Import Types

```typescript
// Import individual types
import { User, Workspace, Task, PubSubMessage, LLMRequest } from '@leanez/sdk';

// Import all types from a service
import type { 
  PubSubMessage, 
  RequestOptions, 
  MessageMetadata 
} from '@leanez/sdk/dto/PubSubDTO';

// Import context types
import type {
  User,
  Workspace,
  Task,
  HandlerHistory,
  Message,
  Session
} from '@leanez/sdk/dto/ContextDTO';

// Import BullIO types
import type {
  JobFailedError,
  JobHandler,
  JobProcessor
} from '@leanez/sdk';
```

## 📋 Context Types

### User

Thông tin người dùng trong hệ thống:

```typescript
interface User {
  _id: string;
  client?: string;
  name?: string;
  email?: string;
  phone?: string;
  gender?: GenderType;
  created_at?: Date;
  updated_at?: Date;
}

enum GenderType {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  OTHER = 'OTHER'
}
```

### Workspace & Project

Cấu trúc workspace và project:

```typescript
interface Workspace {
  _id: string;
  name: string;
  description?: string;
  owner_id: string;
  members: Member[];
  workflow_config?: WorkflowConfig;
  created_at: Date;
  updated_at: Date;
}

interface Member {
  user_id: string;
  role: string;
  joined_at: Date;
}

interface Project {
  _id: string;
  workspace_id: string;
  name: string;
  description?: string;
  created_at: Date;
  updated_at: Date;
}
```

### Task & HandlerHistory

Cấu trúc task được cập nhật từ TodoModel:

```typescript
interface Task {
  _id: string;
  order?: number;
  key?: string;
  title: string;
  description?: string;
  step?: string;
  handler_history?: HandlerHistory[];
  from_date?: Date;
  to_date?: Date;
  priority?: number;
  creator_id?: string;
  assign_id?: string;
  created_date?: Date;
  handler_state?: string;
  hard_score?: number;
  workload?: number;
  complexity?: number;
  created_at: Date;
  updated_at: Date;
}

interface HandlerHistory {
  member_id?: string;
  member_name?: string;
  member_nickname?: string;
  member_avatar?: string;
  step?: string;
  assigned_date?: Date;
}
```

### Message & Session

Cấu trúc tin nhắn và phiên làm việc:

```typescript
interface Message {
  _id: string;
  session_id: string;
  content: string;
  sender: string;
  receiver?: string;
  media_items?: MediaItem[];
  server_action?: ServerAction;
  client_action?: ClientAction;
  timestamp: Date;
  created_at: Date;
  updated_at: Date;
}

interface Session {
  _id: string;
  agent_id?: string;
  user_id: string;
  workspace_id?: string;
  project_id?: string;
  title?: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface MediaItem {
  type: string;
  url: string;
  filename?: string;
  size?: number;
}
```

**Ví dụ sử dụng Context Types:**

```typescript
import { ContextIO, User, Task, Workspace } from '@leanez/sdk';

// Lấy thông tin user
const user: User = await ContextIO.getUser('user_id');
console.log(`User: ${user.name} (${user.email})`);

// Lấy workspace
const workspace: Workspace = await ContextIO.getWorkspace('workspace_id');
console.log(`Workspace: ${workspace.name} - ${workspace.members.length} members`);

// Lấy tasks
const tasks: Task[] = await ContextIO.getTasks('project_id');
tasks.forEach(task => {
  console.log(`Task: ${task.title} - Priority: ${task.priority}`);
  if (task.handler_history?.length) {
    console.log(`Last handler: ${task.handler_history[0].member_name}`);
  }
});
```

## 📮 PubSubIO Types

### PubSubMessage

Cấu trúc message cơ bản cho tất cả communications:

```typescript
interface PubSubMessage {
  id: string;              // Unique message identifier
  channel: string;         // Channel name where message was sent
  data: any;              // Message payload (your actual data)
  timestamp: number;       // Unix timestamp when message was created
  sender?: string;         // Optional sender identifier
  receiver?: string;       // Optional receiver identifier
  type?: string;           // Optional message type
  responseChannel?: string; // Channel for response (request-response pattern)
  ttl?: number;            // Time to live in milliseconds
}
```

**Ví dụ sử dụng:**

```typescript
// Trong subscriber handler
await PubSubIO.subscribe('user-events', (message: PubSubMessage) => {
  console.log(`Message ID: ${message.id}`);
  console.log(`From channel: ${message.channel}`);
  console.log(`Sent at: ${new Date(message.timestamp)}`);
  console.log(`Data:`, message.data);
  
  if (message.sender) {
    console.log(`Sent by: ${message.sender}`);
  }
});
```

### RequestOptions

Options cho các request operations:

```typescript
interface RequestOptions {
  timeout?: number;        // Request timeout in milliseconds (default: 30000)
  sender?: string;         // Identifier of the sender
}
```

**Ví dụ sử dụng:**

```typescript
const result = await PubSubIO.request('calculation-service', {
  operation: 'multiply',
  numbers: [2, 3, 4]
}, {
  timeout: 5000,           // 5 second timeout
  sender: 'math-plugin'    // Identify this plugin as sender
});
```

### MessageMetadata

Extended metadata cho advanced messaging:

```typescript
interface MessageMetadata {
  messageId: string;
  correlationId?: string;   // For tracking related messages
  replyTo?: string;        // Channel to reply to
  expiration?: number;     // Message expiration timestamp
  priority?: number;       // Message priority (0-10)
  headers?: Record<string, any>; // Custom headers
}
```

## 🤖 LLMIO Types

### LLMRequest

Cấu trúc request gửi đến LLM services:

```typescript
interface LLMRequest {
  type: 'prompt' | 'embedding' | 'getAssistant' | 'newAssistantThread' | 
        'getAssistantThread' | 'updateAssistant' | 'promptAssistant' | 'calculateTokens';
  request?: any;           // Prompt request data
  text?: string;           // Text for embedding/token calculation
  assistantId?: string;    // Assistant ID for assistant operations
  threadId?: string;       // Thread ID for thread operations
  llmId?: string;         // LLM model ID
  assistant?: any;         // Assistant data for updates
  options?: LLMRequestOptions;
  driver?: string;         // LLM driver to use
  pluginId: string;        // Plugin identifier
  timestamp: number;       // Request timestamp
}
```

### LLMRequestOptions

Options cho LLM requests:

```typescript
interface LLMRequestOptions {
  ttl?: number;           // Time to live
  threadId?: string;      // Thread ID for context
  temperature?: number;   // Randomness (0.0-1.0)
  max_tokens?: number;    // Maximum tokens to generate
  model?: string;         // Specific model to use
  provider?: string;      // LLM provider (openai, anthropic, etc.)
  timeout?: number;       // Request timeout
}
```

**Ví dụ sử dụng:**

```typescript
const response = await LLMIO.prompt({
  messages: [
    { role: 'system', content: 'You are a helpful assistant' },
    { role: 'user', content: 'Explain machine learning in simple terms' }
  ]
}, {
  temperature: 0.7,       // Somewhat creative
  max_tokens: 500,        // Limit response length
  model: 'gpt-4',        // Use GPT-4
  timeout: 30000         // 30 second timeout
});
```

### Assistant & AssistantThread

```typescript
interface Assistant {
  id: string;
  name: string;
  description?: string;
  instructions?: string;   // System instructions for the assistant
  model?: string;         // Model to use
  tools?: any[];          // Available tools/functions
}

interface AssistantThread {
  id: string;
  assistantId?: string;
  metadata?: Record<string, any>;
  createdAt: number;
}
```

**Ví dụ sử dụng:**

```typescript
// Get assistant
const assistant: Assistant = await LLMIO.getAssistant('asst_123');

// Create new thread
const threadId: string = await LLMIO.newAssistantThread();

// Get thread info
const thread: AssistantThread = await LLMIO.getAssistantThread(threadId);

// Chat with assistant
await LLMIO.promptAssistant(threadId, assistant.id, 'Hello, can you help me?');
```

### LLM Exceptions

```typescript
class ThreadBusyException extends Error {
  constructor(message = 'Thread is busy and cannot accept new messages');
}

class ThreadRunActiveException extends Error {
  constructor(message = 'Thread has an active run and cannot accept new messages');
}
```

**Ví dụ xử lý:**

```typescript
try {
  await LLMIO.promptAssistant(threadId, assistantId, message);
} catch (error) {
  if (error instanceof ThreadBusyException) {
    console.log('Thread is busy, please wait...');
    // Retry logic
  } else if (error instanceof ThreadRunActiveException) {
    console.log('Thread has active run, cannot send new message');
    // Handle active run
  } else {
    console.error('Unexpected error:', error.message);
  }
}
```

## 🏢 ContextIO Types

**Tham khảo từ**: `src/user/dto/UserDTO.ts`, `src/workspace/dto/WorkspaceDTO.ts`, `src/message/dto/MessageDTO.ts`, `src/assistant/dto/AssistantDTO.ts`

### User Management
```typescript
import { User, GenderType } from '@leanez/sdk';

// User interface - tương ứng với UserDTO
interface User {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  nickname: string;
  avatar?: string;
  auth_type: string;
  auth_provider: string;
  country?: string;
  city?: string;
  district?: string;
  ward?: string;
  lang?: string;
  gender?: GenderType;
  client: string;
  created_at?: Date;
  updated_at?: Date;
}

enum GenderType {
  MALE = "male",
  FEMALE = "female", 
  OTHER = "other"
}

// Sử dụng
const user: User = {
  id: 'user-123',
  nickname: 'john_doe',
  auth_type: 'oauth',
  auth_provider: 'google',
  client: 'web-app',
  email: 'john@example.com',
  name: 'John Doe',
  avatar: 'https://example.com/avatar.jpg',
  lang: 'vi'
};
```

### Workspace & Project Management
```typescript
import { Workspace, Project, Member, WorkflowConfig } from '@leanez/sdk';

// Member interface
interface Member {
  user_id?: string;
  email: string;
  avatar?: string;
  name?: string;
  role: string;
  position?: string;
  experience?: string;
}

// Workflow configuration
interface WorkflowConfig {
  step_list: string[];
  workflow: {
    member_id: string;
    member_name: string;
    assigned_steps: string[];
  }[];
  description: string;
}

// Workspace interface
interface Workspace {
  id: string;
  name: string;
  avatar?: string;
  client: string;
  members?: Member[];
  message?: string;
  created_at?: Date;
  updated_at?: Date;
}

// Project interface
interface Project {
  id: string;
  workspace_id: string;
  client: string;
  name: string;
  members?: Member[];
  is_delete?: boolean;
  workflow?: WorkflowConfig;
  created_at?: Date;
  updated_at?: Date;
}

// Sử dụng
const workspace: Workspace = {
  id: 'workspace-123',
  name: 'Development Team',
  client: 'company-xyz',
  message: 'Main development workspace',
  members: [
    {
      email: 'dev1@company.com',
      name: 'Developer 1',
      role: 'developer',
      position: 'Senior Developer'
    }
  ]
};

const project: Project = {
  id: 'project-456',
  workspace_id: 'workspace-123',
  name: 'Mobile App',
  client: 'company-xyz',
  members: [
    {
      user_id: 'user-789',
      email: 'pm@company.com',
      name: 'Project Manager',
      role: 'manager',
      position: 'Senior PM'
    }
  ]
};
```

### Session & Message Management
```typescript
import { Session, Message, MediaItem, ServerAction, ClientAction } from '@leanez/sdk';

// Session interface - tương ứng với MessageDTO
interface Session {
  id: string;
  name?: string;
  is_activated?: boolean;
  client: string;
  user_id: string;
  agent_id: string;
  agent_name: string;
  agent_avatar: string;
  current_llm_id: string;
  current_thread: string;
  llm_threads: any;
  driver: string;
  suggest_actions?: boolean;
  workspace_id?: string;
  project_id?: string;
  prompt_options?: any;
  training_scope?: any;
  training_share_scope?: any;
  created_at?: Date;
  updated_at?: Date;
}

// Message interface
interface Message {
  id: string;
  session_id: string;
  user_id: string;
  text: string;
  images?: MediaItem[];
  files?: MediaItem[];
  audio?: MediaItem;
  role?: 'assistant' | 'user' | 'system';
  prompt?: ServerAction;
  actions?: ClientAction[];
  timestamp?: number;
  reply_id?: string;
  meta?: any;
  created_at?: Date;
  updated_at?: Date;
}

// Media item
interface MediaItem {
  id: string;
  url: string;
  mime: string;
  extension?: string;
  name?: string;
  size?: number;
}

// Server action
interface ServerAction {
  func: string;
  args: any;
  payload?: any;
  options?: any;
}

// Client action
interface ClientAction {
  text: string;
  type?: 'primary' | 'secondary' | 'outline';
  place?: 'inline' | 'pin';
  func: string;
  args?: any;
}

// Sử dụng
const session: Session = {
  id: 'session-123',
  client: 'web-app',
  user_id: 'user-456',
  agent_id: 'assistant-123',
  agent_name: 'Support Bot',
  agent_avatar: 'https://example.com/bot.jpg',
  current_llm_id: 'gpt-4',
  current_thread: 'thread-789',
  driver: 'openai',
  workspace_id: 'workspace-789',
  llm_threads: {}
};

const message: Message = {
  id: 'msg-123',
  session_id: 'session-123',
  user_id: 'user-456',
  text: 'Hello, how can I help you?',
  role: 'user',
  timestamp: Date.now(),
  images: [
    {
      id: 'img-1',
      url: 'https://example.com/image.jpg',
      mime: 'image/jpeg',
      size: 1024000
    }
  ]
};
```

### Agent Management
```typescript
import { Agent } from '@leanez/sdk';

// Agent interface - tương ứng với AssistantDTO
interface Agent {
  id: string;
  name: string;
  description?: string;
  avatar?: string;
  instructions?: string;
  model?: string;
  tools?: any[];
  user_id: string;
  workspace_id?: string;
  is_public?: boolean;
  created_at?: Date;
  updated_at?: Date;
}

// Sử dụng
const agent: Agent = {
  id: 'agent-123',
  name: 'Customer Support Bot',
  description: 'AI assistant for customer support',
  instructions: 'You are a helpful customer support agent',
  model: 'gpt-4',
  user_id: 'user-456',
  workspace_id: 'workspace-789',
  is_public: false,
  tools: [
    { type: 'function', name: 'search_knowledge_base' },
    { type: 'function', name: 'create_ticket' }
  ]
};
```

### Task Management (Todo System)
```typescript
import { Task, HandlerHistory } from '@leanez/sdk';

// Handler history - lịch sử xử lý task
interface HandlerHistory {
  member_id: string;
  member_name: string;
  member_nickname: string;
  member_avatar: string;
  step: string;
  assigned_date: Date;
}

// Task interface - tương ứng với TodoModel
interface Task {
  id: string;
  order?: number;           // Thứ tự sắp xếp
  title: string;            // Tiêu đề task
  key?: string;             // Key định danh
  description?: string;     // Mô tả chi tiết
  step?: string;            // Bước hiện tại trong workflow
  handler_history?: HandlerHistory[];  // Lịch sử xử lý
  from_date?: Date;         // Ngày bắt đầu
  to_date?: Date;           // Ngày kết thúc
  priority: 'high' | 'medium' | 'low';  // Độ ưu tiên
  creator_id: string;       // ID người tạo
  assign_id?: string;       // ID người được giao
  project_id: string;       // ID project
  workspace_id: string;     // ID workspace
  created_date?: Date;      // Ngày tạo
  handler_state: 'todo' | 'doing' | 'done' | 'reject';  // Trạng thái
  hard_score: number;       // Điểm độ khó (0-1)
  workload: number;         // Khối lượng công việc
  complexity: 'simple' | 'normal' | 'complex';  // Độ phức tạp
  created_at?: Date;
  updated_at?: Date;
}

// Sử dụng
const task: Task = {
  id: 'task-123',
  title: 'Implement user authentication',
  description: 'Add login/logout functionality with JWT',
  priority: 'high',
  creator_id: 'user-456',
  assign_id: 'dev-789',
  project_id: 'project-123',
  workspace_id: 'workspace-456',
  handler_state: 'todo',
  hard_score: 0.7,
  workload: 3,
  complexity: 'normal',
  from_date: new Date('2024-01-15'),
  to_date: new Date('2024-01-20'),
  handler_history: [
    {
      member_id: 'user-456',
      member_name: 'Project Manager',
      member_nickname: 'pm_user',
      member_avatar: 'https://example.com/pm.jpg',
      step: 'created',
      assigned_date: new Date('2024-01-10')
    }
  ]
};
```

### Complete Context Example
```typescript
import { ContextIO, User, Workspace, Session, Message, Agent } from '@leanez/sdk';

// Context-aware application
const buildContextualApp = async () => {
  // Get current user
  const user: User = await ContextIO.getCurrentUser();
  
  // Get user's workspaces
  const workspaces: Workspace[] = await ContextIO.getUserWorkspaces(user.id);
  
  // Create new session in workspace
  const session: Session = await ContextIO.createSession({
    agent_id: 'support-bot',
    user_id: user.id,
    workspace_id: workspaces[0].id,
    provider: 'openai',
    model: 'gpt-4',
    lang: user.lang || 'vi'
  });
  
  // Send message
  const message: Message = await ContextIO.sendMessage({
    session_id: session.id,
    user_id: user.id,
    text: 'Tôi cần hỗ trợ về sản phẩm',
    role: 'user'
  });
  
  console.log('Context built successfully:', {
    user: user.nickname,
    workspace: workspaces[0].name,
    session: session.id,
    message: message.id
  });
};
```

## 🗄️ MongoIO Types

MongoIO sử dụng native Mongoose types:

```typescript
import { MongoIO } from '@leanez/sdk';

// Mongoose Schema types
const userSchema = new MongoIO.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  age: { type: Number, min: 0 },
  tags: [String],
  metadata: { type: MongoIO.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now }
});

// ObjectId type
const userId = new MongoIO.Types.ObjectId();
```

## ⚡ BullIO Types

### Job Processing Types

Các types mới được thêm vào BullIO:

```typescript
// Job Error Handler
interface JobFailedError extends Error {
  jobId: string;
  queueName: string;
  attemptsMade: number;
  data: any;
}

// Job Handler Function Type
type JobHandler<T = any, R = any> = (data: T) => Promise<R> | R;

// Job Processor Configuration
interface JobProcessor<T = any> {
  name: string;
  handler: JobHandler<T>;
  concurrency?: number;
  queueOpts?: Bull.QueueOptions;
}

// Thread Management
interface ThreadInfo {
  threadId: string;
  jobs: string[];
  status: 'active' | 'completed' | 'failed' | 'cancelled';
}

// Queue Statistics
interface QueueStats {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
}
```

**Ví dụ sử dụng BullIO Types:**

```typescript
import { BullIO, JobHandler, JobProcessor, ThreadInfo } from '@leanez/sdk';

// Định nghĩa job handler với type safety
const imageProcessHandler: JobHandler<{url: string, filters: string[]}, {processedUrl: string}> = 
  async (data) => {
    const processedImage = await processImage(data.url, data.filters);
    return { processedUrl: processedImage.url };
  };

// Tạo job processor
const processor: JobProcessor = {
  name: 'image-processing',
  handler: imageProcessHandler,
  concurrency: 3
};

// Error handling
try {
  const result = await BullIO.emit({
    name: 'image-processing',
    data: { url: 'image.jpg', filters: ['resize'] },
    handler: imageProcessHandler
  });
} catch (error) {
  if (error instanceof JobFailedError) {
    console.log(`Job ${error.jobId} failed after ${error.attemptsMade} attempts`);
    console.log('Original data:', error.data);
  }
}

// Thread management
const threadId = 'user-session-123';
const threadInfo: ThreadInfo = await BullIO.getThreadInfo(threadId);
console.log(`Thread ${threadId} has ${threadInfo.jobs.length} jobs`);

// Cancel all jobs in thread
await BullIO.cancelRunningJobs(threadId);
```

### Queue Management Types

```typescript
// Queue Configuration
interface QueueConfig {
  name: string;
  redis?: {
    host: string;
    port: number;
    password?: string;
    db?: number;
  };
  defaultJobOptions?: {
    removeOnComplete?: number | boolean;
    removeOnFail?: number | boolean;
    attempts?: number;
    backoff?: number | string;
    delay?: number;
  };
  settings?: {
    stalledInterval?: number;
    maxStalledCount?: number;
  };
}

// Job Status
type JobStatus = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused';

// Job Progress Callback
type ProgressCallback = (progress: number) => void;
```

**Advanced Usage:**

```typescript
// Custom queue với full configuration
const customQueue = await BullIO.newInstance({
  name: 'custom-processing',
  handler: async (job) => {
    // Report progress
    await job.progress(25);
    
    // Do some work
    const step1 = await processStep1(job.data);
    await job.progress(50);
    
    const step2 = await processStep2(step1);
    await job.progress(75);
    
    const result = await finalizeProcess(step2);
    await job.progress(100);
    
    return result;
  },
  queueOpts: {
    defaultJobOptions: {
      attempts: 3,
      backoff: 'exponential',
      removeOnComplete: 10,
      removeOnFail: 5
    },
    settings: {
      stalledInterval: 30000,
      maxStalledCount: 1
    }
  },
  concurrency: 2
});

// Listen for queue events
customQueue.on('progress', (job, progress) => {
  console.log(`Job ${job.id} progress: ${progress}%`);
});

customQueue.on('failed', (job, error) => {
  console.error(`Job ${job.id} failed:`, error.message);
});
```

## 🔧 Generic Response Types

Các response types thông dụng:

```typescript
// Standard API Response
interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp?: number;
}

// Paginated Response
interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasNext: boolean;
  hasPrev: boolean;
}

// Health Check Response
interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy' | 'degraded';
  services: {
    redis: boolean;
    mongo: boolean;
    llm: boolean;
  };
  uptime: number;
  timestamp: number;
}
```

**Ví dụ sử dụng:**

```typescript
export async function getUserProjects(userId: string): Promise<ApiResponse<Project[]>> {
  try {
    const user = await ContextIO.getCurrentUser();
    if (user.id !== userId) {
      return {
        success: false,
        error: 'Unauthorized access'
      };
    }
    
    const projects = await ContextIO.getWorkspaceProjects();
    const userProjects = projects.filter(p => p.assigneeId === userId);
    
    return {
      success: true,
      data: userProjects,
      message: `Found ${userProjects.length} projects`
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}
```

## 🎯 Type Guards & Validation

Utility functions để validate types:

```typescript
// Type guards
function isPubSubMessage(obj: any): obj is PubSubMessage {
  return obj && 
         typeof obj.id === 'string' &&
         typeof obj.channel === 'string' &&
         typeof obj.timestamp === 'number' &&
         obj.data !== undefined;
}

function isUser(obj: any): obj is User {
  return obj &&
         typeof obj.id === 'string' &&
         typeof obj.name === 'string' &&
         typeof obj.email === 'string' &&
         typeof obj.role === 'string';
}

// Validation helpers
function validateLLMOptions(options: any): options is LLMRequestOptions {
  if (!options) return true; // Options are optional
  
  if (options.temperature && (options.temperature < 0 || options.temperature > 1)) {
    return false;
  }
  
  if (options.max_tokens && options.max_tokens <= 0) {
    return false;
  }
  
  return true;
}

// Usage example
export async function safePrompt(messages: any[], options?: any) {
  if (!Array.isArray(messages)) {
    throw new Error('Messages must be an array');
  }
  
  if (options && !validateLLMOptions(options)) {
    throw new Error('Invalid LLM options');
  }
  
  return await LLMIO.prompt({ messages }, options);
}
```

## 📝 TypeScript Configuration

Để có type checking tốt nhất, cấu hình TypeScript:

```json
// tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "noImplicitReturns": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true
  }
}
```

**Ví dụ plugin với full TypeScript support:**

```typescript
import { 
  ContextIO, 
  LLMIO, 
  PubSubIO, 
  type User, 
  type LLMRequestOptions,
  type ApiResponse 
} from '@leanez/sdk';

interface PluginInput {
  prompt: string;
  options?: LLMRequestOptions;
}

interface PluginOutput {
  response: string;
  user: string;
  tokenCount: number;
}

export async function myTypedPlugin(input: PluginInput): Promise<ApiResponse<PluginOutput>> {
  try {
    // Type-safe operations
    const user: User = await ContextIO.getCurrentUser();
    
    const response = await LLMIO.prompt({
      messages: [{ role: 'user', content: input.prompt }]
    }, input.options);
    
    const tokenCount: number = await LLMIO.calculateTokens(input.prompt);
    
    // Publish typed event
    await PubSubIO.publish('plugin.completed', {
      userId: user.id,
      pluginName: 'myTypedPlugin',
      tokenCount
    });
    
    return {
      success: true,
      data: {
        response: response.content,
        user: user.name,
        tokenCount
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
```

---

**🎉 Với các types này, bạn có thể phát triển plugin type-safe và robust!**