# 🔍 ContextIO - Context Manager

**ContextIO** là một context manager đơn giản giúp plugins lấy thông tin context từ LeanEZ thông qua PubSub.

## 🚀 Tính năng chính

| Tính năng | Mô tả |
|-----------|-------|
| **Lấy thông tin người dùng** | Truy cập thông tin user hiện tại |
| **Thông tin workspace** | Lấy dữ liệu workspace đang hoạt động |
| **Session management** | Quản lý session và trạng thái |
| **Agent context** | Truy cập thông tin các agents |
| **File shares** | Lấy thông tin file được chia sẻ |
| **Project data** | Truy cập dữ liệu projects |

## 📖 API Reference

### `ContextIO.getCurrentUser()`
Lấy thông tin người dùng hiện tại

#### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| *Không có parameters* | - | - | - | - |

#### Return Value
| Type | Description |
|------|-------------|
| `Promise<User>` | Thông tin user hiện tại |

#### Example
```javascript
import { ContextIO } from '@leanez/sdk';

const user = await ContextIO.getCurrentUser();
console.log(user);
// Output: { id: 'user123', name: 'John Doe', email: 'john@example.com' }
```

---

### `ContextIO.getCurrentWorkspace()`
Lấy thông tin workspace hiện tại

#### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| *Không có parameters* | - | - | - | - |

#### Return Value
| Type | Description |
|------|-------------|
| `Promise<Workspace>` | Thông tin workspace hiện tại |

#### Example
```javascript
const workspace = await ContextIO.getCurrentWorkspace();
console.log(workspace);
// Output: { id: 'ws123', name: 'My Workspace', settings: {...} }
```

---

### `ContextIO.getCurrentSession()`
Lấy thông tin session hiện tại

#### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| *Không có parameters* | - | - | - | - |

#### Return Value
| Type | Description |
|------|-------------|
| `Promise<Session>` | Thông tin session hiện tại |

#### Example
```javascript
const session = await ContextIO.getCurrentSession();
console.log(session);
// Output: { id: 'session123', startTime: '2024-01-01T00:00:00Z', active: true }
```

---

### `ContextIO.getAgents()`
Lấy danh sách agents

#### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| *Không có parameters* | - | - | - | - |

#### Return Value
| Type | Description |
|------|-------------|
| `Promise<Agent[]>` | Danh sách các agents |

#### Example
```javascript
const agents = await ContextIO.getAgents();
console.log(agents);
// Output: [{ id: 'agent1', name: 'Assistant', type: 'chat' }]
```

---

### `ContextIO.getFileShares()`
Lấy danh sách file shares

#### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| *Không có parameters* | - | - | - | - |

#### Return Value
| Type | Description |
|------|-------------|
| `Promise<FileShare[]>` | Danh sách file shares |

#### Example
```javascript
const fileShares = await ContextIO.getFileShares();
console.log(fileShares);
// Output: [{ id: 'share1', fileName: 'document.pdf', permissions: 'read' }]
```

---

### `ContextIO.getProjects()`
Lấy danh sách projects

#### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| *Không có parameters* | - | - | - | - |

#### Return Value
| Type | Description |
|------|-------------|
| `Promise<Project[]>` | Danh sách projects |

#### Example
```javascript
const projects = await ContextIO.getProjects();
console.log(projects);
// Output: [{ id: 'proj1', name: 'My Project', status: 'active' }]
```

## 💡 Ví dụ thực tế

### Lấy toàn bộ context cho plugin
```javascript
import { ContextIO } from '@leanez/sdk';

async function getFullContext() {
  try {
    // Lấy tất cả thông tin context
    const [user, workspace, session, agents, fileShares, projects] = await Promise.all([
      ContextIO.getCurrentUser(),
      ContextIO.getCurrentWorkspace(),
      ContextIO.getCurrentSession(),
      ContextIO.getAgents(),
      ContextIO.getFileShares(),
      ContextIO.getProjects()
    ]);

    return {
      user,
      workspace,
      session,
      agents,
      fileShares,
      projects
    };
  } catch (error) {
    console.error('Lỗi khi lấy context:', error);
    throw error;
  }
}
```

### Plugin function với context
```javascript
import { ContextIO } from '@leanez/sdk';

export default async function myPlugin() {
  // Lấy context cần thiết
  const user = await ContextIO.getCurrentUser();
  const workspace = await ContextIO.getCurrentWorkspace();
  const projects = await ContextIO.getProjects();

  // Xử lý logic với context
  const result = {
    message: `Xin chào ${user.name}!`,
    workspace: workspace.name,
    projectCount: projects.length,
    availableProjects: projects.map(p => p.name)
  };

  return result;
}
```

## 🔧 TypeScript Support

```typescript
import { ContextIO, User, Project } from '@leanez/sdk';

// Typed context retrieval
const user: User = await ContextIO.getCurrentUser();
const projects: Project[] = await ContextIO.getProjects();

// Type-safe usage
console.log(user.name); // TypeScript knows this is a string
console.log(projects[0].id); // TypeScript knows this exists
```

## 🎯 Best Practices

| Practice | Description |
|----------|-------------|
| **Error Handling** | Luôn wrap các calls trong try-catch |
| **Caching** | Cache context data khi có thể để tránh gọi lại |
| **Parallel Calls** | Sử dụng Promise.all() cho multiple context calls |
| **Type Safety** | Sử dụng TypeScript types cho better development experience | 