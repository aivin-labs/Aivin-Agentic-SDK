# 🏗️ SDK Architecture

## Cấu trúc thư mục mới

```
sdk/src/
├── dto/                    # Data Transfer Objects
│   ├── ContextDTO.ts      # Context interfaces
│   └── index.ts           # Export all DTOs
├── services/              # Business logic services
│   ├── ContextService.ts  # Context management
│   ├── PubSubService.ts   # Real-time communication
│   ├── RedisService.ts    # Caching & storage
│   ├── MongoService.ts    # Database operations
│   ├── BullService.ts     # Background jobs
│   ├── LLMService.ts      # AI/LLM operations
│   └── index.ts           # Export all services
├── types/                 # TypeScript type definitions
├── *.ts                   # Backward compatibility wrappers
└── index.ts               # Main entry point
```

## Nguyên tắc thiết kế

### 1. **Separation of Concerns**
- **DTO**: Chỉ chứa interface/type definitions
- **Services**: Chứa business logic và implementation
- **Wrappers**: Backward compatibility cho existing code

### 2. **Clean Architecture**
- Services không phụ thuộc vào wrapper classes
- DTOs độc lập với implementation
- Clear separation between data và logic

### 3. **Backward Compatibility**
- Tất cả `*IO` classes vẫn hoạt động
- Existing plugins không cần thay đổi
- Gradual migration path

## Cách sử dụng

### Cách cũ (vẫn hoạt động)
```javascript
import { ContextIO, RedisIO, PubSubIO } from '@leanez/sdk';

const user = await ContextIO.getCurrentUser();
await RedisIO.set('key', 'value');
```

### Cách mới (recommended)
```javascript
import { ContextService, RedisService, PubSubService } from '@leanez/sdk';
import type { User } from '@leanez/sdk/dto';

const user: User = await ContextService.getCurrentUser();
await RedisService.set('key', 'value');
```

### Mixed approach
```javascript
import { ContextIO } from '@leanez/sdk';
import { RedisService } from '@leanez/sdk/services';
import type { User } from '@leanez/sdk/dto';

const user: User = await ContextIO.getCurrentUser();
await RedisService.set('key', 'value');
```

## Lợi ích

✅ **Code organization**: Tách biệt rõ ràng giữa data và logic  
✅ **Type safety**: DTOs cung cấp type definitions rõ ràng  
✅ **Maintainability**: Dễ maintain và extend  
✅ **Testing**: Dễ test từng service riêng biệt  
✅ **Reusability**: Services có thể reuse trong nhiều context  
✅ **Backward compatibility**: Không break existing code  

## Migration Guide

### Bước 1: Dùng types mới
```typescript
// Cũ
import { ContextIO, User } from '@leanez/sdk';

// Mới
import { ContextIO } from '@leanez/sdk';
import type { User } from '@leanez/sdk/dto';
```

### Bước 2: Migrate to services (optional)
```typescript
// Cũ
import { ContextIO } from '@leanez/sdk';

// Mới
import { ContextService } from '@leanez/sdk/services';
```

### Bước 3: Full migration
```typescript
import { ContextService, RedisService } from '@leanez/sdk/services';
import type { User, Project } from '@leanez/sdk/dto';
```

## Best Practices

1. **Sử dụng TypeScript types** từ DTO cho type safety
2. **Prefer services** cho new code
3. **Keep backward compatibility** cho existing plugins
4. **Import specific services** thay vì import all
5. **Use type imports** (`import type`) cho DTOs

Kiến trúc mới giúp SDK dễ maintain và extend hơn! 🚀 