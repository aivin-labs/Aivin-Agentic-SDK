# 🤖 LLMIO - AI Operations Documentation

**LLMIO** cung cấp complete AI capabilities với focus mạnh vào structured outputs, embeddings, assistants, và advanced AI operations.

## 🚀 Core Features

| Feature | Description | Use Cases |
|---------|-------------|-----------|
| **Structured AI Chat** | AI responses với JSON schema validation | Data extraction, form generation, API responses |
| **Vector Embeddings** | High-dimensional vector representations | Semantic search, similarity matching, clustering |
| **AI Assistants** | Persistent conversations với memory | Customer support, tutoring, complex workflows |
| **Token Management** | Cost calculation và optimization | Budget control, usage analytics |
| **Multimodal Support** | Images, files, audio trong AI prompts | Vision analysis, document processing |

## 📖 Complete API Reference

### Core Chat Operations

#### `LLMIO.prompt(message, options?)`
**Primary method** cho tất cả AI interactions với full customization

##### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `message` | `string` | - | Prompt content gửi tới AI model |
| `model?` | `string` | `'gpt-3.5-turbo'` | AI model selection |
| `temperature?` | `number` | `0.7` | Creativity level (0.0-1.0) |
| `maxTokens?` | `number` | `1000` | Maximum response tokens |
| `ttl?` | `number` | `undefined` | Cache duration (seconds) |
| `lang?` | `string` | `'en'` | Response language code |
| `emoji?` | `boolean` | `false` | Include emojis in response |
| `style?` | `string` | `'normal'` | Response tone/style |
| `provider?` | `string` | `'openai'` | AI service provider |
| `seed?` | `number` | `undefined` | Reproducible output seed |
| `schema?` | `object` | `undefined` | **JSON Schema cho structured responses** |
| `images?` | `MediaItem[]` | `undefined` | Image files for vision models |
| `files?` | `MediaItem[]` | `undefined` | Document files (PDF, docs) |
| `audio?` | `MediaItem` | `undefined` | Audio input for speech models |
| `video?` | `MediaItem` | `undefined` | Video input for multimodal |
| `reference?` | `string` | `undefined` | Context reference string |
| `role?` | `string` | `undefined` | User role in conversation |
| `context?` | `any` | `undefined` | Additional context data |
| `instructions?` | `string` | `undefined` | System-level instructions |
| `threadId?` | `string` | `undefined` | Conversation thread ID |

##### Available Models

**Supported Providers:**
- **OpenAI** (`provider: 'openai'`) 🔗 [platform.openai.com](https://platform.openai.com)
- **Anthropic** (`provider: 'anthropic'`) 🔗 [console.anthropic.com](https://console.anthropic.com)
- **Google Gemini** (`provider: 'google'`) 🔗 [aistudio.google.com](https://aistudio.google.com)

**Provider Configuration:**
```javascript
// Default OpenAI
const response = await LLMIO.prompt("Hello", {
  model: "gpt-4o" // provider defaults to 'openai'
});

// Explicit provider specification
const response = await LLMIO.prompt("Hello", {
  model: "claude-3-5-sonnet-20241022",
  provider: "anthropic"
});

const response = await LLMIO.prompt("Hello", {
  model: "gemini-1.5-pro",
  provider: "gemini"
});
```

##### Language Codes
| Code | Language | Code | Language |
|------|----------|------|----------|
| `'vi'` | Tiếng Việt | `'en'` | English |
| `'ja'` | Japanese | `'ko'` | Korean |
| `'zh'` | Chinese | `'fr'` | French |
| `'de'` | German | `'es'` | Spanish |

##### Response Styles
| Style | Description | Use Case |
|-------|-------------|----------|
| `'normal'` | Balanced, informative | General purpose |
| `'casual'` | Friendly, conversational | Customer chat |
| `'formal'` | Professional, structured | Business docs |
| `'technical'` | Detailed, precise | Documentation |
| `'creative'` | Imaginative, expressive | Content creation |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<string>` | AI response (text or JSON string if schema used) |

##### Schema Structure Guide

**Schema là object tự do với format:**
```javascript
schema: {
  field_name: "type - description, default_value"
}
```

**Supported Data Types:**
- `string` - Text data
- `number` - Numeric values  
- `boolean` - True/false values
- `array` - Lists of items
- `object` - Nested structures

**Schema Examples:**

**1. Simple Data Extraction:**
```javascript
schema: {
  name: "string - Person's full name",
  age: "number - Age in years, 0",
  email: "string - Email address",
  active: "boolean - Account status, true",
  status: "string - Current status, active"
}
```

**2. Array Structures:**
```javascript
schema: {
  products: [{
    name: "string - Product name",
    price: "number - Price in USD, 0",
    category: "string - Product category, general",
    inStock: "boolean - Availability, true"
  }],
  total: "number - Total value, 0",
  currency: "string - Currency code, USD"
}
```

**3. Nested Objects:**
```javascript
schema: {
  user: {
    personal: {
      name: "string - Full name",
      age: "number - Age in years, 0",
      gender: "string - Gender, unknown"
    },
    contact: {
      email: "string - Email address",
      phone: "string - Phone number, N/A",
      verified: "boolean - Email verified, false"
    }
  },
  preferences: {
    notifications: "boolean - Email notifications enabled, true",
    theme: "string - UI theme preference, light",
    language: "string - Preferred language, en"
  }
}
```

**4. Complex Analysis Schema:**
```javascript
schema: {
  analysis: {
    summary: "string - Executive summary",
    confidence: "number - Analysis confidence 0-100, 50",
    risk_assessment: {
      level: "string - Risk level (low/medium/high), medium",
      score: "number - Risk score 1-10, 5",
      factors: ["string - List of risk factors"]
    },
    recommendations: [{
      action: "string - Recommended action",
      priority: "number - Priority score 1-10, 5",
      timeline: "string - Implementation timeframe, 1 month",
      cost: "number - Estimated cost, 0"
    }]
  },
  financial_data: {
    current_metrics: {
      revenue: "number - Annual revenue, 0",
      profit_margin: "number - Profit margin percentage, 0",
      growth_rate: "number - Growth rate percentage, 0"
    },
    projections: [{
      year: "number - Projection year",
      revenue: "number - Projected revenue, 0",
      growth_rate: "number - Growth rate percentage, 0",
      confidence: "number - Projection confidence 0-100, 50"
    }]
  }
}
```

##### Usage Examples

**Basic Prompt:**
```javascript
const response = await LLMIO.prompt("Explain quantum computing");
```

**Structured Data Extraction:**
```javascript
const userData = await LLMIO.prompt("John Doe, 30 years old, john@example.com", {
  model: "gpt-4o",
  schema: {
    name: "string - Full name",
    age: "number - Age in years, 0",
    email: "string - Email address",
    verified: "boolean - Email verified, false"
  }
});
// Returns: {"name": "John Doe", "age": 30, "email": "john@example.com", "verified": false}
```

**Advanced Configuration:**
```javascript
const analysis = await LLMIO.prompt("Analyze market trends", {
  model: "claude-3-5-sonnet-20241022",
  temperature: 0.3,
  maxTokens: 2000,
  lang: "vi",
  provider: "anthropic",
  schema: {
    trends: [{
      sector: "string - Market sector",
      direction: "string - Trend direction (up/down/stable), stable",
      confidence: "number - Confidence level 0-100, 50"
    }],
    summary: "string - Overall market summary",
    last_updated: "string - Analysis date, today"
  }
});
```

---

### Vector Embeddings

#### `LLMIO.getEmbedding(text, options?)`
Generate high-dimensional vector representations cho semantic operations

##### Input Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `text` | `string` | - | Text content to embed |
| `model?` | `string` | `'text-embedding-ada-002'` | Embedding model |
| `provider?` | `string` | `'openai'` | Service provider |

##### Available Embedding Models

**Supported Providers:**
- **OpenAI** (`provider: 'openai'`) 🔗 [platform.openai.com](https://platform.openai.com)
- **Google Gemini** (`provider: 'gemini'`) 🔗 [aistudio.google.com](https://aistudio.google.com)
- **Cohere** (`provider: 'cohere'`) 🔗 [dashboard.cohere.com](https://dashboard.cohere.com)

**Embedding Usage Examples:**
```javascript
// Default OpenAI
const embedding = await LLMIO.getEmbedding("Hello world", {
  model: "text-embedding-3-large" // provider defaults to 'openai'
});

// Explicit provider
const embedding = await LLMIO.getEmbedding("Hello world", {
  model: "text-embedding-004",
  provider: "google"
});

const embedding = await LLMIO.getEmbedding("Hello world", {
  model: "embed-english-v3.0",
  provider: "cohere"
});
```

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<number[]>` | Vector array (dimensionality varies by model) |

##### Semantic Search Implementation
```javascript
// Generate query embedding
const queryEmbedding = await LLMIO.getEmbedding("search term", {
  model: "text-embedding-3-large"
});

// Generate document embeddings
const docEmbeddings = await Promise.all([
  LLMIO.getEmbedding("Document 1 content"),
  LLMIO.getEmbedding("Document 2 content"),
  LLMIO.getEmbedding("Document 3 content")
]);

// Calculate cosine similarity for ranking
function cosineSimilarity(a, b) {
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (magA * magB);
}
```
