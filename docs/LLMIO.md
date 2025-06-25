# 🤖 LLMIO - AI Operations

**LLMIO** cung cấp complete AI capabilities bao gồm chat, embeddings, assistants, và token calculation.

## 🚀 Tính năng chính

| Tính năng | Mô tả |
|-----------|-------|
| **AI Chat** | Tương tác với các AI models (GPT-4, Claude, etc.) |
| **Embeddings** | Generate vector embeddings cho semantic search |
| **AI Assistants** | Quản lý conversations với memory/context |
| **Token Management** | Calculate tokens và cost tracking |
| **Media Support** | Hỗ trợ images, files trong AI prompts |

## 📖 API Reference

### Basic Chat Operations

#### `LLMIO.prompt(message, options?)`
Gửi prompt tới AI model

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | `string` | ✅ | - | Nội dung prompt gửi tới AI |
| `options` | `PromptOptions` | ❌ | `{}` | Tùy chọn cho AI request |
| `options.model` | `string` | ❌ | `'gpt-3.5-turbo'` | AI model sử dụng |
| `options.temperature` | `number` | ❌ | `0.7` | Creativity level (0.0 - 1.0) |
| `options.maxTokens` | `number` | ❌ | `1000` | Maximum tokens in response |
| `options.ttl` | `number` | ❌ | `undefined` | Cache TTL (seconds) |
| `options.lang` | `string` | ❌ | `'en'` | Response language |
| `options.emoji` | `boolean` | ❌ | `false` | Include emojis in response |
| `options.style` | `string` | ❌ | `'normal'` | Response style |
| `options.provider` | `string` | ❌ | `'openai'` | AI provider |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<string>` | AI response content |

##### Example
```javascript
import { LLMIO } from '@leanez/sdk';

// Basic prompt
const response = await LLMIO.prompt("Hello AI!");

// With options
const response = await LLMIO.prompt("Explain quantum computing", {
  model: 'gpt-4',
  temperature: 0.3,
  maxTokens: 1000,
  lang: 'vi',
  emoji: true
});
```

---

### Embeddings Operations

#### `LLMIO.getEmbedding(text, options?)`
Generate vector embedding cho text

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | `string` | ✅ | - | Text cần tạo embedding |
| `options` | `EmbeddingOptions` | ❌ | `{}` | Tùy chọn embedding |
| `options.model` | `string` | ❌ | `'text-embedding-ada-002'` | Embedding model |
| `options.provider` | `string` | ❌ | `'openai'` | AI provider |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<number[]>` | Vector embedding array |

##### Example
```javascript
// Simple embedding
const embedding = await LLMIO.getEmbedding("Text to embed");

// With options
const embedding = await LLMIO.getEmbedding("Advanced text", {
  model: 'text-embedding-ada-002',
  provider: 'openai'
});

// Semantic search example
const queryEmbedding = await LLMIO.getEmbedding("search query");
const docEmbeddings = await Promise.all([
  LLMIO.getEmbedding("Document 1 content"),
  LLMIO.getEmbedding("Document 2 content"),
  LLMIO.getEmbedding("Document 3 content")
]);
```

---

### AI Assistants

#### `LLMIO.newAssistantThread()`
Tạo conversation thread mới

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| *Không có parameters* | - | - | - | - |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<string>` | Thread ID cho conversation |

##### Example
```javascript
const threadId = await LLMIO.newAssistantThread();
console.log('New thread created:', threadId);
```

---

#### `LLMIO.getAssistantThread(threadId)`
Lấy thông tin conversation thread

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `threadId` | `string` | ✅ | - | Thread ID cần lấy |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<ThreadInfo>` | Thông tin thread và message history |

##### Example
```javascript
const thread = await LLMIO.getAssistantThread(threadId);
console.log('Thread info:', thread);
// Output: { id: 'thread_123', messages: [...], createdAt: '2024-01-01' }
```

---

#### `LLMIO.promptAssistant(threadId, model, message, options?)`
Chat trong thread với memory

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `threadId` | `string` | ✅ | - | Thread ID |
| `model` | `string` | ✅ | - | AI model sử dụng |
| `message` | `string` | ✅ | - | Message gửi tới assistant |
| `options` | `AssistantOptions` | ❌ | `{}` | Tùy chọn assistant |
| `options.temperature` | `number` | ❌ | `0.7` | Creativity level |
| `options.maxTokens` | `number` | ❌ | `1000` | Maximum response tokens |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<string>` | Assistant response |

##### Example
```javascript
// Create conversation thread
const threadId = await LLMIO.newAssistantThread();

// Chat with memory
await LLMIO.promptAssistant(
  threadId,
  'gpt-4',
  'I need help with React hooks',
  { temperature: 0.7 }
);

await LLMIO.promptAssistant(
  threadId,
  'gpt-4',
  'Can you show me an example?',
  { temperature: 0.7 }
);
```

---

#### `LLMIO.getAssistant(assistantId)`
Lấy thông tin assistant

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `assistantId` | `string` | ✅ | - | Assistant ID |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<AssistantInfo>` | Thông tin assistant |

##### Example
```javascript
const assistant = await LLMIO.getAssistant('assistant-id');
console.log('Assistant info:', assistant);
```

---

#### `LLMIO.updateAssistant(assistantId, config)`
Cập nhật assistant configuration

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `assistantId` | `string` | ✅ | - | Assistant ID |
| `config` | `AssistantConfig` | ✅ | - | Cấu hình mới |
| `config.name` | `string` | ❌ | - | Tên assistant |
| `config.instructions` | `string` | ❌ | - | System instructions |
| `config.model` | `string` | ❌ | - | AI model |
| `config.tools` | `Tool[]` | ❌ | - | Available tools |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<AssistantInfo>` | Assistant info đã cập nhật |

##### Example
```javascript
await LLMIO.updateAssistant('assistant-id', {
  name: 'Code Helper',
  instructions: 'You are a helpful coding assistant',
  model: 'gpt-4',
  tools: [{ type: 'code_interpreter' }]
});
```

---

### Token Management

#### `LLMIO.calculateTokens(input)`
Calculate tokens và cost

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `input` | `TokenInput` | ✅ | - | Input để calculate tokens |
| `input.inputText` | `string` | ❌ | - | Text input (cho simple calculation) |
| `input.messages` | `Message[]` | ❌ | - | Messages array (cho conversations) |
| `input.model` | `string` | ✅ | - | AI model |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<TokenInfo>` | Thông tin tokens và cost |

##### Example
```javascript
// Simple token calculation
const tokenInfo = await LLMIO.calculateTokens({
  inputText: "Hello world",
  model: "gpt-3.5-turbo"
});
console.log(tokenInfo);
// Output: { tokens: 2, cost: 0.000004 }

// For conversations
const tokenInfo = await LLMIO.calculateTokens({
  messages: [
    { role: 'system', content: 'You are a helpful assistant' },
    { role: 'user', content: 'Hello!' },
    { role: 'assistant', content: 'Hi there!' }
  ],
  model: "gpt-4"
});
```

---

### Media Support

#### `LLMIO.prompt()` với Images
Gửi prompt kèm images

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | `string` | ✅ | - | Text prompt |
| `options.model` | `string` | ✅ | - | Vision model (vd: gpt-4-vision-preview) |
| `options.images` | `ImageInput[]` | ✅ | - | Array of images |
| `options.images[].id` | `string` | ✅ | - | Image ID |
| `options.images[].url` | `string` | ✅ | - | Image URL |
| `options.images[].mime` | `string` | ✅ | - | MIME type |

##### Example
```javascript
const response = await LLMIO.prompt("Describe this image", {
  model: 'gpt-4-vision-preview',
  images: [{
    id: 'img1',
    url: 'https://example.com/image.jpg',
    mime: 'image/jpeg'
  }]
});
```

#### `LLMIO.prompt()` với Files
Gửi prompt kèm files

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | `string` | ✅ | - | Text prompt |
| `options.files` | `FileInput[]` | ✅ | - | Array of files |
| `options.files[].id` | `string` | ✅ | - | File ID |
| `options.files[].url` | `string` | ✅ | - | File URL |
| `options.files[].mime` | `string` | ✅ | - | MIME type |
| `options.files[].name` | `string` | ✅ | - | File name |

##### Example
```javascript
const response = await LLMIO.prompt("Analyze this document", {
  model: 'gpt-4',
  files: [{
    id: 'doc1',
    url: 'https://example.com/document.pdf',
    mime: 'application/pdf',
    name: 'report.pdf'
  }]
});
```

## 💡 Ví dụ thực tế

### Smart Chatbot với Memory
```javascript
import { LLMIO, RedisIO } from '@leanez/sdk';

async function smartChatbot(userId, message) {
  try {
    // Get or create conversation thread
    let threadId = await RedisIO.get(`thread:${userId}`);
    if (!threadId) {
      threadId = await LLMIO.newAssistantThread();
      await RedisIO.set(`thread:${userId}`, threadId, 3600 * 24); // 24h
    }
    
    // Chat with context
    const response = await LLMIO.promptAssistant(
      threadId,
      'gpt-4',
      message,
      { 
        temperature: 0.7,
        maxTokens: 500
      }
    );
    
    // Get conversation history
    const thread = await LLMIO.getAssistantThread(threadId);
    const lastMessage = thread.messages[thread.messages.length - 1];
    
    // Calculate cost
    const tokenInfo = await LLMIO.calculateTokens({
      inputText: message + response,
      model: 'gpt-4'
    });
    
    return {
      response,
      cost: tokenInfo.cost,
      tokens: tokenInfo.tokens
    };
  } catch (error) {
    return { error: error.message };
  }
}
```

### Cost Tracking System
```javascript
import { LLMIO, RedisIO } from '@leanez/sdk';

async function trackUsage(userId, prompt, response) {
  const inputTokens = await LLMIO.calculateTokens({
    inputText: prompt,
    model: 'gpt-4'
  });
  
  const outputTokens = await LLMIO.calculateTokens({
    inputText: response,
    model: 'gpt-4'
  });
  
  const totalCost = inputTokens.cost + outputTokens.cost;
  
  // Store usage data
  await RedisIO.set(`usage:${userId}:${Date.now()}`, {
    inputTokens: inputTokens.tokens,
    outputTokens: outputTokens.tokens,
    totalCost,
    timestamp: new Date().toISOString()
  });
  
  return { totalCost, totalTokens: inputTokens.tokens + outputTokens.tokens };
}
```

### Semantic Search với Embeddings
```javascript
import { LLMIO, MongoIO } from '@leanez/sdk';

// Cosine similarity function
function cosineSimilarity(a, b) {
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (magnitudeA * magnitudeB);
}

async function semanticSearch(query, documents) {
  // Generate embedding for search query
  const queryEmbedding = await LLMIO.getEmbedding(query);
  
  // Generate embeddings for all documents
  const docEmbeddings = await Promise.all(
    documents.map(doc => LLMIO.getEmbedding(doc.content))
  );
  
  // Calculate similarities
  const similarities = docEmbeddings.map((docEmb, index) => ({
    document: documents[index],
    similarity: cosineSimilarity(queryEmbedding, docEmb)
  }));
  
  // Sort by similarity (highest first)
  return similarities
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5); // Top 5 results
}
```

### AI Content Generator
```javascript
import { LLMIO } from '@leanez/sdk';

export default async function generateContent(type, params) {
  try {
    let prompt, options;
    
    switch (type) {
      case 'blog_post':
        prompt = `Write a blog post about "${params.topic}". 
                 Target audience: ${params.audience}. 
                 Tone: ${params.tone}. 
                 Length: ${params.length} words.`;
        options = {
          model: 'gpt-4',
          temperature: 0.8,
          maxTokens: 2000,
          lang: 'vi'
        };
        break;
        
      case 'social_media':
        prompt = `Create ${params.platform} post about "${params.topic}". 
                 Include relevant hashtags. Keep it engaging and ${params.style}.`;
        options = {
          model: 'gpt-3.5-turbo',
          temperature: 0.9,
          maxTokens: 300,
          emoji: true
        };
        break;
        
      case 'email':
        prompt = `Write a ${params.type} email with subject "${params.subject}". 
                 Recipient: ${params.recipient}. 
                 Purpose: ${params.purpose}.`;
        options = {
          model: 'gpt-4',
          temperature: 0.6,
          maxTokens: 1000
        };
        break;
        
      default:
        throw new Error('Invalid content type');
    }
    
    const content = await LLMIO.prompt(prompt, options);
    
    return {
      success: true,
      content,
      type,
      generatedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}
```

## 🔧 Configuration

### LLMIO Settings
```javascript
// Configure LLMIO settings
LLMIO.configure({
  serverChannel: 'custom_llm_channel',
  pluginId: 'my-plugin-id'
});
```

## 🎯 Best Practices

| Practice | Description | Example |
|----------|-------------|---------|
| **Error Handling** | Luôn wrap AI calls trong try-catch | `try { await LLMIO.prompt() } catch(e) {}` |
| **Cost Monitoring** | Track token usage và costs | Calculate tokens before/after requests |
| **Caching** | Cache responses để tiết kiệm costs | Set TTL cho repeated prompts |
| **Temperature Control** | Adjust temperature theo use case | 0.3 cho factual, 0.8 cho creative |
| **Model Selection** | Chọn model phù hợp với task | GPT-4 cho complex, GPT-3.5 cho simple |

### Error Handling Example
```javascript
try {
  const response = await LLMIO.prompt("Hello AI");
  console.log(response);
} catch (error) {
  if (error.message.includes('timeout')) {
    console.log('Request timed out, try again');
  } else if (error.message.includes('rate limit')) {
    console.log('Rate limit exceeded, wait a moment');
  } else {
    console.log('AI request failed:', error.message);
  }
}
```

## 🌍 Environment Variables

Các biến môi trường được tự động cấu hình:

| Variable | Description | Example |
|----------|-------------|---------|
| `OPENAI_API_KEY` | OpenAI API key | `sk-...` |
| `ANTHROPIC_API_KEY` | Anthropic API key | `sk-ant-...` |
| `LLM_DEFAULT_MODEL` | Default AI model | `gpt-3.5-turbo` |
| `LLM_DEFAULT_TEMPERATURE` | Default temperature | `0.7` | 